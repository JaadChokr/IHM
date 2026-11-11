"""Contrat de la passerelle BigQuery : interface, types échangés, erreurs."""

import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Protocol

from app.performance.schemas import DailyPerformance, RuleRun, VersionDaily, VersionPerformance
from app.query.periods import Period
from app.query.schemas import Column
from app.rules.models import Rule, RuleVersion


class QueryError(Exception):
    """Erreur BigQuery, avec la position (ligne, colonne) quand le message la donne."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message
        m = re.search(r"at \[(\d+):(\d+)\]", message)
        self.line = int(m.group(1)) if m else None
        self.column = int(m.group(2)) if m else None


class BytesLimitExceeded(Exception):
    pass


@dataclass
class DryRunMeta:
    statement_type: str
    bytes_processed: int
    schema: list[Column]


@dataclass
class Overlap:
    """Commandes du test et celles déjà remontées par d'autres règles (table `rule_alerts`)."""

    orders: int  # commandes distinctes renvoyées par la requête
    already_flagged: int | None  # dont déjà remontées par une autre règle ; None si rule_alerts illisible


@dataclass
class ExecMeta:
    columns: list[str]
    rows: list[dict[str, Any]]
    total_rows: int
    duration_ms: int
    bytes_processed: int
    overlap: Overlap


@dataclass
class RunStats:
    """Synthèse des exécutions Airflow d'une version de règle (table `rule_runs`)."""

    rule_id: str
    rule_version: int
    first_run_at: datetime
    last_run_at: datetime
    dag_id: str | None


@dataclass
class ProductionTotals:
    """Chiffres d'une règle sur une période, en commandes distinctes (une commande remontée par deux
    versions n'est comptée qu'une fois) : remontées, envoyées (to_send), traitées, confirmées."""

    rule_id: str
    flagged: int
    processed: int
    confirmed: int
    to_send: int = 0
    observed: int = 0


@dataclass
class AlertFilter:
    start: date
    end: date
    rule_id: str | None = None
    phase: str | None = None  # TEST | PRODUCTION
    verdict: str | None = None  # FRAUD | NOT_FRAUD | TO_REVIEW | PENDING
    q: str | None = None  # recherche dans le numéro de commande
    limit: int = 25
    offset: int = 0


@dataclass
class AlertRow:
    """Une alerte (ligne de rule_alerts) avec le retour du prestataire et la dernière qualification."""

    order_id: str
    rule_id: str
    rule_version: int
    run_date: date
    detected_at: datetime
    to_send: bool
    verdict: str
    provider_is_fraud: bool | None = None
    review_is_fraud: bool | None = None
    reviewed_by: str | None = None
    reviewed_at: datetime | None = None
    details: dict | None = None


def verdict_of(to_send: bool, provider_is_fraud: bool | None, has_feedback: bool, review: bool | None) -> str:
    """Verdict effectif d'une alerte : le prestataire s'il l'a vérifiée ; sinon, en production, en attente du
    prestataire ; en test, la qualification de l'analyste (à qualifier tant qu'il n'y en a pas)."""
    if has_feedback:
        return "FRAUD" if provider_is_fraud else "NOT_FRAUD"
    if to_send:
        return "PENDING"
    if review is None:
        return "TO_REVIEW"
    return "FRAUD" if review else "NOT_FRAUD"


class BigQueryGateway(Protocol):
    def dry_run(self, sql: str, period: Period) -> DryRunMeta:
        """`period` : valeurs de @period_start / @period_end (toujours fournies, utilisées ou non)."""
        ...

    def execute(
        self, sql: str, period: Period, exclude_rule_id: str | None = None, overlap_days: int = 90
    ) -> ExecMeta:
        """Exécute la requête (échantillon) et compte ses commandes déjà remontées par une autre règle
        que `exclude_rule_id` dans `rule_alerts` sur `overlap_days` jours."""
        ...

    def daily_performance(
        self, rule_id: str, start: date, end: date, sent: bool = False
    ) -> list[DailyPerformance]:
        """Chiffres quotidiens d'une règle : ses commandes à transmettre (`sent`, règle en production) ou
        ses commandes en test (règle en test)."""
        ...

    def runs(self, rule_id: str, start: date, end: date, limit: int = 20) -> list[RuleRun]: ...

    def version_totals(self, rule_id: str) -> list[VersionPerformance]: ...

    def version_daily(self, rule_id: str, start: date, end: date) -> list[VersionDaily]:
        """Commandes de chaque version, par jour et par état (production / test)."""
        ...

    def production_totals(self, rules: dict[str, bool], start: date, end: date) -> list[ProductionTotals]:
        """Totaux de chaque règle sur la période, `rules` : rule_id → en production ?"""
        ...

    def run_stats(self) -> list[RunStats]: ...

    def alerts(self, f: AlertFilter) -> tuple[list[AlertRow], int, int]:
        """Alertes de la période (les plus récentes d'abord) : (page, total, à qualifier)."""
        ...

    def add_review(self, order_id: str, rule_id: str, version: int, is_fraud: bool | None, by: str) -> bool:
        """Qualifie une commande (alert_reviews). Faux si ce n'est pas une alerte en test de cette version."""
        ...

    def set_registry(self, rule: Rule, rows: list[tuple[RuleVersion, str, bool]]) -> None:
        """Aligne les lignes de la règle dans `rules_registry` : une par version qu'Airflow exécute, donnée
        par (version, statut, send_to_provider). Les lignes des autres versions de la règle sont
        supprimées ; une liste vide retire la règle du registre."""
        ...
