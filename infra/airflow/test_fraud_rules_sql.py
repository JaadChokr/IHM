"""Tests du voyage dans le temps ajouté par le DAG (pytest + sqlglot, sans Airflow ni BigQuery)."""

import sqlglot

from fraud_rules_sql import referenced_tables, with_time_travel

AS_OF = "FOR SYSTEM_TIME AS OF @period_end"

SQL = """WITH recents AS (
  SELECT order_id FROM `proj.sales.orders` WHERE created_at >= @period_start
)
SELECT o.order_id, 'sales.customers' AS texte  -- sales.customers dans un commentaire
FROM `sales.orders` o
JOIN sales.customers AS c USING (customer_id)
JOIN recents r USING (order_id)
WHERE o.created_at < @period_end"""


def valid(sql: str) -> None:
    sqlglot.parse_one(sql, read="bigquery")


def test_tables_lues_hors_cte():
    assert referenced_tables(SQL) == ["proj.sales.orders", "sales.customers", "sales.orders"]


def test_chaque_table_lue_en_fin_de_periode():
    out = with_time_travel(SQL, {"proj.sales.orders", "sales.customers", "sales.orders"})
    assert f"FROM `proj.sales.orders` {AS_OF} WHERE" in out
    assert f"FROM `sales.orders` o {AS_OF}\n" in out  # après l'alias
    assert f"JOIN sales.customers AS c {AS_OF} USING" in out
    assert "JOIN recents r USING" in out  # une CTE n'est pas une table
    # Chaîne, commentaire et mise en forme intacts.
    assert "'sales.customers' AS texte  -- sales.customers dans un commentaire" in out
    assert out.replace(f" {AS_OF}", "") == SQL
    valid(out)


def test_seules_les_tables_retenues():
    # Une vue (ou une table externe) ne peut pas remonter le temps : l'appelant ne la retient pas.
    out = with_time_travel(SQL, {"sales.orders"})
    assert out.count(AS_OF) == 1 and "JOIN sales.customers AS c USING" in out


def test_table_deja_datee_par_l_analyste():
    sql = "SELECT order_id FROM d.t AS a FOR SYSTEM_TIME AS OF TIMESTAMP '2026-11-01'"
    assert referenced_tables(sql) == []
    assert with_time_travel(sql, {"d.t"}) == sql


def test_requete_sans_fenetre():
    sql = "SELECT order_id FROM sales.orders WHERE amount_eur >= 500"
    assert (
        with_time_travel(sql, {"sales.orders"})
        == f"SELECT order_id FROM sales.orders {AS_OF} WHERE amount_eur >= 500"
    )
