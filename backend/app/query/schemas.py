"""Schémas d'échange du test de requête."""

from datetime import datetime
from typing import Literal

from app.core.schemas import Model
from app.rules.types import Schedule


class TestRecord(Model):
    id: str
    rule_id: str | None = None
    version: int | None = None
    draft_id: str | None = None
    query_hash: str
    at: datetime
    by_matricule: str
    by_name: str
    phase: Literal["DRY_RUN", "EXECUTION"]
    success: bool
    bytes_processed: int | None = None
    duration_ms: int | None = None
    total_rows: int | None = None
    error: str | None = None


class Guardrails(Model):
    max_bytes_billed: int
    job_timeout_ms: int
    max_results: int


class QueryIn(Model):
    sql: str
    rule_id: str | None = None
    draft_id: str | None = None
    # Règle à ne pas compter parmi les « déjà remontées » quand le test n'est rattaché à rien
    # (nouvelle version pas encore enregistrée).
    exclude_rule_id: str | None = None
    # Fréquence saisie dans l'éditeur : fixe la période testée (@period_start / @period_end). À défaut,
    # celle du brouillon ou de la règle testée, sinon quotidienne.
    schedule: Schedule | None = None
    schedule_every: int | None = None


class TestPeriod(Model):
    """Valeurs de @period_start / @period_end au test : la dernière période complète de la fréquence."""

    start: datetime
    end: datetime


class SqlIssue(Model):
    severity: Literal["error", "warning"]
    code: str
    message: str
    line: int | None = None
    column: int | None = None
    length: int | None = None


class Column(Model):
    name: str
    type: str


class DryRunResult(Model):
    ok: bool
    statement_type: str | None = None
    output_schema: list[Column] | None = None
    bytes_processed: int | None = None
    issues: list[SqlIssue]
    exceeds_bytes_limit: bool
    period: TestPeriod
    test_id: str


class ExecutionResult(Model):
    ok: bool
    error: str | None = None
    columns: list[str]
    rows: list[dict]
    total_rows: int
    duration_ms: int
    bytes_processed: int
    # Commandes distinctes renvoyées, et celles déjà remontées par une autre règle (rule_alerts).
    orders_flagged: int
    orders_already_flagged: int | None = None  # None : rule_alerts indisponible
    overlap_days: int
    period: TestPeriod
    test_id: str
