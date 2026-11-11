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


def review(client, order, rule_id, is_fraud):
    body = {"orderId": order, "ruleId": rule_id, "ruleVersion": 1, "isFraud": is_fraud}
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
    r = review(client, "ORD-1", rid, True)
    assert r.status_code == 204, r.text
    items = client.get("/alerts", params={"ruleId": rid}).json()["items"]
    a = next(x for x in items if x["orderId"] == "ORD-1")
    assert a["verdict"] == "FRAUD" and a["review"]["byName"] == "Camille Martin"
    assert client.get("/alerts", params={"verdict": "TO_REVIEW"}).json()["total"] == 0

    # Qualification retirée : de nouveau à qualifier.
    review(client, "ORD-1", rid, None)
    assert client.get("/alerts", params={"phase": "TEST"}).json()["items"][0]["verdict"] == "TO_REVIEW"

    # Une commande transmise est vérifiée par le prestataire : pas de qualification.
    r = review(client, "ORD-2", rid, False)
    assert r.status_code == 409 and r.json()["code"] == "NOT_IN_TEST"
    r = review(client, "ORD-1", "inconnue", True)
    assert r.status_code == 404

    audit = [e for e in client.get("/audit").json() if e["action"] == "ALERT_REVIEW"]
    assert [e["details"] for e in audit][-1] == "Commande ORD-1 : fraude"

    # Filtres et période.
    assert client.get("/alerts", params={"phase": "PRODUCTION"}).json()["total"] == 2
    assert client.get("/alerts", params={"q": "ORD-3"}).json()["total"] == 1
    old = (TODAY - timedelta(days=45)).isoformat()
    assert client.get("/alerts", params={"from": old}).json()["total"] == 4
    assert client.get("/alerts", params={"from": "2020-01-01"}).status_code == 422
    assert len(client.get("/alerts", params={"limit": 2}).json()["items"]) == 2
    assert date.fromisoformat(page["items"][0]["runDate"]) <= TODAY
