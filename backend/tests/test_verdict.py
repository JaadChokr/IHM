"""La règle de verdict n'est écrite qu'une fois en SQL (vue v_rule_orders) ; la passerelle simulée la
reproduit en Python (`verdict_of`). Ce test vérifie qu'elles donnent le même verdict dans tous les cas : une
évolution de la vue sans la simulation (ou l'inverse) le fait échouer."""

import itertools
import re
import sqlite3
from pathlib import Path

import sqlglot

from app.bigquery import verdict_of

VIEW = Path(__file__).parents[2] / "infra" / "bigquery" / "views" / "01_v_rule_orders.sql"


def _verdict_case() -> str:
    """L'expression CASE … END AS verdict de la vue, traduite en SQLite."""
    sql = re.sub(r"--[^\n]*", "", VIEW.read_text(encoding="utf-8"))
    case = re.search(r"(CASE\b.*?\bEND)\s+AS\s+verdict", sql, re.S | re.I)
    assert case, "expression du verdict introuvable dans la vue"
    return sqlglot.transpile(case.group(1), read="bigquery", write="sqlite")[0]


def test_verdict_identique_dans_la_vue_et_la_simulation():
    db = sqlite3.connect(":memory:")
    row = "SELECT ? AS to_send, ? AS has_feedback, ? AS is_fraud, ? AS review_is_fraud"
    query = f"SELECT {_verdict_case()} FROM ({row})"
    cases = 0
    for to_send, has_feedback, provider, review in itertools.product(
        (False, True), (False, True), (None, False, True), (None, False, True)
    ):
        if not has_feedback and provider is not None:
            continue  # pas de verdict du prestataire sans retour
        (sql_verdict,) = db.execute(query, (to_send, has_feedback, provider, review)).fetchone()
        assert sql_verdict == verdict_of(to_send, provider, has_feedback, review), (
            to_send,
            has_feedback,
            provider,
            review,
        )
        cases += 1
    assert cases == 24
