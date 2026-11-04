"""Voyage dans le temps ajouté par le DAG à la requête d'une règle (sans dépendance à Airflow).

Chaque table lue par la requête l'est dans son état de fin de période :
`FROM `sales.orders` o` devient `FROM `sales.orders` o FOR SYSTEM_TIME AS OF @period_end`. Un run
exécuté à l'heure, rattrapé ou relancé voit donc les mêmes données, y compris pour une requête sans
fenêtre de dates.

Le texte de l'analyste n'est modifié qu'à ces endroits (mise en forme et commentaires intacts). Les
positions viennent de l'analyseur sqlglot (dialecte BigQuery) : un nom de table dans une chaîne ou un
commentaire n'est jamais touché, un nom de CTE n'est pas une table, et une table que l'analyste a déjà
datée lui-même est laissée telle quelle.
"""

from __future__ import annotations

import sqlglot
from sqlglot import exp
from sqlglot.errors import SqlglotError

DIALECT = "bigquery"
AS_OF = " FOR SYSTEM_TIME AS OF @period_end"


def _key(table: exp.Table) -> str:
    return ".".join(p for p in (table.catalog, table.db, table.name) if p)


def _tables(tree: exp.Expression) -> list[exp.Table]:
    """Tables lues (avec au moins un dataset), hors noms de CTE et tables déjà datées par l'analyste."""
    ctes = {cte.alias_or_name for cte in tree.find_all(exp.CTE)}
    return [t for t in tree.find_all(exp.Table) if t.db and t.name not in ctes and not t.args.get("version")]


def referenced_tables(sql: str) -> list[str]:
    """Tables lues par la requête (« dataset.table » ou « projet.dataset.table »), triées."""
    return sorted({_key(t) for t in _tables(sqlglot.parse_one(sql, read=DIALECT))})


def with_time_travel(sql: str, tables: set[str] | frozenset[str]) -> str:
    """La requête avec `FOR SYSTEM_TIME AS OF @period_end` après chaque table de `tables` (clés de
    `referenced_tables`), placé après l'alias comme l'exige BigQuery. L'appelant n'y met que de vraies
    tables : ni vue, ni table externe, ni table générique (`events_*`)."""
    positions = []
    for table in _tables(sqlglot.parse_one(sql, read=DIALECT)):
        ends = [i.meta["end"] for i in table.find_all(exp.Identifier) if "end" in i.meta]
        if _key(table) in tables and ends:
            positions.append(max(ends) + 1)
    # De la fin vers le début : les positions suivantes restent justes.
    for pos in sorted(positions, reverse=True):
        sql = sql[:pos] + AS_OF + sql[pos:]
    return sql


__all__ = ["SqlglotError", "referenced_tables", "with_time_travel"]
