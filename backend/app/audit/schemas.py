"""Schémas d'échange du journal d'audit."""

from datetime import datetime

from app.core.schemas import Model


class AuditEventOut(Model):
    id: str
    at: datetime
    matricule: str
    user_name: str
    action: str
    rule_id: str | None = None
    rule_name: str | None = None
    version: int | None = None
    details: str | None = None
