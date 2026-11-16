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
    # Les filtres ne proposent que des choix qui renvoient des alertes : par phase pour la règle choisie, par
    # règle dans la phase choisie, par verdict pour les deux.
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
    assert {c["phase"]: c["count"] for c in page["phases"]} == {"TEST": 2, "PRODUCTION": 2}
    # En test, seule la première règle a des alertes : l'autre n'est pas proposée.
    assert [(c["ruleName"], c["count"]) for c in page["rules"]] == [("Panier élevé", 2)]
    assert {c["verdict"]: c["count"] for c in page["verdicts"]} == {"TO_REVIEW": 1, "NOT_FRAUD": 1}
    assert page["toReview"] == 1

    page = client.get("/alerts", params={"phase": "PRODUCTION", "ruleId": b}).json()
    assert {c["phase"]: c["count"] for c in page["phases"]} == {"PRODUCTION": 1}
    assert {c["ruleName"]: c["count"] for c in page["rules"]} == {"Panier élevé": 1, "Autre règle": 1}
    assert {c["verdict"]: c["count"] for c in page["verdicts"]} == {"NOT_FRAUD": 1}
    assert page["total"] == 1 and page["toReview"] == 0
