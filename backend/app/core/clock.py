"""Horloge (UTC) : un seul point pour la date courante."""

from datetime import UTC, datetime


def now() -> datetime:
    return datetime.now(UTC)


def as_utc(dt: datetime) -> datetime:
    """SQLite rend des datetimes naïfs ; PostgreSQL des datetimes aware."""
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)
