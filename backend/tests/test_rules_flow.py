from datetime import UTC, date, datetime, timedelta

from app.bigquery import DryRunMeta, QueryError, RunStats
from app.schemas import Column, DailyPerformance
from tests.conftest import login

SQL = """SELECT
  o.order_id
FROM `sales.orders` o
WHERE o.order_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
  AND o.amount_eur > 500"""
RULE = {
    "name": "Panier élevé",
    "description": "Commandes au-dessus du seuil",
    "fraudTypology": "Fraude au moyen de paiement",
    "criticality": "HIGH",
    "schedule": "DAILY",
    "sqlQuery": SQL,
}


def test_parcours_complet_brouillon_test_soumission(client, bq):
    login(client)
    d = client.post("/drafts", json=RULE).json()
    did, rid = d["id"], d["ruleId"]
    assert d["newRule"] is True and d["baseVersion"] is None
    # Tant qu'elle n'est pas soumise, la règle n'est pas dans le référentiel partagé.
    assert client.get("/rules").json() == []
    assert client.get(f"/rules/{rid}").status_code == 404

    # Soumission refusée sans test.
    r = client.post(f"/drafts/{did}/submit")
    assert r.status_code == 409 and r.json()["code"] == "TEST_REQUIRED"

    dry = client.post("/query/dry-run", json={"sql": SQL, "draftId": did}).json()
    assert dry["ok"] is True, dry["issues"]
    ex = client.post("/query/execute", json={"sql": SQL, "draftId": did}).json()
    assert ex["ok"] is True and ex["totalRows"] == 5
    assert client.get(f"/drafts/{did}").json()["lastTest"]["phase"] == "EXECUTION"

    r = client.post(f"/drafts/{did}/submit")
    assert r.status_code == 200, r.text
    rule = r.json()
    assert (rule["ruleId"], rule["version"], rule["status"]) == (rid, 1, "SUBMITTED")
    assert rule["submittedByName"] == "Camille Martin"
    assert bq.registry == {rid: [(1, "SUBMITTED", False)]}  # le brouillon n'a jamais été publié
    assert client.get("/drafts").json() == []  # le brouillon est devenu la v1

    # Les tests du brouillon suivent la version ; les lignes ne sont jamais persistées.
    tests = rule["tests"]
    assert {t["phase"] for t in tests} == {"DRY_RUN", "EXECUTION"} and all(t["version"] == 1 for t in tests)
    assert all("rows" not in t for t in tests)

    # Soumise mais jamais exécutée par Airflow : son auteur peut la reprendre, elle redevient son brouillon.
    assert rule["canWithdraw"] is True
    d = client.post("/drafts", json={**RULE, "description": "v1 corrigée", "ruleId": rid}).json()
    assert (d["withdrawn"], d["ruleId"], d["newRule"]) == (True, rid, True)
    # Elle sort de rules_registry (Airflow ne peut plus la prendre) et du référentiel.
    assert rid not in bq.registry
    assert client.get(f"/rules/{rid}").status_code == 404
    # Ses tests l'ont suivie : description seule modifiée, la requête testée est toujours valable.
    assert client.post(f"/drafts/{d['id']}/submit").json()["version"] == 1

    actions = [e["action"] for e in client.get("/audit", params={"ruleId": rid}).json()]
    assert actions.count("RULE_SUBMIT") == 2 and "RULE_WITHDRAW" in actions


def test_brouillon_invisible_des_collegues(client):
    login(client)
    did = client.post("/drafts", json=RULE).json()["id"]
    client.post("/query/execute", json={"sql": SQL, "draftId": did})
    login(client, "200001", "Sacha", "Bernard")
    assert client.get("/drafts").json() == []
    assert client.get(f"/drafts/{did}").status_code == 404
    assert client.put(f"/drafts/{did}", json=RULE).status_code == 404
    assert client.post(f"/drafts/{did}/submit").status_code == 404
    assert client.post("/query/execute", json={"sql": SQL, "draftId": did}).status_code == 404
    # Le journal garde la trace du test (volume scanné) sans rien dire du brouillon.
    ev = [e for e in client.get("/audit").json() if e["action"] == "RULE_TEST"]
    assert ev and all(e["ruleId"] is None and e["ruleName"] is None for e in ev)


