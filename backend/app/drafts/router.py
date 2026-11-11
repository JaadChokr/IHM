"""Brouillons personnels (F1, F2) et publication (F4)."""

import uuid

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.models import User
from app.auth.service import get_current_user
from app.bigquery import BigQueryGateway, get_bigquery
from app.core.clock import now
from app.core.db import get_db
from app.core.errors import ApiError
from app.drafts.models import Draft
from app.drafts.schemas import DraftIn, DraftOut
from app.drafts.service import adopt_tests, apply_content, draft_out, draft_tests, load_draft
from app.query.models import TestRun
from app.query.sql_checks import query_hash
from app.rules.models import Rule, RuleVersion
from app.rules.schemas import RuleDetail, RuleInput
from app.rules.service import (
    detail,
    find_rule,
    load_rule,
    name_free,
    name_key,
    notify_data_team,
    sync_registry,
    validate,
    withdrawable,
)

router = APIRouter(prefix="/drafts", tags=["brouillons"])


@router.get("", response_model=list[DraftOut])
def list_drafts(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[DraftOut]:
    drafts = db.scalars(
        select(Draft).where(Draft.matricule == user.matricule).order_by(Draft.updated_at.desc())
    )
    return [draft_out(db, d) for d in drafts]


@router.get("/{draft_id}", response_model=DraftOut)
def get_draft(
    draft_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> DraftOut:
    return draft_out(db, load_draft(db, draft_id, user))


@router.post("", response_model=DraftOut, status_code=201)
def create_draft(
    data: DraftIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
) -> DraftOut:
    """Nouvelle règle, ou nouvelle version d'une règle existante (`ruleId`).

    Si l'utilisateur a soumis la dernière version et qu'Airflow ne l'a jamais exécutée, elle est
    retirée du référentiel et redevient son brouillon (même numéro à la resoumission).
    """
    validate(db, bq, data, data.rule_id)
    t = now()
    withdrawn: RuleVersion | None = None
    rule: Rule | None = None
    if data.rule_id:
        rule = load_rule(db, data.rule_id)
        mine = select(Draft).where(Draft.rule_id == rule.rule_id, Draft.matricule == user.matricule)
        if db.scalars(mine).first():
            raise ApiError(409, "Vous avez déjà un brouillon pour cette règle.", "DRAFT_EXISTS")
        cur = rule.versions[-1]
        if withdrawable(rule, user):
            withdrawn = cur
            base = rule.versions[-2].version if len(rule.versions) > 1 else None
            d = Draft(
                id=str(uuid.uuid4()), rule_id=rule.rule_id, base_version=base, created_at=cur.created_at
            )
        else:
            d = Draft(id=str(uuid.uuid4()), rule_id=rule.rule_id, base_version=cur.version, created_at=t)
    else:
        d = Draft(id=str(uuid.uuid4()), rule_id=str(uuid.uuid4()), base_version=None, created_at=t)
    d.matricule, d.updated_at = user.matricule, t
    apply_content(d, data)
    db.add(d)
    if withdrawn and rule:
        record_audit(
            db,
            user,
            "RULE_WITHDRAW",
            withdrawn,
            "Publication retirée pour modification",
        )
        # Les tests de la version retirée suivent le brouillon.
        db.execute(
            update(TestRun)
            .where(TestRun.rule_id == rule.rule_id, TestRun.version == withdrawn.version)
            .values(draft_id=d.id, rule_id=None, version=None)
        )
        rule.versions.remove(withdrawn)
        if not rule.versions:
            db.delete(rule)  # la règle n'avait que cette version : elle quitte le référentiel
    db.flush()
    adopt_tests(db, user, d)
    db.commit()
    if withdrawn and rule:
        # La ligne de rules_registry revient à la version précédente (ou disparaît s'il n'y en a pas) :
        # Airflow ne peut plus prendre la version retirée.
        sync_registry(bq, rule)
        notify_data_team(
            "RULE_SUBMISSION_WITHDRAWN", rule.rule_id, withdrawn.version, withdrawn.name, user.matricule
        )
    return draft_out(db, d, withdrawn=withdrawn is not None)


@router.put("/{draft_id}", response_model=DraftOut)
def update_draft(
    draft_id: str,
    data: RuleInput,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
) -> DraftOut:
    d = load_draft(db, draft_id, user)
    validate(db, bq, data, d.rule_id)
    apply_content(d, data)
    d.updated_at = now()
    db.commit()
    return draft_out(db, d)


@router.delete("/{draft_id}", status_code=204)
def delete_draft(draft_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    d = load_draft(db, draft_id, user)
    # Les tests restent (historique), simplement détachés.
    db.execute(update(TestRun).where(TestRun.draft_id == d.id).values(draft_id=None))
    db.delete(d)
    db.commit()
    return Response(status_code=204)


@router.post("/{draft_id}/submit", response_model=RuleDetail)
def submit_draft(
    draft_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
) -> RuleDetail:
    d = load_draft(db, draft_id, user)
    tests = draft_tests(db, d.id)
    last = tests[0] if tests else None
    if (
        not last
        or not last.success
        or last.phase != "EXECUTION"
        or last.query_hash != query_hash(d.sql_query)
    ):
        raise ApiError(
            409,
            "Le dernier test doit être une exécution réussie portant sur la version actuelle de la requête.",
            "TEST_REQUIRED",
        )
    if not name_free(db, d.name, d.rule_id):
        raise ApiError(409, f"Une règle nommée « {d.name} » existe déjà.", "NAME_TAKEN")
    t = now()
    rule = find_rule(db, d.rule_id)
    if rule is None:
        rule = Rule(
            rule_id=d.rule_id, owner_matricule=user.matricule, created_at=t, name_key=name_key(d.name)
        )
        db.add(rule)
    number = rule.versions[-1].version + 1 if rule.versions else 1
    v = RuleVersion(
        rule_id=d.rule_id,
        version=number,
        submitted_by=user.matricule,
        created_at=d.created_at,
        updated_at=t,
        submitted_at=t,
    )
    apply_content(v, d)
    rule.versions.append(v)
    rule.name_key = name_key(d.name)
    db.flush()
    db.execute(
        update(TestRun)
        .where(TestRun.draft_id == d.id)
        .values(rule_id=d.rule_id, version=number, draft_id=None)
    )
    origin = (
        "Nouvelle règle" if number == 1 else f"Nouvelle version (préparée à partir de la v{d.base_version})"
    )
    record_audit(db, user, "RULE_SUBMIT", v, origin)
    db.delete(d)
    try:
        db.commit()
    except IntegrityError as e:  # course entre deux soumissions : l'unicité est garantie par la base
        db.rollback()
        raise ApiError(409, f"Une règle nommée « {v.name} » existe déjà.", "NAME_TAKEN") from e
    # La ligne de la règle dans rules_registry passe à cette version : Airflow l'exécute au run suivant.
    sync_registry(bq, rule)
    notify_data_team("RULE_SUBMITTED", rule.rule_id, number, v.name, user.matricule)
    return detail(db, rule, user)
