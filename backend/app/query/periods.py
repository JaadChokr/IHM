"""Période d'exécution d'une règle : les valeurs de @period_start / @period_end.

Fréquence = une unité (HOURLY, DAILY, WEEKLY : le DAG Airflow qui l'exécute) et un pas (`every`) : « toutes
les 2 heures », « tous les 3 jours ». Chaque DAG se déclenche à chaque unité (cron ci-dessous, heure de
Paris) ; une règle n'y tourne que les déclenchements où elle est « due », et sa période va du déclenchement
dû précédent à celui-ci. Calage fixe, pour des heures d'exécution prévisibles :
  - heures : comptées depuis minuit (pas diviseur de 24) : toutes les 2 h = 0 h 05, 2 h 05, 4 h 05… ;
  - jours : comptés depuis ANCHOR ; semaines : comptées depuis ANCHOR (un lundi).

Au test, la plateforme prend la dernière période complète de ce calendrier : la requête testée voit ce que
verrait le dernier run. Calendrier à garder aligné sur infra/airflow/fraud_rules_dags.py (SCHEDULES, _due,
_period_start) et frontend/src/lib/period.ts.
"""

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Paris")
PARAMS = ("period_start", "period_end")
ANCHOR = date(2026, 1, 5)  # un lundi : origine du calage des jours et des semaines
# Pas autorisés par unité. Heures : diviseurs de 24, pour des heures d'exécution identiques chaque jour.
EVERY = {"HOURLY": (1, 2, 3, 4, 6, 8, 12), "DAILY": tuple(range(1, 31)), "WEEKLY": tuple(range(1, 13))}
UNIT = {"HOURLY": timedelta(hours=1), "DAILY": timedelta(days=1), "WEEKLY": timedelta(weeks=1)}


@dataclass(frozen=True)
class Period:
    start: datetime  # inclus
    end: datetime  # exclu


def valid_every(schedule: str, every: int) -> bool:
    return every in EVERY.get(schedule, ())


def _local(t: datetime) -> datetime:
    return t.astimezone(TZ)


def _from_wall(wall: datetime) -> datetime:
    return wall.replace(tzinfo=TZ).astimezone(UTC)


def is_due(schedule: str, every: int, tick: datetime) -> bool:
    """La règle tourne-t-elle à ce déclenchement du DAG de son unité ?"""
    local = _local(tick)
    if schedule == "HOURLY":
        return local.hour % every == 0
    days = (local.date() - ANCHOR).days
    return (days // 7 if schedule == "WEEKLY" else days) % every == 0


def _prev_tick(schedule: str, tick: datetime) -> datetime:
    """Déclenchement précédent du DAG. Heures : une heure réelle avant (changements d'heure compris) ;
    jours et semaines : même heure murale, la veille ou la semaine d'avant."""
    if schedule == "HOURLY":
        # En UTC : l'arithmétique d'un datetime local est murale (fausse aux changements d'heure).
        return tick.astimezone(UTC) - timedelta(hours=1)
    wall = _local(tick).replace(tzinfo=None) - UNIT[schedule]
    return _from_wall(wall)


def period_start(schedule: str, every: int, end: datetime) -> datetime:
    """Début de la période d'un run dû à `end` : le déclenchement dû précédent (pas de trou ni de
    chevauchement, même aux changements d'heure)."""
    t = _prev_tick(schedule, end)
    while not is_due(schedule, every, t):
        t = _prev_tick(schedule, t)
    return t


def _last_tick(schedule: str, local: datetime) -> datetime:
    """Dernier déclenchement du DAG à `local` ou avant (heure murale de Paris)."""
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


def last_period(schedule: str, at: datetime, every: int = 1) -> Period:
    """Dernière période complète à `at` pour cette fréquence (DAILY par défaut)."""
    if schedule not in UNIT:
        schedule = "DAILY"
    if not valid_every(schedule, every):
        every = 1
    end = _from_wall(_last_tick(schedule, _local(at).replace(tzinfo=None)))
    while not is_due(schedule, every, end):
        end = _prev_tick(schedule, end)
    return Period(period_start(schedule, every, end), end)