def test_nouvelle_version_en_brouillon_ne_change_pas_la_regle_pour_les_autres(client, bq):
    login(client)
    rid = _submit(client)
    now = datetime.now(UTC)
    bq.stats = [RunStats(rid, 1, now, now, "fraud_rule_v1")]
    client.post("/internal/sync-runs")
    d = client.post("/drafts", json={**RULE, "description": "seuil revu", "ruleId": rid}).json()
    assert (d["baseVersion"], d["withdrawn"], d["latestVersion"]) == (1, False, 1)
    assert client.get(f"/rules/{rid}").json()["myDraftId"] == d["id"]
    # Un seul brouillon par règle et par personne.
    r = client.post("/drafts", json={**RULE, "ruleId": rid})
    assert r.status_code == 409 and r.json()["code"] == "DRAFT_EXISTS"

    login(client, "200001", "Sacha", "Bernard")
    rule = client.get(f"/rules/{rid}").json()
    assert (rule["versionCount"], rule["description"], rule["myDraftId"]) == (1, RULE["description"], None)
    assert rule["canWithdraw"] is False
    # Un collègue peut préparer sa propre version en parallèle ; la première soumise prend la v2.
    other = client.post("/drafts", json={**RULE, "description": "autre piste", "ruleId": rid}).json()
    client.post("/query/execute", json={"sql": SQL, "draftId": other["id"]})
    assert client.post(f"/drafts/{other['id']}/submit").json()["version"] == 2

    login(client)
    d = client.get(f"/drafts/{d['id']}").json()
    assert (d["baseVersion"], d["latestVersion"]) == (1, 2)  # l'éditeur signale le décalage


def test_suppression_d_un_brouillon(client):
    login(client)
    did = client.post("/drafts", json=RULE).json()["id"]
    assert client.delete(f"/drafts/{did}").status_code == 204
    assert client.get("/drafts").json() == []


def test_test_sur_ancienne_requete_ne_permet_pas_la_soumission(client):
    login(client)
    did = client.post("/drafts", json=RULE).json()["id"]
    client.post("/query/execute", json={"sql": SQL, "draftId": did})
    client.put(f"/drafts/{did}", json={**RULE, "sqlQuery": SQL + "\n  AND o.item_count > 1"})
    assert client.post(f"/drafts/{did}/submit").status_code == 409


def test_tests_avant_premier_enregistrement_sont_rattaches(client):
    login(client)
    client.post("/query/execute", json={"sql": SQL})
    did = client.post("/drafts", json=RULE).json()["id"]
    assert client.post(f"/drafts/{did}/submit").status_code == 200


def test_nom_unique_insensible_casse_et_accents(client):
    login(client)
    _submit(client)
    r = client.post("/drafts", json={**RULE, "name": "PANIER ELEVE"})
    assert r.status_code == 409 and r.json()["code"] == "NAME_TAKEN"
    assert client.get("/rules/name-available", params={"name": "panier élevé"}).json() == {"available": False}


def test_dml_refuse_a_l_enregistrement(client, bq):
    login(client)
    bq.next_dry_run = DryRunMeta("DELETE", 0, [])
    r = client.post("/drafts", json={**RULE, "sqlQuery": "DELETE FROM `sales.orders` WHERE true"})
    assert r.status_code == 422 and r.json()["code"] == "NOT_SELECT"


