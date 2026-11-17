from datetime import UTC, date, datetime, timedelta

from app.bigquery import AlertRow
from tests.conftest import login
from tests.test_rules_flow import RULE, _submit

TODAY = datetime.now(UTC).date()


def _alert(rule_id: str, order: str, to_send: bool, days_ago: int = 1, provider: bool | None = None):
    d = TODAY - timedelta(days=days_ago)
    at = datetime(d.year, d.month, d.day, 4, tzinfo=UTC)
    row = AlertRow(order, rule_id, 1, d, at, to_send, "", provider)
    return row, provider is not None


def review(client, order, rule_id, verdict):
    body = {"orderId": order, "ruleId": rule_id, "ruleVersion": 1, "verdict": verdict}
    return client.post("/alerts/review", json=body)


def test_alertes_et_qualification(client, bq):
    login(client)
    rid = _submit(client, RULE)
    bq.alert_rows = [
        _alert(rid, "ORD-1", to_send=False),  # en test, à qualifier
        _alert(rid, "ORD-2", to_send=True),  # transmise, en attente du prestataire
        _alert(rid, "ORD-3", to_send=True, provider=True),  # transmise, fraude confirmée
        _alert(rid, "ORD-OLD", to_send=False, days_ago=40),  # hors période par défaut (7 jours)
    ]
    page = client.get("/alerts", params={"ruleId": rid}).json()
    assert page["total"] == 3 and page["toReview"] == 1
    by = {a["orderId"]: a for a in page["items"]}
    assert (by["ORD-1"]["phase"], by["ORD-1"]["verdict"]) == ("TEST", "TO_REVIEW")
    assert by["ORD-2"]["verdict"] == "PENDING"
    assert (by["ORD-3"]["verdict"], by["ORD-3"]["providerIsFraud"]) == ("FRAUD", True)
    assert by["ORD-1"]["ruleName"] == "Panier élevé"

    # L'analyste qualifie une commande en test ; la qualification porte sur la commande.
    r = review(client, "ORD-1", rid, "FRAUD")
    assert r.status_code == 204, r.text
    items = client.get("/alerts", params={"ruleId": rid}).json()["items"]
    a = next(x for x in items if x["orderId"] == "ORD-1")
    assert a["verdict"] == "FRAUD" and a["review"]["byName"] == "Camille Martin"
    assert client.get("/alerts", params={"verdict": "TO_REVIEW"}).json()["total"] == 0

    # Trois niveaux : fraude avérée, commande risquée, RAS.
    review(client, "ORD-1", rid, "RISKY")
    assert client.get("/alerts", params={"phase": "TEST"}).json()["items"][0]["verdict"] == "RISKY"
    assert review(client, "ORD-1", rid, "MAYBE").status_code == 422

    # Qualification retirée : de nouveau à qualifier.
    review(client, "ORD-1", rid, None)
    assert client.get("/alerts", params={"phase": "TEST"}).json()["items"][0]["verdict"] == "TO_REVIEW"

    # Une commande transmise est vérifiée par le prestataire : pas de qualification.
    r = review(client, "ORD-2", rid, "NOT_FRAUD")
    assert r.status_code == 409 and r.json()["code"] == "NOT_IN_TEST"
    r = review(client, "ORD-1", "inconnue", "FRAUD")
    assert r.status_code == 404

    audit = [e for e in client.get("/audit").json() if e["action"] == "ALERT_REVIEW"]
    assert [e["details"] for e in audit][::-1] == [
        "Commande ORD-1 : fraude avérée",
        "Commande ORD-1 : commande risquée",
        "Commande ORD-1 : qualification retirée",
    ]

    # Filtres et période.
    assert client.get("/alerts", params={"phase": "PRODUCTION"}).json()["total"] == 2
    assert client.get("/alerts", params={"q": "ORD-3"}).json()["total"] == 1
    old = (TODAY - timedelta(days=45)).isoformat()
    assert client.get("/alerts", params={"from": old}).json()["total"] == 4
    assert client.get("/alerts", params={"from": "2020-01-01"}).status_code == 422
    assert len(client.get("/alerts", params={"limit": 2}).json()["items"]) == 2
    assert date.fromisoformat(page["items"][0]["runDate"]) <= TODAY


