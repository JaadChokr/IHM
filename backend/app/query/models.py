"""Test de requête : métadonnées des tests (table `rule_tests`, jamais les lignes retournées, PRD §10) et
formats d'API."""

from datetime import datetime
from typing import Any, Literal

from sqlalchemy import BigInteger, String, Text
from sqlmodel import Field

from app.core.models import Model, UtcDateTime
from app.core.periods import Schedule


class TestRunBase(Model):
    """Métadonnées d'un test (F3), jamais les lignes retournées (PRD §10). Base de la table `rule_tests`."""

    __test__ = False  # pas une classe de test pytest

    id: str = Field(primary_key=True, max_length=36)
    rule_id: str | None = Field(default=None, max_length=36, index=True)
    version: int | None = None
    # Test d'un brouillon : rattaché à la version créée lors de sa soumission.
    draft_id: str | None = Field(default=None, max_length=36, index=True)
    query_hash: str = Field(max_length=16)
    at: datetime = Field(sa_type=UtcDateTime, index=True)
    by_matricule: str = Field(max_length=6, index=True)
    phase: Literal["DRY_RUN", "EXECUTION"] = Field(sa_type=String(10))
    success: bool
    bytes_processed: int | None = Field(default=None, sa_type=BigInteger)
    duration_ms: int | None = None
    total_rows: int | None = Field(default=None, sa_type=BigInteger)
    error: str | None = Field(default=None, sa_type=Text)


class TestRecord(TestRunBase):
    """Un test tel que l'API le renvoie : ses métadonnées et le nom de son auteur."""

    by_name: str


class TestRun(TestRunBase, table=True):
    """Table des tests : mêmes champs que l'API, sans le nom de l'auteur (calculé)."""

    __tablename__ = "rule_tests"


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
    rows: list[dict[str, Any]]
    total_rows: int
    duration_ms: int
    bytes_processed: int
    # Commandes distinctes renvoyées, et celles déjà remontées par une autre règle (rule_alerts).
    orders_flagged: int
    orders_already_flagged: int | None = None  # None : rule_alerts indisponible
    overlap_days: int
    period: TestPeriod
    test_id: str
