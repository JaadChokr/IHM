"""Alertes remontées par les règles, et qualification par les analystes."""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.bigquery import AlertFilter, AlertRow, BigQueryGateway, DetailsNotConfigured, get_bigquery
from app.core.clock import now
from app.core.db import get_db
from app.core.errors import ApiError
from app.models import (
    AlertDetail,
    AlertOut,
    AlertPage,
    AlertPhase,
    AlertReviewIn,
    AlertReviewOut,
    AlertVerdict,
    OrderHolder,
    Rule,
    RuleCount,
    User,
    VerdictCount,
)
from app.services.audit import record_audit
from app.services.auth import get_current_user, users_by_matricule

router = APIRouter(tags=["alertes"])

MAX_DAYS = 92


def _load_rules(db: Session, ids: set[str]) -> dict[str, Rule]:
    found = db.scalars(select(Rule).where(Rule.rule_id.in_(ids)).options(selectinload(Rule.versions)))
    return {r.rule_id: r for r in found}


def _alerts_out(rows: list[AlertRow], rules: dict[str, Rule], users: dict[str, User]) -> list[AlertOut]:
    """Alertes au format de l'API : nom de la règle dans la version qui a remonté la commande, phase,
    verdict et auteur de la qualification."""

    def name(rule_id: str, version: int) -> str:
        rule = rules.get(rule_id)
        if not rule or not rule.versions:
            return rule_id
        v = next((x for x in rule.versions if x.version == version), rule.versions[-1])
        return v.name

    return [
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
    rules = _load_rules(db, {a.rule_id for a in res.items} | {r for r, _ in res.rules})
    items = _alerts_out(res.items, rules, users_by_matricule(db))

    def latest_name(rule_id: str) -> str:
        rule = rules.get(rule_id)
        return rule.versions[-1].name if rule and rule.versions else rule_id

    return AlertPage(
        items=items,
        total=res.total,
        to_review=res.to_review,
        rules=sorted(
            (
                RuleCount(rule_id=r, rule_name=latest_name(r), phase=ph, count=n)  # type: ignore[arg-type]
                for (r, ph), n in res.rules.items()
            ),
            key=lambda c: (c.phase != "TEST", -c.count, c.rule_name.lower()),
        ),
        verdicts=[VerdictCount(verdict=v, count=n) for v, n in res.verdicts.items()],  # type: ignore[arg-type]
    )


@router.get("/alerts/{order_id}", response_model=AlertDetail)
def get_alert(
    order_id: str,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
) -> AlertDetail:
    """Fiche d'une commande remontée : toutes ses remontées (règles, versions, dates) et les informations du
    titulaire, lues à la demande dans BigQuery (données personnelles : ni stockées, ni journalisées)."""
    rows = bq.order_alerts(order_id)
    if not rows:
        raise ApiError(404, "Aucune règle n'a remonté cette commande.")
    alerts = _alerts_out(rows, _load_rules(db, {a.rule_id for a in rows}), users_by_matricule(db))
    try:
        found = bq.order_details(order_id)
    except DetailsNotConfigured:
        return AlertDetail(order_id=order_id, alerts=alerts, holder_missing="NOT_CONFIGURED")
    if found is None:
        return AlertDetail(order_id=order_id, alerts=alerts, holder_missing="NOT_FOUND")
    return AlertDetail(order_id=order_id, alerts=alerts, holder=OrderHolder.model_validate(found))


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