def test_dry_run_controles(client, bq):
    login(client)
    bq.next_dry_run = DryRunMeta("SELECT", 10**9, [Column(name="customer_id", type="STRING")])
    sql = "SELECT customer_id FROM t WHERE d = DATE '2026-01-01' AND x = @inconnu"
    dry = client.post("/query/dry-run", json={"sql": sql}).json()
    issues = {i["code"]: i["severity"] for i in dry["issues"]}
    assert issues["NO_ORDER_ID"] == issues["PARAM_NOT_ALLOWED"] == "error"
    # Une date en dur n'empêche pas de tester.
    assert issues["HARDCODED_DATE"] == "warning"
    # Pas de fenêtre de dates : alerte sur le pic du premier run, sans bloquer.
    assert issues["NO_DATE_WINDOW"] == "warning"

    def codes(sql: str) -> list[str]:
        return [i["code"] for i in client.post("/query/dry-run", json={"sql": sql}).json()["issues"]]

    # CURRENT_DATE() est libre et compte comme une fenêtre de dates, comme @period_start / @period_end.
    assert codes("SELECT order_id FROM t WHERE d >= current_date() -- x") == []
    assert codes("SELECT order_id FROM t -- CURRENT_DATE()") == ["NO_DATE_WINDOW"]
    assert codes("SELECT order_id FROM t WHERE d >= DATE(@period_end, 'Europe/Paris')") == []
    assert codes("SELECT order_id, `current_date` FROM t") == ["NO_DATE_WINDOW"]  # une colonne


def test_periode_testee_selon_la_frequence(client, bq):
    login(client)
    for schedule, step in (("HOURLY", timedelta(hours=1)), ("DAILY", timedelta(days=1))):
        dry = client.post("/query/dry-run", json={"sql": SQL, "schedule": schedule}).json()
        start, end = (datetime.fromisoformat(dry["period"][k]) for k in ("start", "end"))
        assert end - start == step and end <= datetime.now(UTC)
        assert (bq.last_period.start, bq.last_period.end) == (start, end)  # passée à BigQuery


def test_date_en_dur_soumissible(client):
    login(client)
    # Seuil de date fixe : légitime, la requête se teste et se soumet.
    _submit(client, {**RULE, "sqlQuery": SQL + "\n  AND o.created_at >= TIMESTAMP '2024-01-01'"})


def test_erreur_bigquery_avec_position(client, bq):
    login(client)
    bq.next_error = QueryError("Not found: Table p.sales.nope was not found at [3:6]")
    issue = client.post("/query/dry-run", json={"sql": SQL}).json()["issues"][0]
    assert (issue["code"], issue["line"], issue["column"]) == ("BIGQUERY", 3, 6)


def test_plafond_de_volume(client, bq):
    login(client)
    bq.bytes_processed = 60 * 10**9
    dry = client.post("/query/dry-run", json={"sql": SQL}).json()
    assert dry["exceedsBytesLimit"] is True
    r = client.post("/query/execute", json={"sql": SQL})
    assert r.status_code == 422 and r.json()["code"] == "BYTES_LIMIT"


def test_filtres_et_recherche(client):
    login(client)
    _submit(client)
    _submit(client, {**RULE, "name": "Autre", "criticality": "LOW", "sqlQuery": SQL + " -- relais"})
    assert len(client.get("/rules").json()) == 2
    assert [r["name"] for r in client.get("/rules", params={"criticality": "LOW"}).json()] == ["Autre"]
    assert [r["name"] for r in client.get("/rules", params={"q": "RELAIS"}).json()] == ["Autre"]
    assert client.get("/rules", params={"status": "IN_PRODUCTION"}).json() == []


def _submit(client, rule=RULE, rule_id=None):
    did = client.post("/drafts", json={**rule, "ruleId": rule_id}).json()["id"]
    client.post("/query/execute", json={"sql": rule["sqlQuery"], "draftId": did})
    r = client.post(f"/drafts/{did}/submit")
    assert r.status_code == 200, r.text
    return r.json()["ruleId"]


