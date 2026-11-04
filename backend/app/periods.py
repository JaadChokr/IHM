"""Période d'exécution d'une règle : les valeurs de @period_start / @period_end.

En production, Airflow passe les bornes de la période du run (data_interval_start / data_interval_end),
calées sur le cron du DAG de la fréquence (heure de Paris). Au test, la plateforme prend la dernière
période complète de ce même calendrier : la requête testée voit ce que verrait le dernier run.

Les heures doivent rester alignées sur SCHEDULES dans infra/airflow/fraud_rules_dags.py.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Paris")
PARAMS = ("period_start", "period_end")


@dataclass(frozen=True)
class Period:
    start: datetime  # inclus
    end: datetime  # exclu


def _last_tick(schedule: str, local: datetime) -> datetime:
    """Dernier déclenchement du DAG à `local` ou avant (heure de Paris)."""
    if schedule == "HOURLY":  # cron « 5 * * * * »
        tick = local.replace(minute=5, second=0, microsecond=0)
        return tick if tick <= local else tick - timedelta(hours=1)
    hour, weekday = (4, 0) if schedule == "WEEKLY" else (3, None)  # « 0 4 * * 1 » / « 0 3 * * * »
    tick = local.replace(hour=hour, minute=0, second=0, microsecond=0)
    if weekday is not None:
        tick -= timedelta(days=(tick.weekday() - weekday) % 7)
    if tick > local:
        tick -= timedelta(days=7 if weekday is not None else 1)
    return tick


def last_period(schedule: str, at: datetime) -> Period:
    """Dernière période complète à `at` pour cette fréquence (DAILY par défaut)."""
    local = at.astimezone(TZ).replace(tzinfo=None)  # calcul en heure murale : gère les changements d'heure
    end = _last_tick(schedule, local)
    step = {"HOURLY": timedelta(hours=1), "WEEKLY": timedelta(weeks=1)}.get(schedule, timedelta(days=1))
    start = end - step
    return Period(start.replace(tzinfo=TZ).astimezone(UTC), end.replace(tzinfo=TZ).astimezone(UTC))
