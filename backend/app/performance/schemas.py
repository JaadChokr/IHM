"""Schémas d'échange des indicateurs de performance."""

from datetime import date, datetime
from typing import Literal

from pydantic import Field

from app.core.schemas import Model
from app.rules.types import Criticality, RuleStatus


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
    """Commandes d'une version un jour donné, en production (to_send) ou en test : une courbe par
    version, pleine en production, hachurée en test."""

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
    orders_to_send30d: int = Field(0, alias="ordersToSend30d")