def test_statuts_deduits_des_runs_airflow(client, bq):
    login(client)
    rid = _submit(client)
    status = lambda: client.get(f"/rules/{rid}").json()["status"]  # noqa: E731
    assert status() == "SUBMITTED"

    # Airflow exécute la v1 : la plateforme la constate en observation (rien n'est envoyé au prestataire).
    now = datetime.now(UTC)
    bq.stats = [RunStats(rid, 1, now - timedelta(days=10), now - timedelta(hours=2), "fraud_rule_v1")]
    assert client.post("/internal/sync-runs").json() == {"rulesUpdated": 1}
    detail = client.get(f"/rules/{rid}").json()
    assert detail["status"] == "OBSERVATION" and detail["airflowDagId"] == "fraud_rule_v1"
    assert bq.registry == {rid: [(1, "OBSERVATION", False)]}
    assert [r["ruleId"] for r in client.get("/performance/production").json()] == [rid]

    # L'analyste décide de l'envoyer au prestataire : rules_registry le dit au DAG.
    d = client.post(f"/rules/{rid}/decision", json={"action": "send"}).json()
    assert (d["status"], d["decision"], d["decidedByName"]) == ("IN_PRODUCTION", "SENT", "Camille Martin")
    assert bq.registry == {rid: [(1, "IN_PRODUCTION", True)]}

    # Plus de run depuis 4 jours pour une règle quotidienne : inactive.
    bq.stats = [RunStats(rid, 1, now - timedelta(days=10), now - timedelta(days=4), "fraud_rule_v1")]
    client.post("/internal/sync-runs")
    assert status() == "INACTIVE"
    # Rien de nouveau dans rule_runs : rien à republier.
    assert client.post("/internal/sync-runs").json() == {"rulesUpdated": 0}
    assert client.get("/performance/production").json()[0]["status"] == "INACTIVE"

    # Une v2 est publiée : la v1, en production, continue de tourner et d'être envoyée ; la v2 tourne à
    # côté comme candidate, sans envoi.
    _submit(client, {**RULE, "sqlQuery": SQL + "\n  AND o.item_count > 1"}, rid)
    d = client.get(f"/rules/{rid}").json()
    assert (d["status"], d["productionVersion"], d["candidate"]) == ("SUBMITTED", 1, True)
    assert bq.registry == {rid: [(1, "INACTIVE", True), (2, "SUBMITTED", False)]}

    # La v2 démarre : en observation, en parallèle de la v1 toujours en production.
    bq.stats = [
        RunStats(rid, 1, now - timedelta(days=10), now, "fraud_rule_v1"),
        RunStats(rid, 2, now, now, "d"),
    ]
    client.post("/internal/sync-runs")
    d = client.get(f"/rules/{rid}").json()
    assert [v["status"] for v in d["versions"]] == ["OBSERVATION", "IN_PRODUCTION"]
    assert bq.registry == {rid: [(1, "IN_PRODUCTION", True), (2, "OBSERVATION", False)]}
    # Les totaux de la règle restent ceux de la version en production.
    assert client.get("/performance/production").json()[0]["version"] == 1

    # Mise en production de la v2, en un geste : elle prend la place de la v1, qui s'arrête.
    d = client.post(f"/rules/{rid}/decision", json={"action": "send"}).json()
    assert [(v["status"], v["decision"]) for v in d["versions"]] == [
        ("IN_PRODUCTION", "SENT"),
        ("REPLACED", None),
    ]
    assert bq.registry == {rid: [(2, "IN_PRODUCTION", True)]}


