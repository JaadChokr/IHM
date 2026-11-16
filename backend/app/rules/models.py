"""Règles et leurs versions (toute version est publiée ; les brouillons sont à part)."""

from datetime import datetime

from sqlalchemy import UniqueConstraint
from sqlmodel import Field, Relationship, SQLModel

from app.core.schemas import UtcDateTime
from app.rules.schemas import RuleVersionBase


class Rule(SQLModel, table=True):
    __tablename__ = "rules"

    rule_id: str = Field(primary_key=True, max_length=36)
    owner_matricule: str = Field(max_length=6, foreign_key="users.matricule")
    created_at: datetime = Field(sa_type=UtcDateTime)
    # Nom de la version courante, normalisé, pour l'unicité (F1).
    name_key: str = Field(max_length=200, unique=True)

    versions: list["RuleVersion"] = Relationship(
        back_populates="rule",
        sa_relationship_kwargs={"order_by": "RuleVersion.version", "cascade": "all, delete-orphan"},
    )


class RuleVersion(RuleVersionBase, table=True):
    """Version publiée : contenu (RuleInput), soumission, décision et exécutions (RuleVersionBase)."""

    __tablename__ = "rule_versions"
    __table_args__ = (UniqueConstraint("rule_id", "version"),)

    id: int | None = Field(default=None, primary_key=True)
    decided_by: str | None = Field(default=None, max_length=6)

    rule: Rule = Relationship(back_populates="versions")
