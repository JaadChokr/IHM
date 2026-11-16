"""Utilisateurs et sessions (le matricule est la clé d'identité, PRD §5.4)."""

from datetime import datetime

from sqlmodel import Field, SQLModel

from app.auth.schemas import UserBase
from app.core.schemas import UtcDateTime


class User(UserBase, table=True):
    __tablename__ = "users"

    created_at: datetime = Field(sa_type=UtcDateTime)

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}"


class UserSession(SQLModel, table=True):
    __tablename__ = "sessions"

    token_hash: str = Field(primary_key=True, max_length=64)
    matricule: str = Field(max_length=6, index=True)
    # Vrai tant que nom et prénom n'ont pas été saisis (première connexion).
    pending_profile: bool = False
    last_seen: datetime = Field(sa_type=UtcDateTime)
