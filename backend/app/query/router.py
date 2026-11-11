"""Test d'une requête (F3) : vérification de la syntaxe puis exécution sous garde-fous."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.models import User
from app.auth.service import get_current_user
from app.bigquery import BigQueryGateway, BytesLimitExceeded, QueryError, get_bigquery
from app.core.config import Settings, get_settings
from app.core.db import get_db
from app.core.errors import ApiError
from app.query.schemas import DryRunResult, ExecutionResult, Guardrails, QueryIn, TestPeriod
from app.query.service import analyse, record_test, resolve_target, test_period_for

router = APIRouter(tags=["test"])


@router.get("/config/guardrails", response_model=Guardrails)
def guardrails(_: User = Depends(get_current_user), s: Settings = Depends(get_settings)) -> Guardrails:
    return Guardrails(
        max_bytes_billed=s.max_bytes_billed,
        job_timeout_ms=s.job_timeout_ms,
        max_results=s.max_results,
    )


@router.post("/query/dry-run", response_model=DryRunResult)
def dry_run(
    body: QueryIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
    settings: Settings = Depends(get_settings),
) -> DryRunResult:
    target = resolve_target(db, user, body)
    period = test_period_for(body, target)
    issues, meta = analyse(bq, body, period)
    ok = meta is not None and not any(i.severity == "error" for i in issues)
    first_error = next((i.message for i in issues if i.severity == "error"), None)
    run = record_test(
        db,
        user,
        body,
        target,
        phase="DRY_RUN",
        success=ok,
        bytes_processed=meta.bytes_processed if meta else None,
        error=first_error,
    )
    return DryRunResult(
        ok=ok,
        statement_type=meta.statement_type if meta else None,
        output_schema=meta.schema if meta else None,
        bytes_processed=meta.bytes_processed if meta else None,
        issues=issues,
        exceeds_bytes_limit=bool(meta and meta.bytes_processed > settings.max_bytes_billed),
        period=TestPeriod(start=period.start, end=period.end),
        test_id=run.id,
    )


@router.post("/query/execute", response_model=ExecutionResult)
def execute(
    body: QueryIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
    settings: Settings = Depends(get_settings),
) -> ExecutionResult:
    target = resolve_target(db, user, body)
    period = test_period_for(body, target)
    issues, meta = analyse(bq, body, period)
    if meta is None or any(i.severity == "error" for i in issues):
        raise ApiError(422, "Validez d'abord la syntaxe de la requête.")
    if meta.bytes_processed > settings.max_bytes_billed:
        raise ApiError(
            422,
            f"Test refusé : la requête lirait {meta.bytes_processed / 1e9:.1f} Go, au-delà du plafond de "
            f"{settings.max_bytes_billed / 1e9:.0f} Go. Restreignez la période ou les tables lues.",
            "BYTES_LIMIT",
        )
    try:
        own = target[0].rule_id if target[0] else target[1].rule_id if target[1] else body.exclude_rule_id
        res = bq.execute(body.sql, period, exclude_rule_id=own, overlap_days=settings.overlap_days)
    except BytesLimitExceeded as e:
        record_test(db, user, body, target, phase="EXECUTION", success=False, error=str(e))
        raise ApiError(422, "Test interrompu : plafond de volume lu atteint.", "BYTES_LIMIT") from e
    except QueryError as e:
        record_test(db, user, body, target, phase="EXECUTION", success=False, error=e.message)
        raise ApiError(422, e.message, "BIGQUERY") from e
    # Seules les métadonnées sont persistées ; les lignes ne quittent pas la réponse (PRD §10).
    run = record_test(
        db,
        user,
        body,
        target,
        phase="EXECUTION",
        success=True,
        bytes_processed=res.bytes_processed,
        duration_ms=res.duration_ms,
        total_rows=res.total_rows,
    )
    return ExecutionResult(
        ok=True,
        columns=res.columns,
        rows=res.rows,
        total_rows=res.total_rows,
        duration_ms=res.duration_ms,
        bytes_processed=res.bytes_processed,
        orders_flagged=res.overlap.orders,
        orders_already_flagged=res.overlap.already_flagged,
        overlap_days=settings.overlap_days,
        period=TestPeriod(start=period.start, end=period.end),
        test_id=run.id,
    )
