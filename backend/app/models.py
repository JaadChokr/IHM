"""Tous les modèles SQLModel de l'API : les tables PostgreSQL et les formats d'échange, au même endroit.

Une même classe peut décrire une table (`table=True`) et un format de l'API : un champ commun aux deux n'est
déclaré qu'une fois, dans une base partagée dont héritent la table et le format (ex. RuleInput → RuleVersion,
Draft, RuleVersionOut, DraftOut). Le JSON est en camelCase ; le front en tire ses types (openapi_export.py).
Les sections suivent l'ordre des dépendances : une section n'utilise que les précédentes.
"""

from datetime import date, datetime
from typing import Any, Literal

from pydantic import ConfigDict, model_validator
from pydantic.alias_generators import to_camel
from sqlalchemy import BigInteger, DateTime, String, Text, UniqueConstraint
from sqlmodel import Field, Relationship, SQLModel

from app.core.periods import Schedule, check_every

# ============================================================================================================
# Base commune : JSON en camelCase, horodatages avec fuseau
# ============================================================================================================


class Model(SQLModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)


# Horodatages stockés avec leur fuseau (sans précision, SQLModel crée des dates sans fuseau).
UtcDateTime = DateTime(timezone=True)


# ============================================================================================================
# Identification : utilisateurs et sessions
# ============================================================================================================
# Utilisateurs et sessions (le matricule est la clé d'identité, PRD §5.4) : tables et formats d'API.

# ---------- formats d'API (UserBase est aussi la base de la table users) ----------


class UserBase(Model):
    matricule: str = Field(primary_key=True, max_length=6)
    first_name: str = Field(max_length=100)
    last_name: str = Field(max_length=100)


class UserOut(UserBase):
    pass


class LoginIn(Model):
    matricule: str


class LoginOut(Model):
    user: UserOut | None
    needs_profile: bool


class ProfileIn(Model):
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)


# ---------- tables ----------


class User(UserBase, table=True):
    __tablename__ = "users"

    created_at: datetime = Field(sa_type=UtcDateTime)

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}"


class UserSession(SQLModel, table=True):
    __tablename__ = "sessions"

    token_hash: str = Field(primary_key=True, max_length=64)
    matricule: str = Field(max_length=6, index=True)
    # Vrai tant que nom et prénom n'ont pas été saisis (première connexion).
    pending_profile: bool = False
    last_seen: datetime = Field(sa_type=UtcDateTime)


# ============================================================================================================
# Journal d'activité
# ============================================================================================================
# Journal d'audit, en ajout seul (immuable, conservation 24 mois) : table et format d'API.
#
# La table `audit_events` a exactement les champs renvoyés par l'API : elle hérite de `AuditEventOut`.

# Actions tracées dans le journal (les anciennes valeurs RULE_CREATE, RULE_UPDATE, RULE_NEW_VERSION restent
# lisibles : le journal est immuable).
AuditAction = Literal[
    "LOGIN",
    "PROFILE_UPDATE",
    "RULE_CREATE",
    "RULE_UPDATE",
    "RULE_NEW_VERSION",
    "RULE_TEST",
    "RULE_SUBMIT",
    "RULE_WITHDRAW",
    "RULE_SEND_TO_PROVIDER",
    "RULE_SUSPEND_SENDING",
    "RULE_DISCARD",
    "ALERT_REVIEW",
]


class AuditEventOut(Model):
    id: str = Field(primary_key=True, max_length=36)
    at: datetime = Field(sa_type=UtcDateTime, index=True)
    matricule: str = Field(max_length=6, index=True)
    user_name: str = Field(max_length=200)
    action: AuditAction = Field(sa_type=String(30))
    rule_id: str | None = Field(default=None, max_length=36, index=True)
    rule_name: str | None = Field(default=None, max_length=200)
    version: int | None = None
    details: str | None = Field(default=None, sa_type=Text)


