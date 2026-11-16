"""Journal d'audit, en ajout seul (immuable, conservation 24 mois) : table et format d'API.

La table `audit_events` a exactement les champs renvoyés par l'API : elle hérite de `AuditEventOut`.
"""

from datetime import datetime
from typing import Literal

from sqlalchemy import String, Text
from sqlmodel import Field

from app.core.models import Model, UtcDateTime

# Actions tracées dans le journal (les anciennes valeurs RULE_CREATE, RULE_UPDATE, RULE_NEW_VERSION restent
# lisibles : le journal est immuable).
AuditAction = Literal[
    "LOGIN",
    "PROFILE_UPDATE",
    "RULE_CREATE",
    "RULE_UPDATE",
    "RULE_NEW_VERSION",
    "RULE_TEST",
    "RULE_SUBMIT",
    "RULE_WITHDRAW",
    "RULE_SEND_TO_PROVIDER",
    "RULE_SUSPEND_SENDING",
    "RULE_DISCARD",
    "ALERT_REVIEW",
]


class AuditEventOut(Model):
    id: str = Field(primary_key=True, max_length=36)
    at: datetime = Field(sa_type=UtcDateTime, index=True)
    matricule: str = Field(max_length=6, index=True)
    user_name: str = Field(max_length=200)
    action: AuditAction = Field(sa_type=String(30))
    rule_id: str | None = Field(default=None, max_length=36, index=True)
    rule_name: str | None = Field(default=None, max_length=200)
    version: int | None = None
    details: str | None = Field(default=None, sa_type=Text)


class AuditEvent(AuditEventOut, table=True):
    __tablename__ = "audit_events"
