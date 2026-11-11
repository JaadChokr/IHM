"""Brouillons personnels."""

from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class Draft(Base):
    """Brouillon personnel : la sauvegarde de travail d'un analyste, comme son profil.

    Visible de lui seul, jamais publié dans `rules_registry`. Il devient une version de règle
    (et la règle entre dans le référentiel partagé) au moment de la soumission.
    """

    __tablename__ = "drafts"
    __table_args__ = (UniqueConstraint("matricule", "rule_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    matricule: Mapped[str] = mapped_column(String(6), ForeignKey("users.matricule"), index=True)
    # Règle visée. Pour une nouvelle règle, identifiant réservé : la règle est créée à la soumission.
    rule_id: Mapped[str] = mapped_column(String(36))
    # Version de départ (None : nouvelle règle).
    base_version: Mapped[int | None] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text)
    fraud_typology: Mapped[str] = mapped_column(String(100))
    criticality: Mapped[str] = mapped_column(String(10))
    schedule: Mapped[str] = mapped_column(String(10))
    schedule_every: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    sql_query: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
