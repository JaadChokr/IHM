"""Consultation du journal d'audit (F8)."""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.models import AuditEvent
from app.audit.schemas import AuditEventOut
from app.auth.models import User
from app.auth.service import get_current_user
from app.core.db import get_db

router = APIRouter(tags=["audit"])


@router.get("/audit", response_model=list[AuditEventOut])
def list_audit(
    ruleId: str | None = None,  # noqa: N803 — nom du paramètre attendu par le front
    matricule: str | None = None,
    limit: int = 500,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    q = select(AuditEvent).order_by(AuditEvent.at.desc()).limit(min(limit, 2000))
    if ruleId:
        q = q.where(AuditEvent.rule_id == ruleId)
    if matricule:
        q = q.where(AuditEvent.matricule == matricule)
    return db.scalars(q).all()