class AuditEvent(AuditEventOut, table=True):
    __tablename__ = "audit_events"


# ============================================================================================================
# Test de requête
# ============================================================================================================
# Test de requête : métadonnées des tests (table `rule_tests`, jamais les lignes retournées, PRD §10) et
# formats d'API.


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


# ============================================================================================================
# Règles et versions
# ============================================================================================================
# Règles et leurs versions (toute version est publiée ; les brouillons sont à part) : tables et formats
# d'API.
#
# `RuleInput` est le contenu éditable d'une règle : la version publiée (`RuleVersion`), le brouillon (`Draft`)
# et leurs formats d'API en héritent, si bien que chaque champ n'est déclaré qu'une fois.

# Statut d'une version de règle (toujours publiée : les brouillons sont à part, voir DraftOut).
# Publiée, elle est en test d'office (Airflow l'exécute à sa prochaine échéance, rien n'est envoyé au
# prestataire) → en production (envoyée au prestataire) ; inactive, remplacée ou écartée sinon. Qu'elle
# ait déjà tourné se lit dans first_run_at.
RuleStatus = Literal["TEST", "IN_PRODUCTION", "INACTIVE", "REPLACED", "DISCARDED"]

Decision = Literal["SENT", "DISCARDED"]

Criticality = Literal["HIGH", "MEDIUM", "LOW"]


class RuleInput(Model):
    name: str = Field(max_length=200)
    description: str = Field(sa_type=Text)
    fraud_typology: str = Field(max_length=100)
    criticality: Criticality = Field(sa_type=String(10))
    schedule: Schedule = Field(sa_type=String(10))
    # Pas de la fréquence : toutes les `schedule_every` heures, jours ou semaines (periods.EVERY).
    schedule_every: int = Field(default=1, sa_column_kwargs={"server_default": "1"})
    sql_query: str = Field(sa_type=Text)

    @model_validator(mode="after")
    def _every(self):  # noqa: ANN202
        check_every(self.schedule, self.schedule_every)
        return self


class RuleVersionBase(RuleInput):
    """Champs d'une version publiée, communs à la table `rule_versions` et à l'API."""

    rule_id: str = Field(max_length=36, foreign_key="rules.rule_id", index=True)
    version: int
    # Toute version est soumise : les brouillons vivent dans `drafts`.
    submitted_by: str = Field(max_length=6, foreign_key="users.matricule")
    created_at: datetime = Field(sa_type=UtcDateTime)
    updated_at: datetime = Field(sa_type=UtcDateTime)
    submitted_at: datetime = Field(sa_type=UtcDateTime)
    # Décision de l'analyste après le test : SENT (envoyée au prestataire), DISCARDED (écartée),
    # ou None (en test : Airflow l'exécute, ses commandes ne partent pas chez le prestataire).
    decision: Decision | None = Field(default=None, sa_type=String(10))
    decided_at: datetime | None = Field(default=None, sa_type=UtcDateTime)
    # Recopiés depuis BigQuery `rule_runs` par la synchronisation (sync_runs, services/rules.py). En
    # production, inactive et remplacée s'en déduisent (derive_status, services/rules.py).
    airflow_dag_id: str | None = Field(default=None, max_length=200)
    first_run_at: datetime | None = Field(default=None, sa_type=UtcDateTime)
    last_run_at: datetime | None = Field(default=None, sa_type=UtcDateTime)


class RuleVersionOut(RuleVersionBase):
    status: RuleStatus
    owner_matricule: str
    owner_name: str
    submitted_by_name: str
    decided_by_name: str | None = None
    # Tourne en parallèle de la version en production, en test, jusqu'à la décision.
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


class NameAvailable(Model):
    available: bool


# ---------- tables ----------


