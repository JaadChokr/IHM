"""Schémas d'échange — miroir de frontend/src/api/types.ts (JSON en camelCase)."""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

# Statut d'une version de règle (toujours soumise : les brouillons sont à part, voir DraftOut).
# Soumise → en observation (Airflow l'exécute, rien n'est envoyé au prestataire) → en production
# (envoyée au prestataire) ; inactive, remplacée ou écartée sinon.
RuleStatus = Literal["SUBMITTED", "OBSERVATION", "IN_PRODUCTION", "INACTIVE", "REPLACED", "DISCARDED"]
Decision = Literal["SENT", "DISCARDED"]
Criticality = Literal["HIGH", "MEDIUM", "LOW"]
Schedule = Literal["DAILY", "HOURLY", "WEEKLY"]


class Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)


class UserOut(Model):
    matricule: str
    first_name: str
    last_name: str


class LoginIn(Model):
    matricule: str


class LoginOut(Model):
    user: UserOut | None
    needs_profile: bool


class ProfileIn(Model):
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)


class RuleInput(Model):
    name: str = Field(max_length=200)
    description: str
    fraud_typology: str
    criticality: Criticality
    schedule: Schedule
    sql_query: str


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


class RuleVersionOut(RuleInput):
    rule_id: str
    version: int
    status: RuleStatus
    owner_matricule: str
    owner_name: str
    submitted_by: str
    submitted_by_name: str
    created_at: datetime
    updated_at: datetime
    submitted_at: datetime
    decision: Decision | None = None
    decided_at: datetime | None = None
    decided_by_name: str | None = None
    airflow_dag_id: str | None = None
    first_run_at: datetime | None = None
    last_run_at: datetime | None = None
    # Tourne en parallèle de la version en production, en observation, jusqu'à la décision.
    candidate: bool = False


class RuleSummary(RuleVersionOut):
    version_count: int
    production_version: int | None = None
    last_test: TestRecord | None = None


class RuleDetail(RuleSummary):
    versions: list[RuleVersionOut]
    tests: list[TestRecord]
    # Propres à l'utilisateur connecté.
    my_draft_id: str | None = None  # son brouillon de nouvelle version, s'il en a un
    can_withdraw: bool = False  # il a soumis la dernière version et Airflow ne l'a jamais exécutée


class DecisionIn(Model):
    action: Literal["send", "suspend", "discard"]


class DraftIn(RuleInput):
    rule_id: str | None = None  # règle existante dont on prépare une nouvelle version


class DraftOut(RuleInput):
    """Brouillon personnel (visible de son seul auteur)."""

    id: str
    rule_id: str
    base_version: int | None = None
    new_rule: bool  # la règle n'existe pas encore dans le référentiel
    latest_version: int | None = None  # dernière version soumise de la règle, pour signaler un décalage
    withdrawn: bool = False  # vient d'être créé en retirant une soumission
    created_at: datetime
    updated_at: datetime
    last_test: TestRecord | None = None
    tests: list[TestRecord] = []


class NameAvailable(Model):
    available: bool


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


class DailyPerformance(Model):
    date: date
    rule_version: int | None = None  # version qui a tourné ce jour-là
    orders_flagged: int
    orders_to_send: int = 0  # dont marquées à transmettre au prestataire (version en production)
    orders_processed: int
    orders_confirmed_fraud: int


class VersionPerformance(Model):
    """Indicateurs cumulés d'une version sur toute sa période d'exécution (comparaison des versions)."""

    version: int
    first_date: date
    last_date: date
    days: int
    orders_flagged: int
    orders_processed: int
    orders_confirmed_fraud: int


class RuleRun(Model):
    """Une exécution automatique d'une version : sa dernière tentative (une exécution en échec est
    retentée automatiquement ; `attempts` en donne le nombre)."""

    run_id: str
    rule_version: int
    run_date: date
    period_start: datetime | None = None
    period_end: datetime | None = None
    started_at: datetime
    finished_at: datetime | None = None
    status: Literal["SUCCESS", "FAILED"]
    rows_returned: int | None = None  # commandes remontées
    rows_to_send: int | None = None  # dont à transmettre au prestataire
    error_message: str | None = None
    attempts: int = 1


class VersionDaily(Model):
    """Commandes d'une version un jour donné, en production (to_send) ou en observation : une courbe par
    version, pleine en production, pointillée en observation."""

    date: date
    rule_version: int
    to_send: bool
    orders_flagged: int
    orders_processed: int
    orders_confirmed_fraud: int


class PeriodTotals(Model):
    """Chiffres d'une règle sur une période, en commandes distinctes : exacts même si deux versions ont
    remonté la même commande (la somme des jours peut la compter deux fois)."""

    orders_flagged: int
    orders_to_send: int
    orders_processed: int
    orders_confirmed_fraud: int
    orders_observed: int = 0  # commandes remontées en observation (candidate comprise)


class PerformanceResponse(Model):
    rule_id: str
    from_: date = Field(alias="from")
    to: date
    daily: list[DailyPerformance]
    previous: list[DailyPerformance]
    totals: PeriodTotals | None = None
    previous_totals: PeriodTotals | None = None
    # Une ligne par jour, version et état (production / observation) : la courbe par version.
    by_version: list[VersionDaily] = []
    runs: list[RuleRun]
    versions: list[VersionPerformance]


class ConsolidatedRow(Model):
    rule_id: str
    name: str
    version: int
    fraud_typology: str
    criticality: Criticality
    owner_name: str
    status: RuleStatus
    last_run_at: datetime | None = None
    orders_flagged30d: int = Field(alias="ordersFlagged30d")
    orders_processed30d: int = Field(alias="ordersProcessed30d")
    orders_confirmed30d: int = Field(alias="ordersConfirmed30d")
    orders_to_send30d: int = Field(0, alias="ordersToSend30d")


class AuditEventOut(Model):
    id: str
    at: datetime
    matricule: str
    user_name: str
    action: str
    rule_id: str | None = None
    rule_name: str | None = None
    version: int | None = None
    details: str | None = None
