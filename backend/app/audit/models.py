"""Journal d'audit, en ajout seul (immuable, conservation 24 mois)."""

from datetime import datetime

from sqlalchemy import (
    DateTime,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class AuditEvent(Base):
    """Journal d'audit, en ajout seul (immuable, conservation 24 mois)."""

    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    matricule: Mapped[str] = mapped_column(String(6), index=True)
    user_name: Mapped[str] = mapped_column(String(200))
    action: Mapped[str] = mapped_column(String(30))
    rule_id: Mapped[str | None] = mapped_column(String(36), index=True)
    rule_name: Mapped[str | None] = mapped_column(String(200))
    version: Mapped[int | None] = mapped_column(Integer)
    details: Mapped[str | None] = mapped_column(Text)