class Rule(SQLModel, table=True):
    __tablename__ = "rules"

    rule_id: str = Field(primary_key=True, max_length=36)
    owner_matricule: str = Field(max_length=6, foreign_key="users.matricule")
    created_at: datetime = Field(sa_type=UtcDateTime)
    # Nom de la version courante, normalisé, pour l'unicité (F1).
    name_key: str = Field(max_length=200, unique=True)

    versions: list["RuleVersion"] = Relationship(
        back_populates="rule",
        sa_relationship_kwargs={"order_by": "RuleVersion.version", "cascade": "all, delete-orphan"},
    )


class RuleVersion(RuleVersionBase, table=True):
    """Version publiée : contenu (RuleInput), soumission, décision et exécutions (RuleVersionBase)."""

    __tablename__ = "rule_versions"
    __table_args__ = (UniqueConstraint("rule_id", "version"),)

    id: int | None = Field(default=None, primary_key=True)
    decided_by: str | None = Field(default=None, max_length=6)

    rule: Rule = Relationship(back_populates="versions")


# ============================================================================================================
# Brouillons personnels
# ============================================================================================================
# Brouillons personnels : table et formats d'API.


class DraftIn(RuleInput):
    rule_id: str | None = None  # règle existante dont on prépare une nouvelle version


class DraftBase(RuleInput):
    """Champs d'un brouillon communs à la table `drafts` et à l'API : le contenu (RuleInput) et sa cible."""

    id: str = Field(primary_key=True, max_length=36)
    # Règle visée. Pour une nouvelle règle, identifiant réservé : la règle est créée à la soumission.
    rule_id: str = Field(max_length=36)
    # Version de départ (None : nouvelle règle).
    base_version: int | None = None
    created_at: datetime = Field(sa_type=UtcDateTime)
    updated_at: datetime = Field(sa_type=UtcDateTime)


class DraftOut(DraftBase):
    """Brouillon personnel (visible de son seul auteur)."""

    new_rule: bool  # la règle n'existe pas encore dans le référentiel
    latest_version: int | None = None  # dernière version soumise de la règle, pour signaler un décalage
    withdrawn: bool = False  # vient d'être créé en retirant une soumission
    last_test: TestRecord | None = None
    tests: list[TestRecord] = []


class Draft(DraftBase, table=True):
    """Brouillon personnel : la sauvegarde de travail d'un analyste, comme son profil.

    Visible de lui seul, jamais publié dans `rules_registry`. Il devient une version de règle
    (et la règle entre dans le référentiel partagé) au moment de la soumission.
    """

    __tablename__ = "drafts"
    __table_args__ = (UniqueConstraint("matricule", "rule_id"),)

    matricule: str = Field(max_length=6, foreign_key="users.matricule", index=True)


# ============================================================================================================
# Indicateurs de performance (données BigQuery)
# ============================================================================================================
# Indicateurs de performance : formats d'API (les données vivent dans BigQuery).


class DailyPerformance(Model):
    date: date
    rule_version: int | None = None  # version qui a tourné ce jour-là
    orders_flagged: int
    orders_to_send: int = 0  # dont marquées à transmettre au prestataire (version en production)
    orders_processed: int
    orders_confirmed_fraud: int
    # Commandes pertinentes (fraudes avérées et commandes risquées) : pertinence = relevant / processed.
    orders_relevant: int = 0


class VersionPerformance(Model):
    """Indicateurs cumulés d'une version sur toute sa période d'exécution (comparaison des versions)."""

    version: int
    first_date: date
    last_date: date
    days: int
    orders_flagged: int
    orders_processed: int
    orders_confirmed_fraud: int
    # Commandes pertinentes (fraudes avérées et commandes risquées) : pertinence = relevant / processed.
    orders_relevant: int = 0


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
    """Commandes d'une version un jour donné, en production (to_send) ou en test : une courbe par
    version, pleine en production, hachurée en test."""

    date: date
    rule_version: int
    to_send: bool
    orders_flagged: int
    orders_processed: int
    orders_confirmed_fraud: int
    # Commandes pertinentes (fraudes avérées et commandes risquées) : pertinence = relevant / processed.
    orders_relevant: int = 0


