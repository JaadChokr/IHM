"""Tous les modèles SQLAlchemy, pour qu'ils soient enregistrés sur `Base.metadata` (Alembic, tests).

Chaque fonctionnalité déclare ses tables dans son propre `models.py` ; ce module les importe toutes.
"""

from app.audit.models import AuditEvent
from app.auth.models import User, UserSession
from app.core.db import Base
from app.drafts.models import Draft
from app.query.models import TestRun
from app.rules.models import Rule, RuleVersion

__all__ = ["AuditEvent", "Base", "Draft", "Rule", "RuleVersion", "TestRun", "User", "UserSession"]
