"""Alertes remontées par les règles, et qualification par les analystes."""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.alerts.models import (
    AlertOut,
    AlertPage,
    AlertPhase,
    AlertReviewIn,
    AlertReviewOut,
    AlertVerdict,
    PhaseCount,
    RuleCount,
    VerdictCount,
)
from app.audit.service import record_audit
from app.auth.models import User
from app.auth.service import get_current_user, users_by_matricule
from app.bigquery import AlertFilter, BigQueryGateway, get_bigquery
from app.core.clock import now
from app.core.db import get_db
from app.core.errors import ApiError
from app.rules.models import Rule

router = APIRouter(tags=["alertes"])

MAX_DAYS = 92


@router.get("/alerts", response_model=AlertPage)
def list_alerts(
    from_: date | None = Query(None, alias="from"),
    to: date | None = None,
    rule_id: str | None = Query(None, alias="ruleId"),
    phase: AlertPhase | None = None,
    verdict: AlertVerdict | None = None,
    q: str | None = None,
    limit: int = Query(25, ge=1, le=100),
    offset: int = Query(0, ge=0),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
) -> AlertPage:
    end = to or now().date()
    start = from_ or end - timedelta(days=6)
    if start > end:
        raise ApiError(422, "La date de début doit précéder la date de fin.")
    if (end - start).days >= MAX_DAYS:
        raise ApiError(422, f"Période trop longue : {MAX_DAYS} jours au plus.")
    search = (q or "").strip() or None
    res = bq.alerts(AlertFilter(start, end, rule_id, phase, verdict, search, limit, offset))
    rows = res.items
    ids = {a.rule_id for a in rows} | set(res.rules)
    found = db.scalars(select(Rule).where(Rule.rule_id.in_(ids)).options(selectinload(Rule.versions)))
    rules = {r.rule_id: r for r in found}
    users = users_by_matricule(db)

    def name(rule_id: str, version: int) -> str:
        rule = rules.get(rule_id)
        if not rule or not rule.versions:
            return rule_id
        v = next((x for x in rule.versions if x.version == version), rule.versions[-1])
        return v.name

    items = [
        AlertOut(
            order_id=a.order_id,
            rule_id=a.rule_id,
            rule_name=name(a.rule_id, a.rule_version),
            rule_version=a.rule_version,
            run_date=a.run_date,
            detected_at=a.detected_at,
            phase="PRODUCTION" if a.to_send else "TEST",
            verdict=a.verdict,  # type: ignore[arg-type]
            provider_is_fraud=a.provider_is_fraud,
            review=AlertReviewOut(
                verdict=a.review_verdict,  # type: ignore[arg-type]
                by_matricule=a.reviewed_by or "",
                by_name=users[a.reviewed_by].full_name if a.reviewed_by in users else (a.reviewed_by or ""),
                at=a.reviewed_at,
            )
            if a.review_verdict is not None and a.reviewed_at is not None
            else None,
            details=a.details,
        )
        for a in rows
    ]

    def latest_name(rule_id: str) -> str:
        rule = rules.get(rule_id)
        return rule.versions[-1].name if rule and rule.versions else rule_id

    return AlertPage(
        items=items,
        total=res.total,
        to_review=res.to_review,
        phases=[PhaseCount(phase=p, count=n) for p, n in sorted(res.phases.items())],  # type: ignore[arg-type]
        rules=sorted(
            (RuleCount(rule_id=r, rule_name=latest_name(r), count=n) for r, n in res.rules.items()),
            key=lambda c: (-c.count, c.rule_name.lower()),
        ),
        verdicts=[VerdictCount(verdict=v, count=n) for v, n in res.verdicts.items()],  # type: ignore[arg-type]
    )


@router.post("/alerts/review", status_code=204)
def review_alert(
    body: AlertReviewIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
) -> None:
    query = select(Rule).where(Rule.rule_id == body.rule_id).options(selectinload(Rule.versions))
    rule = db.scalars(query).first()
    version = next((v for v in rule.versions if v.version == body.rule_version), None) if rule else None
    if version is None:
        raise ApiError(404, "Règle introuvable.")
    if not bq.add_review(body.order_id, body.rule_id, body.rule_version, body.verdict, user.matricule):
        raise ApiError(
            409,
            "Seules les commandes d'une version en test se qualifient : les commandes transmises au "
            "prestataire sont vérifiées par lui.",
            "NOT_IN_TEST",
        )
    label = {
        "FRAUD": "fraude avérée",
        "RISKY": "commande risquée",
        "NOT_FRAUD": "RAS",
        None: "qualification retirée",
    }[body.verdict]
    record_audit(db, user, "ALERT_REVIEW", version, f"Commande {body.order_id} : {label}")
    db.commit()
