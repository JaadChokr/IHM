"""Tests de la réécriture « dans le passé » (pytest + sqlglot, sans Airflow ni BigQuery)."""

from datetime import UTC, datetime

import sqlglot

from fraud_rules_sql import as_of, referenced_tables

AT = datetime(2026, 11, 3, 3, 0, tzinfo=UTC)
TS = "TIMESTAMP '2026-11-03 03:00:00.000000+00'"

SQL = """WITH recents AS (
  SELECT order_id FROM `proj.sales.orders` WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
)
SELECT o.order_id, 'CURRENT_DATE()' AS texte  -- CURRENT_DATE() dans un commentaire
FROM `sales.orders` o
JOIN sales.customers c USING (customer_id)
JOIN recents r USING (order_id)
WHERE o.created_at < CURRENT_TIMESTAMP()"""


def valid(sql: str) -> None:
    sqlglot.parse_one(sql, read="bigquery")


def test_tables_lues_hors_cte():
    assert referenced_tables(SQL) == ["proj.sales.orders", "sales.customers", "sales.orders"]


def test_dates_remplacees_par_celles_du_run_le_reste_intact():
    out = as_of(SQL, AT)
    assert out == (
        SQL.replace("DATE_SUB(CURRENT_DATE(),", "DATE_SUB(DATE '2026-11-03',").replace(
            "< CURRENT_TIMESTAMP()", f"< {TS}"
        )
    )  # chaîne, commentaire et mise en forme inchangés
    valid(out)


def test_fuseau_horaire_conserve():
    out = as_of("SELECT CURRENT_DATE('Europe/Paris'), current_datetime, CURRENT_TIMESTAMP", AT)
    assert out == f"SELECT DATE({TS}, 'Europe/Paris'), DATETIME({TS}), {TS}"
    valid(out)


def test_voyage_dans_le_temps_sur_les_tables_retenues_seulement():
    out = as_of(SQL, AT, {"sales.orders", "proj.sales.orders"})
    assert f"FROM `proj.sales.orders` FOR SYSTEM_TIME AS OF {TS} WHERE" in out
    assert f"FROM `sales.orders` o FOR SYSTEM_TIME AS OF {TS}\n" in out  # après l'alias
    assert "JOIN sales.customers c USING" in out  # non retenue (ex. une vue)
    assert "JOIN recents r USING" in out  # une CTE n'est jamais une table
    valid(out)


def test_table_deja_datee_par_l_analyste():
    sql = f"SELECT 1 FROM d.t AS a FOR SYSTEM_TIME AS OF {TS}"
    assert referenced_tables(sql) == []
    assert as_of(sql, AT, {"d.t"}) == sql


def test_sans_date_courante_la_requete_est_inchangee():
    sql = "SELECT order_id FROM sales.orders WHERE amount_eur >= 500"
    assert as_of(sql, AT) == sql
