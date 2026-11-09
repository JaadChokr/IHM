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


def test_chiffres_de_la_regle_sans_candidate_ni_doublon():
    # Chiffres d'une règle : jamais la candidate, en commandes distinctes (une commande remontée par deux
    # versions n'est comptée qu'une fois), « envoyées » lues sur to_send.
    from datetime import date

    g = RealBigQueryGateway.__new__(RealBigQueryGateway)
    g.ds = "`p.d`"
    g._bq = type(
        "bq",
        (),
        {
            "ScalarQueryParameter": staticmethod(lambda *a: a),
            "ArrayQueryParameter": staticmethod(lambda *a: a),
        },
    )
    seen: list[str] = []
    g._rows = lambda sql, params: seen.append(sql) or []
    g.daily_performance("r", date(2026, 11, 1), date(2026, 11, 2))
    g.production_totals(["r"], date(2026, 11, 1), date(2026, 11, 2))
    for sql in seen:
        assert "v_rule_orders" in sql and "COUNT(DISTINCT IF(NOT candidate, order_id, NULL))" in sql
        assert "COUNT(DISTINCT IF(to_send, order_id, NULL))" in sql
