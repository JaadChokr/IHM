"""Référentiel des règles (F5) et décisions après le test (mise en production, suspension, écart)."""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.audit.service import record_audit
from app.auth.models import User
from app.auth.service import get_current_user, users_by_matricule
from app.bigquery import BigQueryGateway, get_bigquery
from app.core.clock import now
from app.core.db import get_db
from app.core.errors import ApiError
from app.rules.models import Rule
from app.rules.schemas import DecisionIn, NameAvailable, RuleDetail, RuleSummary
from app.rules.service import (
    derive_status,
    detail,
    load_rule,
    name_free,
    name_key,
    notify_data_team,
    production_version,
    summary,
    sync_registry,
)
from app.rules.types import RuleStatus

router = APIRouter(prefix="/rules", tags=["règles"])


@router.get("", response_model=list[RuleSummary])
def list_rules(
    q: str = "",
    status: RuleStatus | None = None,
    typology: str = "",
    owner: str = "",
    criticality: str = "",
    sort: str = "updated_desc",
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[RuleSummary]:
    # Volumétrie de l'ordre de la centaine (PRD H1) : filtrage en mémoire sur la version courante.
    users = users_by_matricule(db)
    rules = db.scalars(select(Rule).options(selectinload(Rule.versions))).all()
    needle = name_key(q) if q else ""
    out = []
    for r in rules:
        if not r.versions:
            continue
        cur = r.versions[-1]
        if needle and needle not in name_key(f"{cur.name}\n{cur.description}\n{cur.sql_query}"):
            continue
        if typology and cur.fraud_typology != typology:
            continue
        if (owner and r.owner_matricule != owner) or (criticality and cur.criticality != criticality):
            continue
        s = summary(db, r, users)
        if status and s.status != status:
            continue
        out.append(s)
    out.sort(key=lambda s: s.updated_at, reverse=sort != "updated_asc")
    return out


# Déclarée avant /{rule_id} pour ne pas être capturée par celle-ci.
@router.get("/name-available", response_model=NameAvailable)
def name_available(
    name: str, exclude: str | None = None, _: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> NameAvailable:
    return NameAvailable(available=name_free(db, name, exclude))


@router.get("/{rule_id}", response_model=RuleDetail)
def get_rule(
    rule_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> RuleDetail:
    return detail(db, load_rule(db, rule_id), user)


DECISIONS = {
    # action : (statuts acceptés, décision posée, événement d'audit, notification équipe data)
    "send": (("OBSERVATION",), "SENT", "RULE_SEND_TO_PROVIDER", "RULE_SENT_TO_PROVIDER"),
    "suspend": (("IN_PRODUCTION", "INACTIVE"), None, "RULE_SUSPEND_SENDING", "RULE_SENDING_SUSPENDED"),
    "discard": (("SUBMITTED", "OBSERVATION", "INACTIVE"), "DISCARDED", "RULE_DISCARD", "RULE_DISCARDED"),
}

DECISION_LABEL = {
    "send": "Mise en production : envoi au prestataire décidé",
    "suspend": "Envoi au prestataire suspendu : retour en test",
    "discard": "Version écartée : Airflow ne l'exécute plus",
}


@router.post("/{rule_id}/decision", response_model=RuleDetail)
def decide(
    rule_id: str,
    body: DecisionIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    bq: BigQueryGateway = Depends(get_bigquery),
) -> RuleDetail:
    """Décision de l'analyste : mettre la dernière version en production (elle prend la place de la
    version en production, qui s'arrête), l'écarter, ou suspendre l'envoi de la version en production.
    rules_registry est mis à jour ; le DAG en tient compte au run suivant."""
    rule = load_rule(db, rule_id)
    # Envoyer / écarter : la dernière version (candidate ou seule). Suspendre : la version en production.
    cur = production_version(rule) if body.action == "suspend" else rule.versions[-1]
    if cur is None:
        raise ApiError(409, "Action impossible : aucune version n'est en production.", "BAD_STATUS")
    allowed, decision, action, event = DECISIONS[body.action]
    status = derive_status(rule, cur)
    if status not in allowed or (body.action == "discard" and cur.decision == "SENT"):
        raise ApiError(409, f"Action impossible : la v{cur.version} est « {status} ».", "BAD_STATUS")
    if body.action == "send":
        # Une seule version en production : la précédente s'arrête au run suivant (sa décision est retirée,
        # l'historique reste dans le journal d'audit).
        for w in rule.versions:
            if w is not cur and w.decision == "SENT":
                w.decision = None
    cur.decision = decision
    cur.decided_at, cur.decided_by = now(), user.matricule
    record_audit(db, user, action, cur, DECISION_LABEL[body.action])
    db.commit()
    sync_registry(bq, rule)
    notify_data_team(event, rule.rule_id, cur.version, cur.name, user.matricule)
    return detail(db, rule, user)
