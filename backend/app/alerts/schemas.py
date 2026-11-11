"""Schémas d'échange des alertes et de leur qualification."""

from datetime import date, datetime
from typing import Literal

from app.core.schemas import Model

# ---------------------------------------------------------------------------
# Alertes remontées et qualification par les analystes
# ---------------------------------------------------------------------------
AlertPhase = Literal["TEST", "PRODUCTION"]

# Verdict effectif d'une alerte : celui du prestataire s'il l'a vérifiée ; sinon, en test, la qualification
# de l'analyste (TO_REVIEW tant qu'il n'y en a pas) ; en production, en attente du prestataire (PENDING).
AlertVerdict = Literal["FRAUD", "NOT_FRAUD", "TO_REVIEW", "PENDING"]


class AlertReviewOut(Model):
    is_fraud: bool
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
    details: dict | None = None


class AlertPage(Model):
    items: list[AlertOut]
    total: int
    # Alertes en test pas encore qualifiées, avec les mêmes filtres (hors filtre de verdict).
    to_review: int


class AlertReviewIn(Model):
    order_id: str
    rule_id: str
    rule_version: int
    # Vrai : fraude ; faux : pas une fraude ; None : retirer la qualification.
    is_fraud: bool | None
