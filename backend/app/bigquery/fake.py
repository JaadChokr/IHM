"""Passerelle BigQuery simulée : développement sans GCP et tests."""

import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime

from app.bigquery.contract import (
    AlertRow,
    DryRunMeta,
    ExecMeta,
    Overlap,
    ProductionTotals,
    QueryError,
    RunStats,
    verdict_of,
)
from app.performance.schemas import DailyPerformance, RuleRun, VersionDaily, VersionPerformance
from app.query.periods import Period
from app.query.schemas import Column
from app.query.sql_checks import mask_sql

log = logging.getLogger(__name__)

# Colonnes renvoyées par « SELECT * » dans le BigQuery simulé.
_STAR_COLUMNS = ["order_id", "customer_id", "order_date", "amount_eur"]


def select_columns(sql: str) -> list[str]:
    """Noms des colonnes de la dernière projection SELECT de premier niveau (BigQuery simulé) :
    alias (AS x), sinon dernier identifiant (o.amount_eur → amount_eur), sinon f0_, f1_…"""
    masked = mask_sql(sql)
    depth, select_at, from_at = 0, None, None
    for m in re.finditer(r"[()]|\b(SELECT|FROM)\b", masked, re.I):
        tok = m.group(0)
        if tok == "(":
            depth += 1
        elif tok == ")":
            depth -= 1
        elif depth == 0 and tok.upper() == "SELECT":
            select_at, from_at = m.end(), None
        elif depth == 0 and tok.upper() == "FROM" and select_at is not None and from_at is None:
            from_at = m.start()
    if select_at is None:
        return ["f0_"]
    items, depth, start = [], 0, select_at
    body = masked[select_at : from_at if from_at is not None else len(masked)]
    for i, ch in enumerate(body):
        depth += ch == "("
        depth -= ch == ")"
        if ch == "," and depth == 0:
            items.append(body[start - select_at : i])
            start = select_at + i + 1
    items.append(body[start - select_at :])
    cols: list[str] = []
    for k, item in enumerate(i.strip() for i in items):
        item = re.sub(r"^(DISTINCT|ALL)\s+", "", item, flags=re.I)
        alias = re.search(r"\bAS\s+(\w+)\s*$", item, re.I)
        if alias:
            cols.append(alias.group(1))
        elif item.endswith("*"):
            cols.extend(c for c in _STAR_COLUMNS if c not in cols)
        elif ident := re.fullmatch(r"(?:\w+\.)*(\w+)", item):
            cols.append(ident.group(1))
        else:
            cols.append(f"f{k}_")
    return cols


