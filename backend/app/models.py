"""Toutes les tables, pour qu'elles soient enregistrées sur `SQLModel.metadata` (Alembic, tests).

Chaque fonctionnalité déclare ses tables dans son propre `models.py` ; ce module les importe toutes.
"""

from sqlmodel import SQLModel

from app.audit.models import AuditEvent
from app.auth.models import User, UserSession
from app.drafts.models import Draft
from app.query.models import TestRun
from app.rules.models import Rule, RuleVersion

metadata = SQLModel.metadata

__all__ = ["AuditEvent", "Draft", "Rule", "RuleVersion", "TestRun", "User", "UserSession", "metadata"]
