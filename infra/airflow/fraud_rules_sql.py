"""Réécriture des requêtes de règles pour rejouer un run « dans le passé » (sans dépendance à Airflow).

En fonctionnement normal, la requête de l'analyste est exécutée telle quelle. Quand un run est relancé
après coup, on la replace à l'heure du run d'origine :
  - CURRENT_DATE(), CURRENT_DATETIME(), CURRENT_TIMESTAMP() renvoient la date / l'heure du run
    (fuseau horaire éventuel conservé : CURRENT_DATE('Europe/Paris') → DATE(TIMESTAMP '…', 'Europe/Paris')) ;
  - les tables lues le sont dans leur état à cette heure (« voyage dans le temps » de BigQuery,
    FOR SYSTEM_TIME AS OF), limité aux 7 derniers jours et aux vraies tables (pas les vues).

Le texte de l'analyste est modifié au minimum, aux seuls endroits concernés : sa mise en forme et ses
commentaires restent intacts. Les positions viennent de l'analyseur sqlglot (dialecte BigQuery), si bien
qu'un mot qui ressemble à une fonction ou à une table dans une chaîne ou un commentaire n'est jamais touché.
"""

from __future__ import annotations

from datetime import UTC, datetime

import sqlglot
from sqlglot import exp
from sqlglot.dialects.bigquery import BigQuery
from sqlglot.errors import SqlglotError
from sqlglot.tokens import TokenType

DIALECT = "bigquery"
CLOCKS = {TokenType.CURRENT_DATE: "DATE", TokenType.CURRENT_DATETIME: "DATETIME"}


def _stamp(at: datetime) -> str:
    return f"TIMESTAMP '{at.astimezone(UTC).strftime('%Y-%m-%d %H:%M:%S.%f')}+00'"


def _table_key(table: exp.Table) -> str:
    return ".".join(p for p in (table.catalog, table.db, table.name) if p)


def _tables(tree: exp.Expression) -> list[exp.Table]:
    """Tables lues (avec au moins un dataset), hors noms de CTE et tables déjà datées par l'analyste."""
    ctes = {cte.alias_or_name for cte in tree.find_all(exp.CTE)}
    return [t for t in tree.find_all(exp.Table) if t.db and t.name not in ctes and not t.args.get("version")]


def referenced_tables(sql: str) -> list[str]:
    """Tables lues par la requête (« dataset.table » ou « projet.dataset.table »), triées."""
    return sorted({_table_key(t) for t in _tables(sqlglot.parse_one(sql, read=DIALECT))})


def _clock_edits(sql: str, at: datetime) -> list[tuple[int, int, str]]:
    """(début, fin exclue, remplacement) pour chaque CURRENT_DATE / DATETIME / TIMESTAMP de la requête."""
    tokens = BigQuery().tokenize(sql)
    edits = []
    for i, tok in enumerate(tokens):
        if tok.token_type not in (*CLOCKS, TokenType.CURRENT_TIMESTAMP):
            continue
        end, args = tok.end + 1, ""
        if i + 1 < len(tokens) and tokens[i + 1].token_type == TokenType.L_PAREN:
            depth = 0
            for j in range(i + 1, len(tokens)):
                depth += {TokenType.L_PAREN: 1, TokenType.R_PAREN: -1}.get(tokens[j].token_type, 0)
                if depth == 0:
                    args = sql[tokens[i + 1].end + 1 : tokens[j].start].strip()
                    end = tokens[j].end + 1
                    break
        if tok.token_type == TokenType.CURRENT_TIMESTAMP:
            new = _stamp(at)
        elif not args and tok.token_type == TokenType.CURRENT_DATE:
            new = f"DATE '{at.astimezone(UTC).date().isoformat()}'"
        else:  # le même calcul que BigQuery, à partir de l'heure du run et du fuseau éventuel
            new = f"{CLOCKS[tok.token_type]}({_stamp(at)}{', ' + args if args else ''})"
        edits.append((tok.start, end, new))
    return edits


def _time_travel_edits(sql: str, at: datetime, keys: set[str] | frozenset[str]) -> list[tuple[int, int, str]]:
    """Insère FOR SYSTEM_TIME AS OF après chaque table retenue (après son alias, comme l'exige BigQuery)."""
    edits = []
    for table in _tables(sqlglot.parse_one(sql, read=DIALECT)):
        if _table_key(table) not in keys:
            continue
        ends = [i.meta["end"] for i in table.find_all(exp.Identifier) if "end" in i.meta]
        if ends:
            pos = max(ends) + 1
            edits.append((pos, pos, f" FOR SYSTEM_TIME AS OF {_stamp(at)}"))
    return edits


def as_of(sql: str, at: datetime, time_travel: set[str] | frozenset[str] = frozenset()) -> str:
    """La requête telle qu'elle se serait exécutée à `at`.

    `time_travel` : tables (clés de `referenced_tables`) à lire dans leur état à `at` ; l'appelant n'y
    met que de vraies tables, et seulement si `at` date de moins de 7 jours.
    """
    edits = _clock_edits(sql, at) + (_time_travel_edits(sql, at, time_travel) if time_travel else [])
    # De la fin vers le début : les positions des modifications suivantes restent justes.
    for start, end, new in sorted(edits, reverse=True):
        sql = sql[:start] + new + sql[end:]
    return sql


__all__ = ["SqlglotError", "as_of", "referenced_tables"]
