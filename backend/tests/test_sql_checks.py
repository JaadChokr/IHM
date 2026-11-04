from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.periods import last_period
from app.sql_checks import check_params, find_params, query_hash


def test_params_ignores_dans_chaines_et_commentaires():
    sql = (
        "SELECT order_id FROM t -- @nope\nWHERE a = '@str' AND d = @run_date AND x > @seuil AND @@project_id"
    )
    assert [n for n, _ in find_params(sql)] == ["run_date", "seuil"]


def test_seules_les_bornes_de_periode_sont_admises():
    # Fournies par Airflow à chaque run (et par la plateforme au test) ; tout autre paramètre est refusé.
    codes = [i.code for i in check_params("SELECT order_id WHERE x > @seuil AND d = @run_date")]
    assert codes == ["PARAM_NOT_ALLOWED", "PARAM_NOT_ALLOWED"]
    assert check_params("SELECT order_id FROM t WHERE d >= @period_start AND d < @period_end") == []


def test_periode_calee_sur_le_cron_du_dag():
    paris = ZoneInfo("Europe/Paris")

    def at(*args):
        return datetime(*args, tzinfo=paris)

    p = last_period("DAILY", at(2026, 11, 4, 2, 30))  # avant le run quotidien de 3 h
    assert (p.start, p.end) == (
        at(2026, 11, 2, 3),
        at(2026, 11, 3, 3),
    )
    p = last_period("HOURLY", at(2026, 11, 4, 14, 2))
    assert (p.start, p.end) == (
        at(2026, 11, 4, 12, 5),
        at(2026, 11, 4, 13, 5),
    )
    p = last_period("WEEKLY", at(2026, 11, 4, 9))  # mercredi → lundi 2 nov. 4 h
    assert (p.start, p.end) == (
        at(2026, 10, 26, 4),
        at(2026, 11, 2, 4),
    )
    # Passage à l'heure d'hiver (25 octobre 2026) : la journée fait 25 h, la borne reste à 3 h.
    p = last_period("DAILY", at(2026, 10, 25, 12))
    assert p.end - p.start == timedelta(hours=25)


def test_query_hash_identique_au_front():
    # Valeurs calculées avec queryHash() de frontend/src/lib/sql.ts.
    assert query_hash("SELECT 1") == query_hash("  SELECT   1\n")
    assert query_hash("SELECT 1") == "bce9e8b2"
    assert query_hash("SELECT é FROM t WHERE d = @run_date") == "5f48a2f4"