def test_filtres_guides_par_les_nombres(client, bq):
    # Les filtres ne proposent que des choix qui renvoient des alertes : les règles groupées par phase, puis
    # les verdicts de la règle et de la phase choisies.
    login(client)
    a = _submit(client, RULE)
    b = _submit(client, {**RULE, "name": "Autre règle"})
    bq.alert_rows = [
        _alert(a, "A-1", to_send=False),
        _alert(a, "A-2", to_send=False),
        _alert(a, "A-3", to_send=True),
        _alert(b, "B-1", to_send=True, provider=False),
    ]
    review(client, "A-2", a, "NOT_FRAUD")

    page = client.get("/alerts", params={"phase": "TEST"}).json()
    # Par règle et par phase, quelle que soit la phase choisie : les règles en test, puis en production.
    by_rule = [(c["phase"], c["ruleName"], c["count"]) for c in page["rules"]]
    assert by_rule[0] == ("TEST", "Panier élevé", 2)
    assert sorted(by_rule[1:]) == [("PRODUCTION", "Autre règle", 1), ("PRODUCTION", "Panier élevé", 1)]
    assert {c["verdict"]: c["count"] for c in page["verdicts"]} == {"TO_REVIEW": 1, "NOT_FRAUD": 1}
    assert page["toReview"] == 1

    page = client.get("/alerts", params={"phase": "PRODUCTION", "ruleId": b}).json()
    assert len(page["rules"]) == 3  # le choix de la règle ne réduit pas la liste des règles
    assert {c["verdict"]: c["count"] for c in page["verdicts"]} == {"NOT_FRAUD": 1}
    assert page["total"] == 1 and page["toReview"] == 0


HOLDER = {
    "titulaire_first_name": "Alex",
    "titulaire_last_name": "Durand",
    "titulaire_phone_number": 33600000000,  # numérique dans la table source : lu comme du texte
    "titulaire_birth_date": datetime(1990, 5, 4, tzinfo=UTC),  # horodatage : réduit à sa date
    "titulaire_address": "1 rue de l'Exemple",
    "titulaire_zip_code": "75000",
    "iban": "FR7600000000000000000000000",
    "identity_key": "ID-0001",
    "identity_type": "PASSPORT",
    "identity_origin_country": "FR",
    "erisk_label": "HIGH",
    "processing_state": "DONE",
}


def test_fiche_d_une_alerte(client, bq):
    # La fiche réunit les remontées de la commande (toutes règles et versions) et les informations du
    # titulaire, lues à la demande dans la table configurée.
    login(client)
    a = _submit(client, RULE)
    b = _submit(client, {**RULE, "name": "Autre règle"})
    bq.alert_rows = [
        _alert(a, "ORD-9", to_send=False, days_ago=2),
        _alert(b, "ORD-9", to_send=True, days_ago=1),
        _alert(a, "ORD-OTHER", to_send=False),
    ]
    bq.order_detail_rows = {"ORD-9": HOLDER}
    review(client, "ORD-9", a, "RISKY")

    d = client.get("/alerts/ORD-9").json()
    assert [(x["ruleName"], x["phase"]) for x in d["alerts"]] == [
        ("Autre règle", "PRODUCTION"),
        ("Panier élevé", "TEST"),
    ]
    assert d["alerts"][1]["verdict"] == "RISKY" and d["alerts"][1]["review"]["byName"] == "Camille Martin"
    h = d["holder"]
    assert (h["titulaireFirstName"], h["titulairePhoneNumber"], h["titulaireBirthDate"]) == (
        "Alex",
        "33600000000",
        "1990-05-04",
    )
    assert (h["iban"], h["identityOriginCountry"], h["eriskLabel"], h["processingState"]) == (
        "FR7600000000000000000000000",
        "FR",
        "HIGH",
        "DONE",
    )
    assert d["holderMissing"] is None

    # Commande absente de la table, table non configurée : les remontées restent visibles.
    assert client.get("/alerts/ORD-OTHER").json()["holderMissing"] == "NOT_FOUND"
    bq.order_detail_rows = None
    d = client.get("/alerts/ORD-9").json()
    assert (d["holder"], d["holderMissing"], len(d["alerts"])) == (None, "NOT_CONFIGURED", 2)

    # Une commande qu'aucune règle n'a remontée n'a pas de fiche.
    assert client.get("/alerts/ORD-INCONNUE").status_code == 404
