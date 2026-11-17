"""Contrat de la passerelle BigQuery : interface, types échangés, erreurs."""

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Protocol

from app.core.periods import Period
from app.performance.models import DailyPerformance, RuleRun, VersionDaily, VersionPerformance
from app.query.models import Column
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
    versions n'est comptée qu'une fois) : remontées, envoyées (to_send), vérifiées, fraudes avérées,
    pertinentes (fraudes avérées et commandes risquées)."""

    rule_id: str
    flagged: int
    processed: int
    confirmed: int
    to_send: int = 0
    observed: int = 0
    relevant: int = 0


@dataclass
class AlertFilter:
    start: date
    end: date
    rule_id: str | None = None
    phase: str | None = None  # TEST | PRODUCTION
    verdict: str | None = None  # FRAUD | RISKY | NOT_FRAUD | TO_REVIEW | PENDING
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
    review_verdict: str | None = None  # dernière qualification : FRAUD | RISKY | NOT_FRAUD
    reviewed_by: str | None = None
    reviewed_at: datetime | None = None
    details: dict | None = None


@dataclass
class AlertResult:
    """Une page d'alertes et les nombres qui guident les filtres (facettes), sur la période et la recherche :
    - `rules` : alertes par règle et par phase, clé (rule_id, TEST | PRODUCTION), quels que soient la règle et
      la phase choisies (le choix de la règle se fait dans ces deux groupes) ;
    - `verdicts` : alertes par verdict, pour la règle et la phase choisies ;
    - `to_review` : alertes en test encore à qualifier, pour la règle choisie (toutes phases)."""

    items: list[AlertRow]
    total: int
    to_review: int = 0
    rules: dict[tuple[str, str], int] = field(default_factory=dict)
    verdicts: dict[str, int] = field(default_factory=dict)


def verdict_of(to_send: bool, provider_is_fraud: bool | None, has_feedback: bool, review: str | None) -> str:
    """Verdict effectif d'une alerte : le prestataire s'il l'a vérifiée ; sinon, en production, en attente du
    prestataire ; en test, la qualification de l'analyste (fraude avérée, commande risquée ou RAS ;
    à qualifier tant qu'il n'y en a pas)."""
    if has_feedback:
        return "FRAUD" if provider_is_fraud else "NOT_FRAUD"
    if to_send:
        return "PENDING"
    return review or "TO_REVIEW"


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

    def alerts(self, f: AlertFilter) -> AlertResult:
        """Alertes de la période (les plus récentes d'abord), avec les nombres qui guident les filtres."""
        ...

    def add_review(self, order_id: str, rule_id: str, version: int, verdict: str | None, by: str) -> bool:
        """Qualifie une commande (alert_reviews) : FRAUD, RISKY, NOT_FRAUD, ou None pour retirer la
        qualification. Faux si ce n'est pas une alerte en test de cette version."""
        ...

    def set_registry(self, rule: Rule, rows: list[tuple[RuleVersion, str, bool]]) -> None:
        """Aligne les lignes de la règle dans `rules_registry` : une par version qu'Airflow exécute, donnée
        par (version, statut, send_to_provider). Les lignes des autres versions de la règle sont
        supprimées ; une liste vide retire la règle du registre."""
        ...
