"""Pilotage, en lecture seule : indicateurs de performance (F6, F7) et journal d'audit (F8).

Les indicateurs sont lus dans BigQuery, table rule_runs et deux vues :
  - v_rule_orders pour une règle, en commandes distinctes, selon son état : en production, ses commandes
    à transmettre (to_send) ; en test, les autres. Courbes et indicateurs de la page règle, totaux
    de la vue d'ensemble ;
  - v_rule_performance pour la comparaison des versions (chaque version mesurée en entier).
"""

from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.auth import get_current_user
from app.bigquery import BigQueryGateway, get_bigquery
from app.core import ApiError, Settings, get_settings
from app.database import AuditEvent, Rule, User, get_db
from app.rules import derive_status, load_rule, production_version, running_version, sync_runs
from app.schemas import AuditEventOut, ConsolidatedRow, PerformanceResponse, PeriodTotals, RuleRun

router = APIRouter(tags=["pilotage"])


@router.get("/rules/{rule_id}/performance", response_model=PerformanceResponse)
def performance(
    rule_id: str,
    from_: date = Query(alias="from"),
    to: date = Query(),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
    s: Settings = Depends(get_settings),
):
    if from_ > to:
        raise ApiError(422, "La date de début doit précéder la date de fin.")
    # Une règle en production : ses commandes envoyées ; en test : ses commandes observées.
    sent = production_version(load_rule(db, rule_id)) is not None
    length = (to - from_).days + 1
    prev_to = from_ - timedelta(days=1)
    prev_from = prev_to - timedelta(days=length - 1)
    return PerformanceResponse(
        rule_id=rule_id,
        from_=from_,
        to=to,
        daily=bq.daily_performance(rule_id, from_, to, sent),
        previous=bq.daily_performance(rule_id, prev_from, prev_to, sent),
        totals=_totals(bq, rule_id, sent, from_, to),
        previous_totals=_totals(bq, rule_id, sent, prev_from, prev_to),
        by_version=bq.version_daily(rule_id, from_, to),
        runs=bq.runs(rule_id, from_, to),
        versions=bq.version_totals(rule_id),
    )


@router.get("/rules/{rule_id}/runs", response_model=list[RuleRun])
def rule_runs(
    rule_id: str,
    days: int = Query(90, ge=1, le=400),
    limit: int = Query(200, ge=1, le=1000),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
):
    """Historique des exécutions automatiques de la règle (toutes versions), la plus récente d'abord."""
    load_rule(db, rule_id)
    end = date.today()
    return bq.runs(rule_id, end - timedelta(days=days - 1), end, limit)


def _totals(bq: BigQueryGateway, rule_id: str, sent: bool, start: date, end: date) -> PeriodTotals:
    t = next(iter(bq.production_totals({rule_id: sent}, start, end)), None)
    return PeriodTotals(
        orders_flagged=t.flagged if t else 0,
        orders_to_send=t.to_send if t else 0,
        orders_processed=t.processed if t else 0,
        orders_confirmed_fraud=t.confirmed if t else 0,
        orders_observed=t.observed if t else 0,
    )


@router.get("/performance/production", response_model=list[ConsolidatedRow])
def production(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
):
    rules = db.scalars(select(Rule).options(selectinload(Rule.versions))).all()
    # Règles orchestrées par Airflow, y compris celles devenues inactives (signalées à surveiller).
    prod = {r.rule_id: (r, v) for r in rules if (v := running_version(r))}
    users = {u.matricule: u for u in db.scalars(select(User))}
    end = date.today()
    in_production = {rid: production_version(r) is not None for rid, (r, _) in prod.items()}
    totals = {t.rule_id: t for t in bq.production_totals(in_production, end - timedelta(days=29), end)}
    out = []
    for rid, (r, v) in prod.items():
        t = totals.get(rid)
        owner = users.get(r.owner_matricule)
        out.append(
            ConsolidatedRow(
                rule_id=rid,
                name=v.name,
                version=v.version,
                fraud_typology=v.fraud_typology,
                criticality=v.criticality,  # type: ignore[arg-type]
                owner_name=owner.full_name if owner else r.owner_matricule,
                status=derive_status(r, v),  # type: ignore[arg-type]
                last_run_at=v.last_run_at,
                ordersFlagged30d=t.flagged if t else 0,
                ordersProcessed30d=t.processed if t else 0,
                ordersConfirmed30d=t.confirmed if t else 0,
                ordersToSend30d=t.to_send if t else 0,
            )
        )
    return out


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


@router.post("/internal/sync-runs", include_in_schema=False)
def sync_airflow_runs(db: Session = Depends(get_db), bq: BigQueryGateway = Depends(get_bigquery)) -> dict:
    """Déclenché par Cloud Scheduler : recopie l'état des exécutions Airflow (statuts déduits).

    Sans identité utilisateur : la route est idempotente et ne fait que lire `rule_runs`.
    """
    return {"rulesUpdated": sync_runs(db, bq)}
