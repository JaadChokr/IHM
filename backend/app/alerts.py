"""Alertes remontées par les règles, et qualification par les analystes.

Une alerte est une ligne de `rule_alerts` : une commande remontée par une version de règle. Son verdict vient
du prestataire quand il l'a vérifiée (commandes transmises) ; pour une version EN TEST (commandes non
transmises), l'analyste qualifie lui-même la commande : fraude ou non. La qualification porte sur la commande,
toutes règles confondues, et est ajoutée à `alert_reviews` (BigQuery), d'où elle entre dans les chiffres des
règles en test (v_rule_orders, v_rule_performance).
"""

from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.auth import get_current_user
from app.bigquery import AlertFilter, BigQueryGateway, get_bigquery
from app.core import ApiError, now
from app.database import Rule, User, get_db, record_audit
from app.rules import users_by_matricule
from app.schemas import AlertOut, AlertPage, AlertReviewIn, AlertReviewOut

router = APIRouter(tags=["alertes"])

MAX_DAYS = 92


@router.get("/alerts", response_model=AlertPage)
def list_alerts(
    from_: date | None = Query(None, alias="from"),
    to: date | None = None,
    rule_id: str | None = Query(None, alias="ruleId"),
    phase: Literal["TEST", "PRODUCTION"] | None = None,
    verdict: Literal["FRAUD", "NOT_FRAUD", "TO_REVIEW", "PENDING"] | None = None,
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
    rows, total, to_review = bq.alerts(
        AlertFilter(start, end, rule_id, phase, verdict, (q or "").strip() or None, limit, offset)
    )
    ids = {a.rule_id for a in rows}
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
                is_fraud=a.review_is_fraud,
                by_matricule=a.reviewed_by or "",
                by_name=users[a.reviewed_by].full_name if a.reviewed_by in users else (a.reviewed_by or ""),
                at=a.reviewed_at,
            )
            if a.review_is_fraud is not None and a.reviewed_at is not None
            else None,
            details=a.details,
        )
        for a in rows
    ]
    return AlertPage(items=items, total=total, to_review=to_review)


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
    if not bq.add_review(body.order_id, body.rule_id, body.rule_version, body.is_fraud, user.matricule):
        raise ApiError(
            409,
            "Seules les commandes d'une version en test se qualifient : les commandes transmises au "
            "prestataire sont vérifiées par lui.",
            "NOT_IN_TEST",
        )
    label = {True: "fraude", False: "pas une fraude", None: "qualification retirée"}[body.is_fraud]
    record_audit(db, user, "ALERT_REVIEW", version, f"Commande {body.order_id} : {label}")
    db.commit()
