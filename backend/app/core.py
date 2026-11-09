"""Socle : configuration, erreurs métier, horloge."""

from datetime import UTC, datetime
from functools import lru_cache
from typing import Literal

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuration par variables d'environnement (préfixe RM_).

    Secrets injectés depuis Secret Manager en variables d'environnement (PRD §10).
    """

    model_config = SettingsConfigDict(env_prefix="RM_", env_file=".env", extra="ignore")

    env: Literal["local", "test", "prod"] = "local"
    database_url: str = "postgresql+psycopg://rules:rules@localhost:5432/rules"

    # BigQuery : "fake" pour développer sans GCP, "real" sinon.
    bigquery_mode: Literal["fake", "real"] = "fake"
    gcp_project: str = ""
    bq_dataset: str = "fraud_rules"
    # Table de retour du prestataire (dataset.table), lue par la vue v_rule_performance (PRD Q2).
    # Utilisée par infra/bigquery/apply.sh / apply.ps1 pour créer la vue.
    bq_feedback_table: str = ""
    bq_location: str = "europe-west9"

    # Garde-fous F3 — réglables sans redéploiement (PRD R4).
    max_bytes_billed: int = 50 * 10**9
    job_timeout_ms: int = 60_000
    max_results: int = 100

    # Session F8
    session_ttl_hours: int = 8
    session_cookie: str = "rm_session"
    cookie_secure: bool = True

    # Test : commandes déjà remontées par une autre règle, cherchées dans rule_alerts sur cette période.
    overlap_days: int = 90

    # Notification équipe data (PRD Q6) : vide = journalisation seule.
    notify_webhook_url: str = ""

    cors_origins: list[str] = ["http://localhost:5173"]


@lru_cache
def get_settings() -> Settings:
    return Settings()


class ApiError(Exception):
    """Erreur métier : sérialisée en {detail, code}, format lu par le front."""

    def __init__(self, status: int, detail: str, code: str | None = None):
        self.status = status
        self.detail = detail
        self.code = code


async def api_error_handler(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ApiError)
    return JSONResponse({"detail": exc.detail, "code": exc.code}, status_code=exc.status)


def now() -> datetime:
    return datetime.now(UTC)


def as_utc(dt: datetime) -> datetime:
    """SQLite rend des datetimes naïfs ; PostgreSQL des datetimes aware."""
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)
