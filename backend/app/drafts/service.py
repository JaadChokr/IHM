"""Brouillons : lecture, application du contenu, rattachement des tests."""

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import User
from app.auth.service import users_by_matricule
from app.core.clock import as_utc, now
from app.core.errors import ApiError
from app.drafts.models import Draft
from app.drafts.schemas import DraftOut
from app.query.models import TestRun
from app.query.service import as_test_record
from app.query.sql_checks import query_hash
from app.rules.models import RuleVersion
from app.rules.schemas import RuleInput
from app.rules.service import find_rule

# Fenêtre pendant laquelle un test fait depuis l'éditeur est rattaché au brouillon enregistré ensuite.
TEST_ADOPTION_WINDOW = timedelta(hours=1)

CONTENT = ("name", "description", "fraud_typology", "criticality", "schedule", "schedule_every", "sql_query")


def draft_tests(db: Session, draft_id: str) -> list[TestRun]:
    return list(db.scalars(select(TestRun).where(TestRun.draft_id == draft_id).order_by(TestRun.at.desc())))


def draft_out(db: Session, d: Draft, withdrawn: bool = False) -> DraftOut:
    users = users_by_matricule(db)
    rule = find_rule(db, d.rule_id)
    tests = draft_tests(db, d.id)
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


def load_draft(db: Session, draft_id: str, user: User) -> Draft:
    d = db.get(Draft, draft_id)
    if d is None or d.matricule != user.matricule:  # le brouillon d'un collègue n'existe pas pour vous
        raise ApiError(404, "Brouillon introuvable.")
    return d


def apply_content(target: Draft | RuleVersion, data: Draft | RuleInput) -> None:
    for k in CONTENT:
        setattr(target, k, getattr(data, k))
    target.name = target.name.strip()


def adopt_tests(db: Session, user: User, d: Draft) -> None:
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
