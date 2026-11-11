"""Test d'une requête : cible, période, contrôles, traces."""

import uuid

from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.models import User
from app.auth.service import display_name
from app.bigquery import BigQueryGateway, QueryError
from app.core.clock import now
from app.core.errors import ApiError
from app.drafts.models import Draft
from app.query.models import TestRun
from app.query.periods import Period, last_period
from app.query.schemas import QueryIn, SqlIssue, TestRecord
from app.query.sql_checks import check_date_window, check_hardcoded_dates, check_params, query_hash
from app.rules.models import Rule, RuleVersion

Target = tuple[RuleVersion | None, Draft | None]


def resolve_target(db: Session, user: User, body: QueryIn) -> Target:
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


def record_test(db: Session, user: User, body: QueryIn, target: Target, **fields) -> TestRun:
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
    phase = "Test" if fields["phase"] == "EXECUTION" else "Vérification de la syntaxe"
    outcome = "réussi" if fields["success"] else f"en échec : {fields.get('error') or ''}"
    # Un brouillon est privé : le journal garde le test (volume scanné) sans nommer la règle.
    record_audit(db, user, "RULE_TEST", cur, f"{phase} {outcome}" + (" (brouillon)" if draft else ""))
    db.commit()
    return run


def test_period_for(body: QueryIn, target: Target) -> Period:
    """Valeurs de @period_start / @period_end : la dernière période complète de la fréquence."""
    cur, draft = target
    src = draft or cur
    if body.schedule:
        schedule, every = body.schedule, body.schedule_every or 1
    else:
        schedule, every = (src.schedule, src.schedule_every or 1) if src else ("DAILY", 1)
    return last_period(schedule, now(), every)


def analyse(bq: BigQueryGateway, body: QueryIn, period: Period) -> tuple[list[SqlIssue], object | None]:
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


def as_test_record(t: TestRun, users: dict[str, User]) -> TestRecord:
    fields = {k: getattr(t, k) for k in TestRecord.model_fields if k != "by_name"}
    return TestRecord(**fields, by_name=display_name(users, t.by_matricule))
