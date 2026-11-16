"""Formats d'échange des règles, et bases communes des tables `rule_versions` et `drafts`.

`RuleInput` est le contenu éditable d'une règle : la version publiée (`RuleVersion`), le brouillon (`Draft`)
et leurs formats d'API en héritent, si bien que chaque champ n'est déclaré qu'une fois.
"""

from datetime import datetime
from typing import Literal

from pydantic import model_validator
from sqlalchemy import String, Text
from sqlmodel import Field

from app.core.schemas import Model, UtcDateTime
from app.query.schemas import TestRecord
from app.rules.types import Criticality, Decision, RuleStatus, Schedule, check_every


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
