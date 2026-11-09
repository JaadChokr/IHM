"""Règles : référentiel partagé des versions soumises, cycle de vie déduit d'Airflow (PRD F1, F5).

Une règle n'entre dans le référentiel qu'à sa première soumission : avant, c'est un brouillon
personnel (app.drafts), visible de son seul auteur.
"""

import json
import logging
import re
import unicodedata
import urllib.request
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.auth import get_current_user
from app.bigquery import BigQueryGateway, QueryError, get_bigquery
from app.core import ApiError, as_utc, get_settings, now
from app.database import Draft, Rule, RuleVersion, TestRun, User, get_db, record_audit
from app.periods import last_period
from app.schemas import (
    DecisionIn,
    NameAvailable,
    RuleDetail,
    RuleInput,
    RuleStatus,
    RuleSummary,
    RuleVersionOut,
    TestRecord,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/rules", tags=["règles"])

REQUIRED = {
    "name": "Nom",
    "description": "Description métier",
    "fraud_typology": "Typologie de fraude",
    "sql_query": "Requête SQL",
}


def name_key(name: str) -> str:
    s = unicodedata.normalize("NFD", name.strip())
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def users_by_matricule(db: Session) -> dict[str, User]:
    return {u.matricule: u for u in db.scalars(select(User))}


def _name(users: dict[str, User], matricule: str) -> str:
    u = users.get(matricule)
    return u.full_name if u else matricule


def as_test_record(t: TestRun, users: dict[str, User]) -> TestRecord:
    fields = {k: getattr(t, k) for k in TestRecord.model_fields if k != "by_name"}
    return TestRecord(**fields, by_name=_name(users, t.by_matricule))


# Une version est « inactive » après 3 périodes sans exécution (3 jours pour une règle quotidienne…).
INACTIVE_AFTER_PERIODS = 3
SCHEDULE_PERIOD = {"HOURLY": timedelta(hours=1), "DAILY": timedelta(days=1), "WEEKLY": timedelta(weeks=1)}


RUNNING = ("OBSERVATION", "IN_PRODUCTION", "INACTIVE")


def production_version(rule: Rule) -> RuleVersion | None:
    """Version en production : la plus récente que l'analyste a décidé d'envoyer au prestataire. Mettre
    une version en production retire la décision des précédentes (voir `decide`)."""
    return next((v for v in reversed(rule.versions) if v.decision == "SENT"), None)


def registry_versions(rule: Rule) -> list[tuple[RuleVersion, bool]]:
    """Versions qu'Airflow exécute (lignes de rules_registry), avec pour chacune « candidate ? ».

    - Pas de version en production : la dernière version non écartée, seule (une nouvelle version
      remplace la précédente, rien n'est envoyé de toute façon).
    - Une version en production : elle continue de tourner ; une version plus récente non écartée tourne
      à côté comme candidate, en observation, jusqu'à la décision (mise en production ou écart).
    """
    prod = production_version(rule)
    latest = next((v for v in reversed(rule.versions) if v.decision != "DISCARDED"), None)
    if latest is None:
        return []
    if prod is None:
        return [(latest, False)]
    if latest.version > prod.version:
        return [(prod, False), (latest, True)]
    return [(prod, False)]


def is_candidate(rule: Rule, v: RuleVersion) -> bool:
    return any(w.version == v.version and cand for w, cand in registry_versions(rule))


def _run_status(v: RuleVersion, at: datetime | None) -> str | None:
    """Statut constaté dans rule_runs : None si la version n'a jamais tourné."""
    if not (v.first_run_at and v.last_run_at):
        return None
    idle = (at or now()) - as_utc(v.last_run_at)
    if idle > SCHEDULE_PERIOD.get(v.schedule, timedelta(days=1)) * INACTIVE_AFTER_PERIODS:
        return "INACTIVE"
    return "IN_PRODUCTION" if v.decision == "SENT" else "OBSERVATION"


def derive_status(rule: Rule, v: RuleVersion, at: datetime | None = None) -> str:
    """Statut affiché d'une version (toutes les versions stockées ont été publiées).

    Cycle : publiée → en observation (Airflow l'exécute, rien n'est envoyé au prestataire) → en
    production (l'analyste a décidé de l'envoyer) ou écartée. Une nouvelle version d'une règle en
    production tourne en parallèle comme candidate, sans remplacer la version en production. L'exécution
    se constate dans `rule_runs` (first_run_at / last_run_at) ; la décision est un geste de l'analyste.
    """
    if v.decision == "DISCARDED":
        return "DISCARDED"
    if any(w.version == v.version for w, _ in registry_versions(rule)):
        return _run_status(v, at) or "SUBMITTED"
    # Hors de rules_registry : une version plus récente a pris sa place.
    newer = [w for w in rule.versions if w.version > v.version and w.decision != "DISCARDED"]
    if any(w.first_run_at for w in newer):
        return "REPLACED"
    # La nouvelle version n'a pas encore tourné : celle-ci a pu tourner jusque-là.
    return _run_status(v, at) or ("REPLACED" if newer else "SUBMITTED")


def running_version(rule: Rule) -> RuleVersion | None:
    """Version qui représente la règle à l'exécution (en observation, en production ou inactive) : la
    version en production si elle tourne, sinon la plus récente qui tourne. Jamais la candidate."""
    for v, candidate in registry_versions(rule):
        if not candidate and derive_status(rule, v) in RUNNING:
            return v
    running = (v for v in reversed(rule.versions) if derive_status(rule, v) in RUNNING)
    return next((v for v in running if not is_candidate(rule, v)), None)


def withdrawable(rule: Rule, user: User) -> bool:
    """L'utilisateur a soumis la dernière version et Airflow ne l'a jamais exécutée : il peut la reprendre."""
    cur = rule.versions[-1]
    return cur.submitted_by == user.matricule and cur.first_run_at is None and cur.decision is None


def _version_out(v: RuleVersion, rule: Rule, users: dict[str, User]) -> RuleVersionOut:
    return RuleVersionOut(
        rule_id=v.rule_id,
        version=v.version,
        name=v.name,
        description=v.description,
        fraud_typology=v.fraud_typology,
        criticality=v.criticality,  # type: ignore[arg-type]
        schedule=v.schedule,  # type: ignore[arg-type]
        sql_query=v.sql_query,
        status=derive_status(rule, v),  # type: ignore[arg-type]
        owner_matricule=rule.owner_matricule,
        owner_name=_name(users, rule.owner_matricule),
        submitted_by=v.submitted_by,
        submitted_by_name=_name(users, v.submitted_by),
        created_at=v.created_at,
        updated_at=v.updated_at,
        submitted_at=v.submitted_at,
        decision=v.decision,  # type: ignore[arg-type]
        decided_at=v.decided_at,
        decided_by_name=_name(users, v.decided_by) if v.decided_by else None,
        airflow_dag_id=v.airflow_dag_id,
        first_run_at=v.first_run_at,
        last_run_at=v.last_run_at,
        candidate=is_candidate(rule, v),
    )


def _last_test(db: Session, rule_id: str, version: int) -> TestRun | None:
    return db.scalars(
        select(TestRun)
        .where(TestRun.rule_id == rule_id, TestRun.version == version)
        .order_by(TestRun.at.desc())
        .limit(1)
    ).first()


def summary(db: Session, rule: Rule, users: dict[str, User] | None = None) -> RuleSummary:
    users = users if users is not None else users_by_matricule(db)
    cur = rule.versions[-1]
    prod = running_version(rule)
    last = _last_test(db, rule.rule_id, cur.version)
    return RuleSummary(
        **_version_out(cur, rule, users).model_dump(),
        version_count=len(rule.versions),
        production_version=prod.version if prod and prod.version != cur.version else None,
        last_test=as_test_record(last, users) if last else None,
    )


def detail(db: Session, rule: Rule, user: User) -> RuleDetail:
    users = users_by_matricule(db)
    tests = db.scalars(select(TestRun).where(TestRun.rule_id == rule.rule_id).order_by(TestRun.at.desc()))
    draft = db.scalars(
        select(Draft).where(Draft.rule_id == rule.rule_id, Draft.matricule == user.matricule)
    ).first()
    return RuleDetail(
        **summary(db, rule, users).model_dump(),
        versions=[_version_out(v, rule, users) for v in reversed(rule.versions)],
        tests=[as_test_record(t, users) for t in tests],
        my_draft_id=draft.id if draft else None,
        can_withdraw=draft is None and withdrawable(rule, user),
    )


def find_rule(db: Session, rule_id: str) -> Rule | None:
    return db.scalars(
        select(Rule).where(Rule.rule_id == rule_id).options(selectinload(Rule.versions))
    ).first()


def load_rule(db: Session, rule_id: str) -> Rule:
    rule = find_rule(db, rule_id)
    if rule is None:
        raise ApiError(404, "Règle introuvable.")
    return rule


def name_free(db: Session, name: str, exclude_rule_id: str | None = None) -> bool:
    existing = db.scalars(select(Rule).where(Rule.name_key == name_key(name))).first()
    return existing is None or existing.rule_id == exclude_rule_id


def _first_keyword(sql: str) -> str:
    m = re.match(r"\s*(?:--[^\n]*\n\s*|/\*.*?\*/\s*)*(\w+)", sql, re.S)
    return m.group(1).upper() if m else ""


def validate(db: Session, bq: BigQueryGateway, data: RuleInput, rule_id: str | None = None) -> None:
    missing = [label for f, label in REQUIRED.items() if not str(getattr(data, f)).strip()]
    if missing:
        raise ApiError(422, f"Champs obligatoires manquants : {', '.join(missing)}.")
    if not name_free(db, data.name, rule_id):
        raise ApiError(409, f"Une règle nommée « {data.name.strip()} » existe déjà.", "NAME_TAKEN")
    # DML/DDL rejetés dès l'enregistrement, d'après le dry-run quand il aboutit (PRD F2).
    # Les autres contraintes (order_id, test réussi) bloquent la soumission, pas le brouillon.
    try:
        stype = bq.dry_run(data.sql_query, last_period(data.schedule, now())).statement_type
    except QueryError:
        kw = _first_keyword(data.sql_query)
        stype = "SELECT" if kw in ("SELECT", "WITH") else kw
    if stype != "SELECT":
        raise ApiError(
            422, f"Instruction {stype} refusée : seule une instruction SELECT est autorisée.", "NOT_SELECT"
        )


def sync_registry(bq: BigQueryGateway, rule: Rule) -> None:
    """Aligne les lignes de la règle dans `rules_registry` sur les versions qu'Airflow doit exécuter.

    Une ligne par version qui tourne (clé rule_id, version) : la version en production, et à côté une
    éventuelle candidate. `send_to_provider` dit si ses commandes sont à transmettre au prestataire (vrai
    seulement pour la version en production) ; `candidate` la distingue. L'historique reste dans
    `rule_versions` ; les brouillons n'y vont jamais.
    """
    bq.set_registry(
        rule,
        [(v, derive_status(rule, v), v.decision == "SENT", cand) for v, cand in registry_versions(rule)],
    )


def sync_runs(db: Session, bq: BigQueryGateway) -> int:
    """Recopie depuis `rule_runs` les dates de premier / dernier run et le DAG de chaque version.

    Appelée périodiquement (Cloud Scheduler). Renvoie le nombre de règles mises à jour.
    """
    stats = {(s.rule_id, s.rule_version): s for s in bq.run_stats()}
    touched: dict[str, Rule] = {}
    for v in db.scalars(select(RuleVersion)):
        s = stats.get((v.rule_id, v.version))
        if not s:
            continue
        known = (
            v.first_run_at and as_utc(v.first_run_at),
            v.last_run_at and as_utc(v.last_run_at),
            v.airflow_dag_id,
        )
        if known != (as_utc(s.first_run_at), as_utc(s.last_run_at), s.dag_id):
            v.first_run_at, v.last_run_at, v.airflow_dag_id = s.first_run_at, s.last_run_at, s.dag_id
            touched[v.rule_id] = v.rule
    db.commit()
    # Le statut de la version courante a pu changer (en production, inactive).
    for rule in touched.values():
        sync_registry(bq, rule)
    return len(touched)


def notify_data_team(event: str, rule_id: str, version: int, name: str, by: str) -> None:
    """Prévient l'équipe data : RULE_SUBMITTED, ou RULE_SUBMISSION_WITHDRAWN quand l'analyste
    reprend une version soumise pour la modifier."""
    payload = {"event": event, "ruleId": rule_id, "version": version, "name": name, "by": by}
    url = get_settings().notify_webhook_url
    if not url:
        log.info("notification équipe data (pas de canal configuré) : %s", payload)
        return
    try:
        req = urllib.request.Request(url, json.dumps(payload).encode(), {"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=5).close()
    except OSError:
        # La soumission est enregistrée ; un échec de notification ne doit pas l'annuler.
        log.exception("échec de la notification équipe data")


# --------------------------------------------------------------------------- routes


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


# --------------------------------------------------------------------------- décision après observation

DECISIONS = {
    # action : (statuts acceptés, décision posée, événement d'audit, notification équipe data)
    "send": (("OBSERVATION",), "SENT", "RULE_SEND_TO_PROVIDER", "RULE_SENT_TO_PROVIDER"),
    "suspend": (("IN_PRODUCTION", "INACTIVE"), None, "RULE_SUSPEND_SENDING", "RULE_SENDING_SUSPENDED"),
    "discard": (("SUBMITTED", "OBSERVATION", "INACTIVE"), "DISCARDED", "RULE_DISCARD", "RULE_DISCARDED"),
}
DECISION_LABEL = {
    "send": "Mise en production : envoi au prestataire décidé",
    "suspend": "Envoi au prestataire suspendu : retour en observation",
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
