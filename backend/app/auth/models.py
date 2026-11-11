"""Utilisateurs et sessions (le matricule est la clé d'identité, PRD §5.4)."""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    String,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class User(Base):
    __tablename__ = "users"

    matricule: Mapped[str] = mapped_column(String(6), primary_key=True)
    first_name: Mapped[str] = mapped_column(String(100))
    last_name: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}"


class UserSession(Base):
    __tablename__ = "sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    matricule: Mapped[str] = mapped_column(String(6), index=True)
    # Vrai tant que nom et prénom n'ont pas été saisis (première connexion).
    pending_profile: Mapped[bool] = mapped_column(Boolean, default=False)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True))
