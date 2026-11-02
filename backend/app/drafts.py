"""Brouillons personnels (PRD F2, F4) : la sauvegarde de travail d'un analyste.

Comme son profil, un brouillon est stocké dans la base de la plateforme et n'est visible que de
lui : ni les collègues, ni le journal d'audit, ni BigQuery ne le voient. Il devient une version de
règle — et la règle entre dans le référentiel partagé — au moment de la soumission.
"""

import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.bigquery import BigQueryGateway, get_bigquery
from app.core import ApiError, as_utc, now
from app.database import Draft, Rule, RuleVersion, TestRun, User, get_db, record_audit
from app.rules import (
    as_test_record,
    detail,
    find_rule,
    load_rule,
    name_free,
    name_key,
    notify_data_team,
    sync_registry,
    users_by_matricule,
    validate,
    withdrawable,
)
from app.schemas import DraftIn, DraftOut, RuleDetail, RuleInput
from app.sql_checks import query_hash

router = APIRouter(prefix="/drafts", tags=["brouillons"])

# Fenêtre pendant laquelle un test fait depuis l'éditeur est rattaché au brouillon enregistré ensuite.
TEST_ADOPTION_WINDOW = timedelta(hours=1)
CONTENT = ("name", "description", "fraud_typology", "criticality", "schedule", "sql_query")


def _tests(db: Session, draft_id: str) -> list[TestRun]:
    return list(db.scalars(select(TestRun).where(TestRun.draft_id == draft_id).order_by(TestRun.at.desc())))


def _out(db: Session, d: Draft, withdrawn: bool = False) -> DraftOut:
    users = users_by_matricule(db)
    rule = find_rule(db, d.rule_id)
    tests = _tests(db, d.id)
    return DraftOut(
        id=d.id,
        rule_id=d.rule_id,
        base_version=d.base_version,
        **{k: getattr(d, k) for k in CONTENT},
        new_rule=rule is None,
        latest_version=rule.versions[-1].version if rule and rule.versions else None,
        withdrawn=withdrawn,
        created_at=d.created_at,
        updated_at=d.updated_at,
        last_test=as_test_record(tests[0], users) if tests else None,
        tests=[as_test_record(t, users) for t in tests],
    )


def _load(db: Session, draft_id: str, user: User) -> Draft:
    d = db.get(Draft, draft_id)
    if d is None or d.matricule != user.matricule:  # le brouillon d'un collègue n'existe pas pour vous
        raise ApiError(404, "Brouillon introuvable.")
    return d


def _apply(target: Draft | RuleVersion, data: Draft | RuleInput) -> None:
    for k in CONTENT:
        setattr(target, k, getattr(data, k))
    target.name = target.name.strip()


def _adopt_tests(db: Session, user: User, d: Draft) -> None:
    """Rattache au brouillon les tests récents de l'utilisateur, faits avant son premier enregistrement."""
    since = now() - TEST_ADOPTION_WINDOW
    for t in db.scalars(
        select(TestRun).where(
            TestRun.by_matricule == user.matricule,
            TestRun.query_hash == query_hash(d.sql_query),
            TestRun.rule_id.is_(None),
            TestRun.draft_id.is_(None),
        )
    ):
        if as_utc(t.at) >= since:
            t.draft_id = d.id


@router.get("", response_model=list[DraftOut])
def list_drafts(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[DraftOut]:
    drafts = db.scalars(
        select(Draft).where(Draft.matricule == user.matricule).order_by(Draft.updated_at.desc())
    )
    return [_out(db, d) for d in drafts]


@router.get("/{draft_id}", response_model=DraftOut)
def get_draft(
    draft_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> DraftOut:
    return _out(db, _load(db, draft_id, user))


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
    _apply(d, data)
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
    _adopt_tests(db, user, d)
    db.commit()
    if withdrawn and rule:
        # La ligne de rules_registry revient à la version précédente (ou disparaît s'il n'y en a pas) :
        # Airflow ne peut plus prendre la version retirée.
        sync_registry(bq, rule)
        notify_data_team(
            "RULE_SUBMISSION_WITHDRAWN", rule.rule_id, withdrawn.version, withdrawn.name, user.matricule
        )
    return _out(db, d, withdrawn=withdrawn is not None)


@router.put("/{draft_id}", response_model=DraftOut)
def update_draft(
    draft_id: str,
    data: RuleInput,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
) -> DraftOut:
    d = _load(db, draft_id, user)
    validate(db, bq, data, d.rule_id)
    _apply(d, data)
    d.updated_at = now()
    db.commit()
    return _out(db, d)


@router.delete("/{draft_id}", status_code=204)
def delete_draft(draft_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    d = _load(db, draft_id, user)
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
    d = _load(db, draft_id, user)
    tests = _tests(db, d.id)
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
    _apply(v, d)
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
