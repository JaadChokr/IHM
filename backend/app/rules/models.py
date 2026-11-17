"""Règles et leurs versions (toute version est publiée ; les brouillons sont à part) : tables et formats
d'API.

`RuleInput` est le contenu éditable d'une règle : la version publiée (`RuleVersion`), le brouillon (`Draft`)
et leurs formats d'API en héritent, si bien que chaque champ n'est déclaré qu'une fois.
"""

from datetime import datetime
from typing import Literal

from pydantic import model_validator
from sqlalchemy import String, Text, UniqueConstraint
from sqlmodel import Field, Relationship, SQLModel

from app.core.models import Model, UtcDateTime
from app.core.periods import Schedule, check_every
from app.query.models import TestRecord

# Statut d'une version de règle (toujours publiée : les brouillons sont à part, voir DraftOut).
# Publiée, elle est en test d'office (Airflow l'exécute à sa prochaine échéance, rien n'est envoyé au
# prestataire) → en production (envoyée au prestataire) ; inactive, remplacée ou écartée sinon. Qu'elle
# ait déjà tourné se lit dans first_run_at.
RuleStatus = Literal["OBSERVATION", "IN_PRODUCTION", "INACTIVE", "REPLACED", "DISCARDED"]

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
    # Recopiés depuis BigQuery `rule_runs` par la synchronisation (rules.sync_runs). En production,
    # inactive et remplacée s'en déduisent, voir rules.derive_status.
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
