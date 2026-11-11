"""Règles et leurs versions (toute version est publiée ; les brouillons sont à part)."""

from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base


class Rule(Base):
    __tablename__ = "rules"

    rule_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_matricule: Mapped[str] = mapped_column(String(6), ForeignKey("users.matricule"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # Nom de la version courante, normalisé, pour l'unicité (F1).
    name_key: Mapped[str] = mapped_column(String(200), unique=True)

    versions: Mapped[list["RuleVersion"]] = relationship(
        back_populates="rule", order_by="RuleVersion.version", cascade="all, delete-orphan"
    )


class RuleVersion(Base):
    __tablename__ = "rule_versions"
    __table_args__ = (UniqueConstraint("rule_id", "version"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    rule_id: Mapped[str] = mapped_column(String(36), ForeignKey("rules.rule_id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text)
    fraud_typology: Mapped[str] = mapped_column(String(100))
    criticality: Mapped[str] = mapped_column(String(10))
    schedule: Mapped[str] = mapped_column(String(10))
    schedule_every: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    sql_query: Mapped[str] = mapped_column(Text)
    # Toute version est soumise : les brouillons vivent dans `drafts`. En production, inactive et
    # remplacée se déduisent des exécutions Airflow (colonnes *_run_at), voir rules.derive_status.
    submitted_by: Mapped[str] = mapped_column(String(6), ForeignKey("users.matricule"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # Recopiés depuis BigQuery `rule_runs` par la synchronisation (rules.sync_runs).
    airflow_dag_id: Mapped[str | None] = mapped_column(String(200))
    first_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Décision de l'analyste après observation : SENT (envoyée au prestataire), DISCARDED (écartée),
    # ou NULL (en test : Airflow l'exécute, ses commandes ne partent pas chez le prestataire).
    decision: Mapped[str | None] = mapped_column(String(10))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_by: Mapped[str | None] = mapped_column(String(6))

    rule: Mapped[Rule] = relationship(back_populates="versions")
