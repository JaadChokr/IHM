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
