"""Métadonnées des tests de requête (jamais les lignes retournées, PRD §10)."""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class TestRun(Base):
    """Métadonnées d'un test (F3). Jamais les lignes retournées (PRD §10)."""

    __tablename__ = "rule_tests"
    __test__ = False  # pas une classe de test pytest

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    rule_id: Mapped[str | None] = mapped_column(String(36), index=True)
    version: Mapped[int | None] = mapped_column(Integer)
    # Test d'un brouillon : rattaché à la version créée lors de sa soumission.
    draft_id: Mapped[str | None] = mapped_column(String(36), index=True)
    query_hash: Mapped[str] = mapped_column(String(16))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    by_matricule: Mapped[str] = mapped_column(String(6), index=True)
    phase: Mapped[str] = mapped_column(String(10))  # DRY_RUN | EXECUTION
    success: Mapped[bool] = mapped_column(Boolean)
    bytes_processed: Mapped[int | None] = mapped_column(BigInteger)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    total_rows: Mapped[int | None] = mapped_column(BigInteger)
    error: Mapped[str | None] = mapped_column(Text)
