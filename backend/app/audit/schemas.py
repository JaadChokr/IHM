"""Schémas d'échange du journal d'audit."""

from datetime import datetime
from typing import Literal

from app.core.schemas import Model

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
    id: str
    at: datetime
    matricule: str
    user_name: str
    action: AuditAction
    rule_id: str | None = None
    rule_name: str | None = None
    version: int | None = None
    details: str | None = None
