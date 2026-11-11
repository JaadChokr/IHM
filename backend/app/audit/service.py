"""Écriture dans le journal d'audit."""

import uuid

from sqlalchemy.orm import Session

from app.audit.models import AuditEvent
from app.auth.models import User
from app.core.clock import now
from app.rules.models import RuleVersion


def record_audit(
    db: Session, user: User, action: str, version: RuleVersion | None = None, details: str | None = None
) -> None:
    """Ajoute un événement au journal (jamais de mise à jour ni de suppression)."""
    db.add(
        AuditEvent(
            id=str(uuid.uuid4()),
            at=now(),
            matricule=user.matricule,
            user_name=user.full_name,
            action=action,
            rule_id=version.rule_id if version else None,
            rule_name=version.name if version else None,
            version=version.version if version else None,
            details=details,
        )
    )