class PeriodTotals(Model):
    """Chiffres d'une règle sur une période, en commandes distinctes : exacts même si deux versions ont
    remonté la même commande (la somme des jours peut la compter deux fois)."""

    orders_flagged: int
    orders_to_send: int
    orders_processed: int
    orders_confirmed_fraud: int
    # Commandes pertinentes (fraudes avérées et commandes risquées) : pertinence = relevant / processed.
    orders_relevant: int = 0
    orders_observed: int = 0  # commandes remontées en test (candidate comprise)


class PerformanceResponse(Model):
    rule_id: str
    from_: date = Field(alias="from")
    to: date
    daily: list[DailyPerformance]
    previous: list[DailyPerformance]
    totals: PeriodTotals | None = None
    previous_totals: PeriodTotals | None = None
    # Une ligne par jour, version et état (production / test) : la courbe par version.
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
    orders_relevant30d: int = Field(0, alias="ordersRelevant30d")
    orders_to_send30d: int = Field(0, alias="ordersToSend30d")


# ============================================================================================================
# Alertes remontées et verdicts (données BigQuery)
# ============================================================================================================
# Alertes remontées et leur qualification : formats d'API (les données vivent dans BigQuery).

# ---------------------------------------------------------------------------
# Alertes remontées et qualification par les analystes
# ---------------------------------------------------------------------------
AlertPhase = Literal["TEST", "PRODUCTION"]

# Qualification d'une commande en test par un analyste : fraude avérée, commande risquée ou RAS.
ReviewVerdict = Literal["FRAUD", "RISKY", "NOT_FRAUD"]

# Verdict effectif d'une alerte : celui du prestataire s'il l'a vérifiée (FRAUD ou NOT_FRAUD) ; sinon, en
# test, la qualification de l'analyste (TO_REVIEW tant qu'il n'y en a pas) ; en production, en attente du
# prestataire (PENDING).
AlertVerdict = Literal["FRAUD", "RISKY", "NOT_FRAUD", "TO_REVIEW", "PENDING"]


class AlertReviewOut(Model):
    verdict: ReviewVerdict
    by_matricule: str
    by_name: str
    at: datetime


class AlertOut(Model):
    order_id: str
    rule_id: str
    rule_name: str
    rule_version: int
    run_date: date
    detected_at: datetime
    phase: AlertPhase
    verdict: AlertVerdict
    # Verdict du prestataire (commande vérifiée), à défaut None.
    provider_is_fraud: bool | None = None
    review: AlertReviewOut | None = None
    # Autres colonnes renvoyées par la règle pour cette commande (rule_alerts.details).
    details: dict[str, Any] | None = None


class RuleCount(Model):
    """Alertes d'une règle dans une phase : ses versions en test, ou sa version en production."""

    rule_id: str
    rule_name: str
    phase: AlertPhase
    count: int


class VerdictCount(Model):
    verdict: AlertVerdict
    count: int


class AlertPage(Model):
    """Une page d'alertes, et les nombres qui guident les filtres (sur la période et la recherche) : on ne
    propose que des choix qui renvoient des alertes."""

    items: list[AlertOut]
    total: int
    # Alertes en test pas encore qualifiées, pour la règle choisie.
    to_review: int
    # Alertes par règle et par phase, quelles que soient la règle et la phase choisies : le filtre propose les
    # règles en test puis les règles en production (les plus nombreuses d'abord dans chaque groupe).
    rules: list[RuleCount] = []
    # Alertes par verdict, pour la règle et la phase choisies.
    verdicts: list[VerdictCount] = []


class AlertReviewIn(Model):
    order_id: str
    rule_id: str
    rule_version: int
    # Fraude avérée, commande risquée ou RAS ; None : retirer la qualification.
    verdict: ReviewVerdict | None


# Toutes les tables, enregistrées sur une seule métadonnée (Alembic, tests).
metadata = SQLModel.metadata