def test_ecarter_une_v2_en_observation_remet_la_v1_envoyee(client, bq):
    login(client)
    rid = _submit(client)
    now = datetime.now(UTC)
    bq.stats = [RunStats(rid, 1, now, now, "fraud_rule_v1")]
    client.post("/internal/sync-runs")
    client.post(f"/rules/{rid}/decision", json={"action": "send"})
    _submit(client, {**RULE, "description": "v2"}, rid)
    bq.stats.append(RunStats(rid, 2, now, now, "fraud_rule_v2"))
    client.post("/internal/sync-runs")
    # Envoyer exige une version en observation ; on ne peut pas écarter une version envoyée.
    d = client.post(f"/rules/{rid}/decision", json={"action": "discard"}).json()
    assert [v["status"] for v in d["versions"]][0] == "DISCARDED"
    # La v1 n'a jamais cessé de tourner : elle reste seule, toujours envoyée au prestataire.
    assert bq.registry == {rid: [(1, "IN_PRODUCTION", True)]}
    r = client.post(f"/rules/{rid}/decision", json={"action": "send"})
    assert r.status_code == 409 and r.json()["code"] == "BAD_STATUS"
    actions = [e["action"] for e in client.get("/audit", params={"ruleId": rid}).json()]
    assert {"RULE_SEND_TO_PROVIDER", "RULE_DISCARD"} <= set(actions)


def test_suspendre_l_envoi(client, bq):
    login(client)
    rid = _submit(client)
    now = datetime.now(UTC)
    bq.stats = [RunStats(rid, 1, now, now, "fraud_rule_v1")]
    client.post("/internal/sync-runs")
    # Une version qui n'a pas tourné ne peut pas être envoyée.
    client.post(f"/rules/{rid}/decision", json={"action": "send"})
    d = client.post(f"/rules/{rid}/decision", json={"action": "suspend"}).json()
    assert d["status"] == "OBSERVATION" and bq.registry[rid] == [(1, "OBSERVATION", False)]


def test_version_qui_a_tourne_reste_figee(client, bq):
    login(client)
    rid = _submit(client)
    now = datetime.now(UTC)
    bq.stats = [RunStats(rid, 1, now, now, "fraud_rule_v1")]
    client.post("/internal/sync-runs")
    assert client.get(f"/rules/{rid}").json()["canWithdraw"] is False
    d = client.post("/drafts", json={**RULE, "description": "seuil revu", "ruleId": rid}).json()
    assert (d["withdrawn"], d["baseVersion"]) == (False, 1)
    assert client.get(f"/rules/{rid}").json()["status"] == "OBSERVATION"


def test_performance_par_version(client, bq):
    login(client)
    rid = _submit(client)
    day = date.today() - timedelta(days=3)
    bq.performance[rid] = [
        DailyPerformance(
            date=day, rule_version=1, orders_flagged=40, orders_processed=30, orders_confirmed_fraud=6
        ),
        DailyPerformance(
            date=day + timedelta(days=1),
            rule_version=2,
            orders_flagged=10,
            orders_processed=10,
            orders_confirmed_fraud=5,
        ),
    ]
    # La v2 a relu 6 commandes déjà remontées par la v1 (fenêtre glissante) : comptées dans sa propre
    # mesure, mais une seule fois dans les chiffres de la règle (v_rule_orders_daily).
    bq.rule_daily[rid] = [
        bq.performance[rid][0],
        DailyPerformance(
            date=day + timedelta(days=1),
            rule_version=2,
            orders_flagged=4,
            orders_processed=4,
            orders_confirmed_fraud=2,
        ),
    ]
    r = client.get(f"/rules/{rid}/performance", params={"from": str(day), "to": str(date.today())}).json()
    assert [(d["ruleVersion"], d["ordersFlagged"]) for d in r["daily"]] == [(1, 40), (2, 4)]
    # Courbe par version : chaque version sur ses jours, avec son état (production ou observation).
    assert [(d["ruleVersion"], d["toSend"]) for d in r["byVersion"]] == [(1, False), (2, False)]
    assert [(v["version"], v["ordersFlagged"], v["ordersConfirmedFraud"]) for v in r["versions"]] == [
        (1, 40, 6),
        (2, 10, 5),
    ]


