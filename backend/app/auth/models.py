"""Utilisateurs et sessions (le matricule est la clé d'identité, PRD §5.4) : tables et formats d'API."""

from datetime import datetime

from sqlmodel import Field, SQLModel

from app.core.models import Model, UtcDateTime

# ---------- formats d'API (UserBase est aussi la base de la table users) ----------


class UserBase(Model):
    matricule: str = Field(primary_key=True, max_length=6)
    first_name: str = Field(max_length=100)
    last_name: str = Field(max_length=100)


class UserOut(UserBase):
    pass


class LoginIn(Model):
    matricule: str


class LoginOut(Model):
    user: UserOut | None
    needs_profile: bool


class ProfileIn(Model):
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)


# ---------- tables ----------


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