@dataclass
class FakeBigQueryGateway:
    """Simule un dry-run réussi sur toute requête commençant par SELECT/WITH.

    Les tests peuvent pré-remplir `next_dry_run` / `next_error` pour forcer un cas.
    """

    bytes_processed: int = 6 * 10**9
    next_dry_run: DryRunMeta | None = None
    next_error: QueryError | None = None
    # Contenu simulé de v_rule_performance (une ligne par version et par jour)…
    performance: dict[str, list[DailyPerformance]] = field(default_factory=dict)
    # … et de v_rule_orders_daily (règle toutes versions confondues) ; à défaut, le même contenu.
    rule_daily: dict[str, list[DailyPerformance]] = field(default_factory=dict)
    # Contenu simulé de rules_registry : rule_id → [(version, statut, envoi au prestataire)].
    registry: dict[str, list[tuple[int, str, bool]]] = field(default_factory=dict)
    stats: list[RunStats] = field(default_factory=list)
    overlap: list[tuple[str, int]] = field(default_factory=list)
    last_period: Period | None = None  # période passée au dernier appel (contrôlée par les tests)
    run_history: list[tuple[str, RuleRun]] = field(default_factory=list)

    def dry_run(self, sql, period):
        self.last_period = period
        if self.next_error:
            err, self.next_error = self.next_error, None
            raise err
        if self.next_dry_run:
            meta, self.next_dry_run = self.next_dry_run, None
            return meta
        m = re.match(r"\s*(\w+)", sql)
        first = m.group(1).upper() if m else "UNKNOWN"
        stype = "SELECT" if first in ("SELECT", "WITH") else first
        cols = [Column(name=c, type="STRING") for c in select_columns(sql)]
        return DryRunMeta(stype, self.bytes_processed, cols)

    def execute(self, sql, period, exclude_rule_id=None, overlap_days=90):
        meta = self.dry_run(sql, period)
        cols = [c.name for c in meta.schema]
        rows = [{c: f"ORD-{1000 + i}" if c == "order_id" else f"{c}-{i}" for c in cols} for i in range(5)]
        # Commandes « déjà remontées » simulées : (rule_id, nombre) prérempli par les tests.
        hits = [(r, n) for r, n in self.overlap if r != exclude_rule_id]
        overlap = Overlap(5, min(5, sum(n for _, n in hits)))
        return ExecMeta(cols, rows, 5, 1200, meta.bytes_processed, overlap)

    def daily_performance(self, rule_id, start, end, sent=False):
        rows = self.rule_daily.get(rule_id, self.performance.get(rule_id, []))
        return [d for d in rows if start <= d.date <= end]

    # Exécutions simulées (rule_runs, dernière tentative de chacune), préremplies par les tests.
    def runs(self, rule_id, start, end, limit=20):
        out = [r for rid, r in self.run_history if rid == rule_id and start <= r.run_date <= end]
        return sorted(out, key=lambda r: r.started_at, reverse=True)[:limit]

    def version_daily(self, rule_id, start, end):
        return [
            VersionDaily(
                date=d.date,
                rule_version=d.rule_version or 0,
                to_send=d.orders_to_send > 0,
                orders_flagged=d.orders_flagged,
                orders_processed=d.orders_processed,
                orders_confirmed_fraud=d.orders_confirmed_fraud,
            )
            for d in self.performance.get(rule_id, [])
            if start <= d.date <= end
        ]

    def version_totals(self, rule_id):
        by: dict[int, list[DailyPerformance]] = {}
        for d in self.performance.get(rule_id, []):
            by.setdefault(d.rule_version or 0, []).append(d)
        return [
            VersionPerformance(
                version=v,
                first_date=min(d.date for d in ds),
                last_date=max(d.date for d in ds),
                days=len(ds),
                orders_flagged=sum(d.orders_flagged for d in ds),
                orders_processed=sum(d.orders_processed for d in ds),
                orders_confirmed_fraud=sum(d.orders_confirmed_fraud for d in ds),
            )
            for v, ds in sorted(by.items())
        ]

    def production_totals(self, rules, start, end):
        out = []
        for rid in rules:
            d = self.daily_performance(rid, start, end)
            out.append(
                ProductionTotals(
                    rid,
                    sum(x.orders_flagged for x in d),
                    sum(x.orders_processed for x in d),
                    sum(x.orders_confirmed_fraud for x in d),
                    sum(x.orders_to_send for x in d),
                    sum(x.orders_flagged - x.orders_to_send for x in d),
                )
            )
        return out

    def run_stats(self):
        return list(self.stats)

    # Alertes simulées (rule_alerts + retour prestataire), préremplies par les tests :
    # (AlertRow sans verdict ni qualification, la commande est-elle vérifiée par le prestataire ?).
    alert_rows: list[tuple[AlertRow, bool]] = field(default_factory=list)
    # Qualifications (alert_reviews), dans l'ordre : (order_id, is_fraud, matricule, horodatage).
    reviews: list[tuple[str, bool | None, str, datetime]] = field(default_factory=list)

    def alerts(self, f):
        last = {o: (v, by, at) for o, v, by, at in self.reviews}
        out = []
        for a, has_feedback in self.alert_rows:
            if not (f.start <= a.run_date <= f.end) or (f.rule_id and a.rule_id != f.rule_id):
                continue
            if f.phase and a.to_send != (f.phase == "PRODUCTION"):
                continue
            if f.q and f.q not in a.order_id:
                continue
            review, by, at = last.get(a.order_id, (None, None, None))
            verdict = verdict_of(a.to_send, a.provider_is_fraud, has_feedback, review)
            out.append(
                AlertRow(
                    a.order_id,
                    a.rule_id,
                    a.rule_version,
                    a.run_date,
                    a.detected_at,
                    a.to_send,
                    verdict,
                    a.provider_is_fraud if has_feedback else None,
                    review,
                    by if review is not None else None,
                    at if review is not None else None,
                    a.details,
                )
            )
        to_review = sum(x.verdict == "TO_REVIEW" for x in out)
        out = [x for x in out if not f.verdict or x.verdict == f.verdict]
        out.sort(key=lambda x: (x.detected_at, x.order_id), reverse=True)
        return out[f.offset : f.offset + f.limit], len(out), to_review

    def add_review(self, order_id, rule_id, version, is_fraud, by):
        ok = any(
            a.order_id == order_id and a.rule_id == rule_id and a.rule_version == version and not a.to_send
            for a, _ in self.alert_rows
        )
        if ok:
            self.reviews.append((order_id, is_fraud, by, datetime.now(UTC)))
        return ok

    def set_registry(self, rule, rows):
        log.info("rules_registry ← %s %s", rule.rule_id, [(v.version, st, s) for v, st, s in rows])
        if rows:
            self.registry[rule.rule_id] = [(v.version, st, send) for v, st, send in rows]
        else:
            self.registry.pop(rule.rule_id, None)
