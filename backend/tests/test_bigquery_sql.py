"""Requêtes de la passerelle BigQuery réelle, vérifiées sans GCP (le client n'est pas créé)."""

from app.bigquery import RealBigQueryGateway


def test_synchronisation_ne_compte_que_les_runs_reussis():
    # rule_runs garde une ligne par tentative : un premier run en échec ne date pas la mise en route.
    g = RealBigQueryGateway.__new__(RealBigQueryGateway)
    g.ds = "`p.d`"
    seen: list[str] = []
    g._rows = lambda sql, params: seen.append(sql) or []
    assert g.run_stats() == []
    assert "WHERE status = 'SUCCESS'" in seen[0]


def test_chiffres_de_la_regle_selon_son_etat():
    # En production : ses commandes à transmettre ; en observation : les autres. En commandes distinctes
    # (une commande remontée par deux versions n'est comptée qu'une fois).
    from datetime import date

    g = RealBigQueryGateway.__new__(RealBigQueryGateway)
    g.ds = "`p.d`"
    param = staticmethod(lambda *a: a)
    g._bq = type("bq", (), {"ScalarQueryParameter": param, "ArrayQueryParameter": param})
    seen: list[tuple[str, list]] = []
    g._rows = lambda sql, params: seen.append((sql, params)) or []
    g.daily_performance("r", date(2026, 11, 1), date(2026, 11, 2), sent=True)
    g.production_totals({"a": True, "b": False}, date(2026, 11, 1), date(2026, 11, 2))
    daily, totals = seen
    assert "to_send = @sent" in daily[0] and ("sent", "BOOL", True) in daily[1]
    assert "rule_id IN UNNEST(@sent_ids) AND to_send" in totals[0]
    assert "rule_id IN UNNEST(@observed_ids) AND NOT to_send" in totals[0]
    assert ("sent_ids", "STRING", ["a"]) in totals[1] and ("observed_ids", "STRING", ["b"]) in totals[1]
    for sql, _ in seen:
        assert "v_rule_orders" in sql and "COUNT(DISTINCT order_id)" in sql
