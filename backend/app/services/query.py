"""Test d'une requête : cible, période, contrôles, traces.

Contrôles du texte de la requête (PRD F2, miroir de frontend/src/lib/sql.ts). Les contraintes structurelles
(SELECT unique, colonne order_id) s'appuient sur les métadonnées du dry-run BigQuery, pas sur le texte : voir
`analyse`. Sur le texte, uniquement ce que BigQuery ne dit pas : seuls @period_start / @period_end sont admis,
facultatifs (fournis par Airflow à chaque run, et par la plateforme au test) ; dates en dur et absence de
fenêtre de dates (simples alertes). CURRENT_DATE() est libre.
"""

import re
import uuid

from sqlalchemy.orm import Session

from app.bigquery import BigQueryGateway, QueryError
from app.core.clock import now
from app.core.errors import ApiError
from app.core.periods import PARAMS, Period, last_period
from app.core.sql import find_params, mask_sql, offset_to_line_col, query_hash
from app.models import Draft, QueryIn, Rule, RuleVersion, SqlIssue, TestRecord, TestRun, User
from app.services.audit import record_audit
from app.services.auth import display_name

_CLOCK_RE = re.compile(r"\bCURRENT_(?:DATE|DATETIME|TIMESTAMP)\b(?:\s*\(\s*\))?", re.IGNORECASE)
_DATE_RE = re.compile(r"(?:\b(?:DATE|TIMESTAMP)\s*)?'\d{4}-\d{2}-\d{2}[^']*'", re.IGNORECASE)

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
    return TestRecord.model_validate(t, update={"by_name": display_name(users, t.by_matricule)})


def check_params(sql: str) -> list[SqlIssue]:
    """Seuls @period_start / @period_end : bornes de la période du run, fournies par Airflow (et par la
    plateforme au test). Tout autre paramètre est refusé : les seuils s'écrivent en dur."""
    issues: list[SqlIssue] = []
    reported: set[str] = set()
    for name, off in find_params(sql):
        if name in PARAMS or name in reported:
            continue
        reported.add(name)
        line, col = offset_to_line_col(sql, off)
        issues.append(
            SqlIssue(
                severity="error",
                code="PARAM_NOT_ALLOWED",
                message=f"@{name} : seuls @period_start et @period_end sont fournis (bornes de la période du "
                "run). Écrivez les autres valeurs dans la requête (ex. amount_eur > 500).",
                line=line,
                column=col,
                length=len(name) + 1,
            )
        )
    return issues


def check_hardcoded_dates(sql: str) -> list[SqlIssue]:
    masked = mask_sql(sql, keep_strings=True)
    issues = []
    for m in _DATE_RE.finditer(masked):
        line, col = offset_to_line_col(sql, m.start())
        issues.append(
            SqlIssue(
                # Simple alerte : une date fixe est légitime comme seuil (ex. comptes créés après le
                # 1er janvier 2024), mais pas comme jour traité, qui serait alors le même à chaque run.
                severity="warning",
                code="HARDCODED_DATE",
                message=f"Date en dur ({m.group(0)}) : normal pour un seuil fixe. Si elle désigne la période "
                "traitée, la règle relira ce même jour à chaque exécution : préférez "
                "DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) pour la veille.",
                line=line,
                column=col,
                length=len(m.group(0)),
            )
        )
    return issues


def check_date_window(sql: str) -> list[SqlIssue]:
    """Alerte si la requête n'a aucune fenêtre de dates (ni CURRENT_DATE() et consorts, ni
    @period_start / @period_end) : chaque run relit toute la table (volume, coût) et le premier run d'une
    version remonte tout ce qu'elle lit (le dédoublonnage ne joue qu'ensuite). Simple alerte : la requête
    reste libre, rien n'est perdu ni doublé."""
    if not sql.strip():
        return []
    # Hors chaînes et commentaires, et hors identifiants entre backticks (une colonne `current_date`).
    masked = re.sub(r"`[^`\n]*`", lambda m: " " * len(m.group(0)), mask_sql(sql))
    if _CLOCK_RE.search(masked) or any(n in PARAMS for n, _ in find_params(sql)):
        return []
    return [
        SqlIssue(
            severity="warning",
            code="NO_DATE_WINDOW",
            message="Pas de fenêtre de dates : chaque run relira toute la table, un volume inutilement "
            "grand, et le premier run remontera tout l'historique (pic dans le comparatif des versions). "
            "Bornez la lecture, par exemple order_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) pour "
            "la veille.",
        )
    ]
