"""Alertes remontées et leur qualification : formats d'API (les données vivent dans BigQuery)."""

from datetime import date, datetime
from typing import Any, Literal

from app.core.models import Model

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


class PhaseCount(Model):
    phase: AlertPhase
    count: int


class RuleCount(Model):
    rule_id: str
    rule_name: str
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
    # Alertes par phase, pour la règle choisie.
    phases: list[PhaseCount] = []
    # Alertes par règle, dans la phase choisie (les plus nombreuses d'abord).
    rules: list[RuleCount] = []
    # Alertes par verdict, pour la règle et la phase choisies.
    verdicts: list[VerdictCount] = []


class AlertReviewIn(Model):
    order_id: str
    rule_id: str
    rule_version: int
    # Fraude avérée, commande risquée ou RAS ; None : retirer la qualification.
    verdict: ReviewVerdict | None