def test_reprise_d_une_v2_remet_la_v1_dans_rules_registry(client, bq):
    login(client)
    rid = _submit(client)
    now = datetime.now(UTC)
    bq.stats = [RunStats(rid, 1, now, now, "fraud_rule_v1")]
    client.post("/internal/sync-runs")
    _submit(client, {**RULE, "description": "v2"}, rid)
    # La v1 n'est pas en production : la v2 la remplace (rien n'est envoyé de toute façon).
    assert bq.registry == {rid: [(2, "SUBMITTED", False)]}
    # La v2 n'a jamais tourné : son auteur la reprend, la ligne revient à la v1 qui tourne toujours.
    client.post("/drafts", json={**RULE, "description": "v2 corrigée", "ruleId": rid})
    assert bq.registry == {rid: [(1, "OBSERVATION", False)]}


def test_execution_compte_les_commandes_deja_remontees_par_une_autre_regle(client, bq):
    login(client)
    autre = _submit(client, {**RULE, "name": "Autre règle"})
    mienne = _submit(client)
    bq.overlap = [(autre, 2), (mienne, 3), ("hors-plateforme", 1)]
    # Nouvelle version de « mienne » : ses propres remontées ne comptent pas comme déjà vues ailleurs.
    did = client.post("/drafts", json={**RULE, "description": "v2", "ruleId": mienne}).json()["id"]
    ex = client.post("/query/execute", json={"sql": SQL, "draftId": did}).json()
    assert (ex["ordersFlagged"], ex["ordersAlreadyFlagged"], ex["overlapDays"]) == (5, 3, 90)


def test_apercu_contient_toutes_les_colonnes_de_la_requete(client):
    login(client)
    sql = "SELECT o.order_id, o.amount_eur, c.created_at AS compte_cree_le FROM `sales.orders` o JOIN c"
    ex = client.post("/query/execute", json={"sql": sql}).json()
    assert ex["columns"] == ["order_id", "amount_eur", "compte_cree_le"]
    assert set(ex["rows"][0]) == {"order_id", "amount_eur", "compte_cree_le"}


def test_candidate_mise_en_production_seulement_apres_un_run(client, bq):
    login(client)
    rid = _submit(client)
    now = datetime.now(UTC)
    bq.stats = [RunStats(rid, 1, now, now, "d")]
    client.post("/internal/sync-runs")
    client.post(f"/rules/{rid}/decision", json={"action": "send"})
    _submit(client, {**RULE, "description": "v2"}, rid)
    # La candidate n'a pas encore tourné : pas de mise en production à l'aveugle.
    r = client.post(f"/rules/{rid}/decision", json={"action": "send"})
    assert r.status_code == 409 and r.json()["code"] == "BAD_STATUS"
    # Suspendre vise la version en production, pas la candidate : la v1 passe en observation et la
    # v2, n'ayant plus de version en production à côté, tourne seule à sa place.
    d = client.post(f"/rules/{rid}/decision", json={"action": "suspend"}).json()
    assert [v["decision"] for v in d["versions"]] == [None, None]
    assert bq.registry == {rid: [(2, "SUBMITTED", False)]}


def test_historique_des_executions(client, bq):
    from app.schemas import RuleRun

    login(client)
    rid = _submit(client)
    now = datetime.now(UTC)
    bq.run_history = [
        (
            rid,
            RuleRun(
                run_id="a",
                rule_version=1,
                run_date=date.today(),
                started_at=now,
                status="SUCCESS",
                rows_returned=12,
                rows_to_send=0,
                attempts=2,
            ),
        ),
        (
            rid,
            RuleRun(
                run_id="b",
                rule_version=1,
                run_date=date.today() - timedelta(days=1),
                started_at=now - timedelta(days=1),
                status="FAILED",
                error_message="quota",
            ),
        ),
        (
            "autre",
            RuleRun(run_id="c", rule_version=1, run_date=date.today(), started_at=now, status="SUCCESS"),
        ),
    ]
    runs = client.get(f"/rules/{rid}/runs").json()
    assert [(r["runId"], r["status"], r["attempts"]) for r in runs] == [
        ("a", "SUCCESS", 2),
        ("b", "FAILED", 1),
    ]
    assert client.get("/rules/inconnue/runs").status_code == 404
