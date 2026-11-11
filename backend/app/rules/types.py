"""Types communs aux règles : statut, décision, criticité, fréquence et son pas."""

from typing import Literal

from app.query.periods import EVERY, valid_every

# Statut d'une version de règle (toujours soumise : les brouillons sont à part, voir DraftOut).
# Soumise → en test (Airflow l'exécute, rien n'est envoyé au prestataire) → en production
# (envoyée au prestataire) ; inactive, remplacée ou écartée sinon.
RuleStatus = Literal["SUBMITTED", "OBSERVATION", "IN_PRODUCTION", "INACTIVE", "REPLACED", "DISCARDED"]

Decision = Literal["SENT", "DISCARDED"]

Criticality = Literal["HIGH", "MEDIUM", "LOW"]

Schedule = Literal["DAILY", "HOURLY", "WEEKLY"]


def check_every(schedule: str, every: int) -> None:
    if not valid_every(schedule, every):
        allowed = ", ".join(map(str, EVERY[schedule]))
        unit = {"HOURLY": "heures", "DAILY": "jours", "WEEKLY": "semaines"}[schedule]
        raise ValueError(f"Fréquence invalide : toutes les {every} {unit}. Valeurs possibles : {allowed}.")
