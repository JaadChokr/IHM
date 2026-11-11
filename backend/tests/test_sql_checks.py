from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from app.query.periods import is_due, last_period, period_start
from app.query.sql_checks import check_params, find_params, query_hash


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


def test_periode_avec_un_pas():
    paris = ZoneInfo("Europe/Paris")

    def at(*args):
        return datetime(*args, tzinfo=paris)

    # Toutes les 2 h : calées sur minuit (0 h 05, 2 h 05…), période de 2 h.
    p = last_period("HOURLY", at(2026, 11, 4, 14, 2), 2)
    assert (p.start, p.end) == (at(2026, 11, 4, 10, 5), at(2026, 11, 4, 12, 5))
    # Tous les 3 jours : calés sur le 5 janvier 2026 (le 4 nov. 2026 est dû : 303 jours après).
    p = last_period("DAILY", at(2026, 11, 4, 12), 3)
    assert (p.start, p.end) == (at(2026, 11, 1, 3), at(2026, 11, 4, 3))
    p = last_period("DAILY", at(2026, 11, 6, 12), 3)  # le 6 n'est pas dû : dernière période close le 4
    assert (p.start, p.end) == (at(2026, 11, 1, 3), at(2026, 11, 4, 3))
    # Toutes les 2 semaines : une semaine sur deux depuis le lundi 5 janvier 2026 (le 26 oct. : semaine 42).
    p = last_period("WEEKLY", at(2026, 11, 4, 9), 2)
    assert (p.start, p.end) == (at(2026, 10, 12, 4), at(2026, 10, 26, 4))
    # Pas invalide (5 h ne divise pas 24) : la plateforme retombe sur 1.
    assert last_period("HOURLY", at(2026, 11, 4, 14, 2), 5).end - last_period(
        "HOURLY", at(2026, 11, 4, 14, 2), 5
    ).start == timedelta(hours=1)


def test_pas_horaire_aux_changements_d_heure():
    paris = ZoneInfo("Europe/Paris")
    # Passage à l'heure d'été (29 mars 2026) : 2 h 05 n'existe pas. Toutes les 2 h : le run de 4 h 05
    # reprend à 0 h 05, sans trou (3 h de temps réel).
    end = datetime(2026, 3, 29, 4, 5, tzinfo=paris)
    assert is_due("HOURLY", 2, end)
    assert period_start("HOURLY", 2, end) == datetime(2026, 3, 29, 0, 5, tzinfo=paris)
    # Passage à l'heure d'hiver (25 octobre 2026) : 2 h 05 a lieu deux fois, chaque run couvre 1 h.
    first = datetime(2026, 10, 25, 0, 5, tzinfo=paris).astimezone(UTC) + timedelta(hours=2)  # 2 h 05 d'été
    second = first + timedelta(hours=1)  # 2 h 05 d'hiver
    assert is_due("HOURLY", 2, first) and is_due("HOURLY", 2, second)
    assert period_start("HOURLY", 2, second) == first


def test_query_hash_identique_au_front():
    # Valeurs calculées avec queryHash() de frontend/src/lib/sql.ts.
    assert query_hash("SELECT 1") == query_hash("  SELECT   1\n")
    assert query_hash("SELECT 1") == "bce9e8b2"
    assert query_hash("SELECT é FROM t WHERE d = @run_date") == "5f48a2f4"
