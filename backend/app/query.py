"""Test d'une requête (PRD F3) : dry-run puis exécution échantillonnée sous garde-fous."""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.bigquery import BigQueryGateway, BytesLimitExceeded, QueryError, get_bigquery
from app.core import ApiError, Settings, get_settings, now
from app.database import Draft, Rule, RuleVersion, TestRun, User, get_db, record_audit
from app.periods import Period, last_period
from app.schemas import DryRunResult, ExecutionResult, Guardrails, QueryIn, SqlIssue, TestPeriod
from app.sql_checks import check_date_window, check_hardcoded_dates, check_params, query_hash

router = APIRouter(tags=["test"])


Target = tuple[RuleVersion | None, Draft | None]


def _target(db: Session, user: User, body: QueryIn) -> Target:
    """Ce qui est testé : un brouillon (privé), la dernière version d'une règle, ou une requête libre.
    Résolu avant tout appel à BigQuery."""
    if body.draft_id:
        draft = db.get(Draft, body.draft_id)
        if draft is None or draft.matricule != user.matricule:
            raise ApiError(404, "Brouillon introuvable.")
        return None, draft
    if body.rule_id:
        rule = db.get(Rule, body.rule_id)
        if rule is None or not rule.versions:
            raise ApiError(404, "Règle introuvable.")
        return rule.versions[-1], None
    return None, None


def _record(db: Session, user: User, body: QueryIn, target: Target, **fields) -> TestRun:
    cur, draft = target
    run = TestRun(
        id=str(uuid.uuid4()),
        rule_id=cur.rule_id if cur else None,
        version=cur.version if cur else None,
        draft_id=draft.id if draft else None,
        query_hash=query_hash(body.sql),
        at=now(),
        by_matricule=user.matricule,
        **fields,
    )
    db.add(run)
    phase = "Exécution échantillonnée" if fields["phase"] == "EXECUTION" else "Dry-run"
    outcome = "réussi" if fields["success"] else f"en échec : {fields.get('error') or ''}"
    # Un brouillon est privé : le journal garde le test (volume scanné) sans nommer la règle.
    record_audit(db, user, "RULE_TEST", cur, f"{phase} {outcome}" + (" (brouillon)" if draft else ""))
    db.commit()
    return run


def _period(body: QueryIn, target: Target) -> Period:
    """Valeurs de @period_start / @period_end : la dernière période complète de la fréquence."""
    cur, draft = target
    schedule = body.schedule or (draft.schedule if draft else cur.schedule if cur else "DAILY")
    return last_period(schedule, now())


def _analyse(bq: BigQueryGateway, body: QueryIn, period: Period) -> tuple[list[SqlIssue], object | None]:
    issues = check_params(body.sql) + check_hardcoded_dates(body.sql) + check_date_window(body.sql)
    try:
        meta = bq.dry_run(body.sql, period)
    except QueryError as e:
        issues.insert(
            0, SqlIssue(severity="error", code="BIGQUERY", message=e.message, line=e.line, column=e.column)
        )
        return issues, None
    # Contraintes vérifiées sur les métadonnées du dry-run, pas sur le texte (PRD F2).
    if meta.statement_type != "SELECT":
        issues.insert(
            0,
            SqlIssue(
                severity="error",
                code="NOT_SELECT",
                message=f"statementType = {meta.statement_type} : seule une instruction SELECT est autorisée.",  # noqa: E501
            ),
        )
    elif not any(c.name == "order_id" for c in meta.schema):
        issues.append(
            SqlIssue(
                severity="error",
                code="NO_ORDER_ID",
                message="La projection doit exposer la colonne order_id.",
            )
        )
    return issues, meta


# --------------------------------------------------------------------------- routes


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
    target = _target(db, user, body)
    period = _period(body, target)
    issues, meta = _analyse(bq, body, period)
    ok = meta is not None and not any(i.severity == "error" for i in issues)
    first_error = next((i.message for i in issues if i.severity == "error"), None)
    run = _record(
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
    target = _target(db, user, body)
    period = _period(body, target)
    issues, meta = _analyse(bq, body, period)
    if meta is None or any(i.severity == "error" for i in issues):
        raise ApiError(422, "Le dry-run doit réussir avant toute exécution.")
    if meta.bytes_processed > settings.max_bytes_billed:
        raise ApiError(
            422,
            f"Exécution refusée : volume estimé {meta.bytes_processed / 1e9:.1f} Go, "
            f"plafond {settings.max_bytes_billed / 1e9:.0f} Go (maximumBytesBilled).",
            "BYTES_LIMIT",
        )
    try:
        own = target[0].rule_id if target[0] else target[1].rule_id if target[1] else body.exclude_rule_id
        res = bq.execute(body.sql, period, exclude_rule_id=own, overlap_days=settings.overlap_days)
    except BytesLimitExceeded as e:
        _record(db, user, body, target, phase="EXECUTION", success=False, error=str(e))
        raise ApiError(422, "Exécution interrompue : plafond de volume scanné atteint.", "BYTES_LIMIT") from e
    except QueryError as e:
        _record(db, user, body, target, phase="EXECUTION", success=False, error=e.message)
        raise ApiError(422, e.message, "BIGQUERY") from e
    # Seules les métadonnées sont persistées ; les lignes ne quittent pas la réponse (PRD §10).
    run = _record(
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
