"""Schémas d'échange des règles."""

from datetime import datetime
from typing import Literal

from pydantic import Field, model_validator

from app.core.schemas import Model
from app.query.schemas import TestRecord
from app.rules.types import Criticality, Decision, RuleStatus, Schedule, check_every


class RuleInput(Model):
    name: str = Field(max_length=200)
    description: str
    fraud_typology: str
    criticality: Criticality
    schedule: Schedule
    # Pas de la fréquence : toutes les `schedule_every` heures, jours ou semaines (periods.EVERY).
    schedule_every: int = 1
    sql_query: str

    @model_validator(mode="after")
    def _every(self):  # noqa: ANN202
        check_every(self.schedule, self.schedule_every)
        return self


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
