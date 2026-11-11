"""Logique des règles : statuts déduits des runs Airflow, versions exécutées, registre BigQuery, décisions."""

import json
import logging
import re
import unicodedata
import urllib.request
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.auth.models import User
from app.auth.service import display_name, users_by_matricule
from app.bigquery import BigQueryGateway, QueryError
from app.core.clock import as_utc, now
from app.core.config import get_settings
from app.core.errors import ApiError
from app.drafts.models import Draft
from app.query.models import TestRun
from app.query.periods import last_period
from app.query.service import as_test_record
from app.rules.models import Rule, RuleVersion
from app.rules.schemas import RuleDetail, RuleInput, RuleSummary, RuleVersionOut

log = logging.getLogger(__name__)

REQUIRED = {
    "name": "Nom",
    "description": "Description métier",
    "fraud_typology": "Typologie de fraude",
    "sql_query": "Requête SQL",
}


def name_key(name: str) -> str:
    s = unicodedata.normalize("NFD", name.strip())
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


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
      à côté comme candidate, en test, jusqu'à la décision (mise en production ou écart).
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
    period = SCHEDULE_PERIOD.get(v.schedule, timedelta(days=1)) * (v.schedule_every or 1)
    if idle > period * INACTIVE_AFTER_PERIODS:
        return "INACTIVE"
    return "IN_PRODUCTION" if v.decision == "SENT" else "OBSERVATION"


def derive_status(rule: Rule, v: RuleVersion, at: datetime | None = None) -> str:
    """Statut affiché d'une version (toutes les versions stockées ont été publiées).

    Cycle : publiée → en test (Airflow l'exécute, rien n'est envoyé au prestataire) → en
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
    """Version qui représente la règle à l'exécution (en test, en production ou inactive) : la
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
        schedule_every=v.schedule_every or 1,
        sql_query=v.sql_query,
        status=derive_status(rule, v),  # type: ignore[arg-type]
        owner_matricule=rule.owner_matricule,
        owner_name=display_name(users, rule.owner_matricule),
        submitted_by=v.submitted_by,
        submitted_by_name=display_name(users, v.submitted_by),
        created_at=v.created_at,
        updated_at=v.updated_at,
        submitted_at=v.submitted_at,
        decision=v.decision,  # type: ignore[arg-type]
        decided_at=v.decided_at,
        decided_by_name=display_name(users, v.decided_by) if v.decided_by else None,
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
        period = last_period(data.schedule, now(), data.schedule_every)
        stype = bq.dry_run(data.sql_query, period).statement_type
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
    seulement pour la version en production) : c'est tout ce que le DAG en recopie. L'historique reste dans
    `rule_versions` ; les brouillons n'y vont jamais.
    """
    bq.set_registry(
        rule,
        [(v, derive_status(rule, v), v.decision == "SENT") for v, _ in registry_versions(rule)],
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
