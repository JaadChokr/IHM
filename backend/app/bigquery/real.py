"""Passerelle BigQuery réelle (google-cloud-bigquery)."""

import json
import logging
import time
from typing import Any

from app.bigquery.contract import (
    AlertFilter,
    AlertRow,
    BytesLimitExceeded,
    DryRunMeta,
    ExecMeta,
    Overlap,
    ProductionTotals,
    QueryError,
    RunStats,
)
from app.core.config import Settings
from app.performance.schemas import DailyPerformance, RuleRun, VersionDaily, VersionPerformance
from app.query.periods import Period
from app.query.schemas import Column

log = logging.getLogger(__name__)


class RealBigQueryGateway:
    def __init__(self, settings: Settings):
        from google.cloud import bigquery

        self._bq = bigquery
        self.settings = settings
        self.client = bigquery.Client(project=settings.gcp_project or None, location=settings.bq_location)
        self.ds = f"`{self.client.project}.{settings.bq_dataset}`"

    def _config(self, **kw):
        return self._bq.QueryJobConfig(use_query_cache=False, labels={"app": "rules-manager"}, **kw)

    def _period(self, period: Period) -> list:
        # Les deux paramètres sont toujours passés, comme le fait Airflow : BigQuery ignore ceux que la
        # requête n'utilise pas.
        P = self._bq.ScalarQueryParameter
        return [P("period_start", "TIMESTAMP", period.start), P("period_end", "TIMESTAMP", period.end)]

    def dry_run(self, sql, period):
        from google.api_core.exceptions import GoogleAPICallError

        try:
            cfg = self._config(dry_run=True, query_parameters=self._period(period))
            job = self.client.query(sql, job_config=cfg)
        except GoogleAPICallError as e:
            raise QueryError(getattr(e, "message", str(e))) from e
        schema = [Column(name=f.name, type=f.field_type) for f in (job.schema or [])]
        return DryRunMeta(job.statement_type or "UNKNOWN", job.total_bytes_processed or 0, schema)

    def execute(self, sql, period, exclude_rule_id=None, overlap_days=90):
        from google.api_core.exceptions import GoogleAPICallError

        cfg = self._config(
            maximum_bytes_billed=self.settings.max_bytes_billed, query_parameters=self._period(period)
        )
        cfg.job_timeout_ms = self.settings.job_timeout_ms
        start = time.monotonic()
        try:
            job = self.client.query(sql, job_config=cfg)
            it = job.result(
                max_results=self.settings.max_results, timeout=self.settings.job_timeout_ms / 1000
            )
            rows = [{k: _jsonable(v) for k, v in r.items()} for r in it]
        except GoogleAPICallError as e:
            msg = getattr(e, "message", str(e))
            if "bytesBilledLimitExceeded" in str(e) or "bytes billed" in msg.lower():
                raise BytesLimitExceeded(msg) from e
            raise QueryError(msg) from e
        duration_ms = int((time.monotonic() - start) * 1000)
        return ExecMeta(
            columns=[f.name for f in it.schema],
            rows=rows,
            total_rows=it.total_rows or 0,
            duration_ms=duration_ms,
            bytes_processed=job.total_bytes_processed or 0,
            overlap=self._overlap(job.destination, exclude_rule_id, overlap_days),
        )

    def _overlap(self, dest, exclude_rule_id: str | None, days: int) -> Overlap:
        """Lit le résultat du job (table temporaire) : la requête de la règle n'est pas rejouée."""
        from google.api_core.exceptions import GoogleAPICallError

        P = self._bq.ScalarQueryParameter
        result = f"`{dest.project}.{dest.dataset_id}.{dest.table_id}`"
        ids = f"SELECT DISTINCT CAST(order_id AS STRING) AS order_id FROM {result}"
        sql = f"""
        WITH ids AS ({ids}),
        hits AS (
          SELECT a.order_id
          FROM ids JOIN {self.ds}.rule_alerts a USING (order_id)
          WHERE a.run_date >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)
            AND (@exclude IS NULL OR a.rule_id != @exclude)
        )
        SELECT
          (SELECT COUNT(*) FROM ids) AS orders,
          (SELECT COUNT(DISTINCT order_id) FROM hits) AS already
        """
        cfg = self._config(maximum_bytes_billed=self.settings.max_bytes_billed)
        cfg.query_parameters = [P("days", "INT64", days), P("exclude", "STRING", exclude_rule_id)]
        try:
            r = next(iter(self.client.query(sql, job_config=cfg).result()))
            return Overlap(r["orders"], r["already"])
        except GoogleAPICallError:
            # rule_alerts absente ou illisible : on donne au moins le nombre de commandes.
            log.warning("comparaison avec rule_alerts impossible", exc_info=True)
            r = next(iter(self.client.query(f"SELECT COUNT(*) AS orders FROM ({ids})").result()))
            return Overlap(r["orders"], None)

    def _rows(self, sql: str, params: list) -> list[dict]:
        cfg = self._bq.QueryJobConfig(query_parameters=params)
        return [dict(r.items()) for r in self.client.query(sql, job_config=cfg).result()]

    def daily_performance(self, rule_id, start, end, sent=False):
        # Une règle en production : ses commandes à transmettre (to_send) ; en test : les autres.
        # Une version précise, candidate comprise, se lit dans le comparatif (version_totals).
        P = self._bq.ScalarQueryParameter
        rows = self._rows(
            f"""SELECT run_date, MAX(rule_version) AS rule_version,
                       COUNT(DISTINCT order_id) AS orders_flagged,
                       COUNT(DISTINCT IF(is_verified, order_id, NULL)) AS orders_processed,
                       COUNT(DISTINCT IF(is_confirmed, order_id, NULL)) AS orders_confirmed_fraud
                FROM {self.ds}.v_rule_orders
                WHERE rule_id = @rule_id AND run_date BETWEEN @start AND @end AND to_send = @sent
                GROUP BY run_date
                ORDER BY run_date""",
            [
                P("rule_id", "STRING", rule_id),
                P("start", "DATE", start),
                P("end", "DATE", end),
                P("sent", "BOOL", sent),
            ],
        )
        return [
            DailyPerformance(
                date=r["run_date"],
                rule_version=r["rule_version"],
                orders_flagged=r["orders_flagged"],
                orders_to_send=r["orders_flagged"] if sent else 0,
                orders_processed=r["orders_processed"],
                orders_confirmed_fraud=r["orders_confirmed_fraud"],
            )
            for r in rows
        ]

    def version_daily(self, rule_id, start, end):
        P = self._bq.ScalarQueryParameter
        rows = self._rows(
            f"""SELECT run_date, rule_version, to_send,
                       COUNT(DISTINCT order_id) AS orders_flagged,
                       COUNT(DISTINCT IF(is_verified, order_id, NULL)) AS orders_processed,
                       COUNT(DISTINCT IF(is_confirmed, order_id, NULL)) AS orders_confirmed_fraud
                FROM {self.ds}.v_rule_orders
                WHERE rule_id = @rule_id AND run_date BETWEEN @start AND @end
                GROUP BY run_date, rule_version, to_send
                ORDER BY run_date, rule_version""",
            [P("rule_id", "STRING", rule_id), P("start", "DATE", start), P("end", "DATE", end)],
        )
        return [VersionDaily.model_validate({**r, "date": r["run_date"]}) for r in rows]

    def version_totals(self, rule_id):
        rows = self._rows(
            f"""SELECT rule_version AS version, MIN(run_date) AS first_date, MAX(run_date) AS last_date,
                       COUNT(*) AS days, SUM(orders_flagged) AS orders_flagged,
                       SUM(orders_processed) AS orders_processed,
                       SUM(orders_confirmed_fraud) AS orders_confirmed_fraud
                FROM {self.ds}.v_rule_performance
                WHERE rule_id = @rule_id
                GROUP BY rule_version
                ORDER BY rule_version""",
            [self._bq.ScalarQueryParameter("rule_id", "STRING", rule_id)],
        )
        return [VersionPerformance.model_validate(r) for r in rows]

    def runs(self, rule_id, start, end, limit=20):
        P = self._bq.ScalarQueryParameter
        rows = self._rows(
            # Une ligne par exécution : sa dernière tentative, avec le nombre de tentatives.
            f"""SELECT *, COUNT(*) OVER (PARTITION BY run_id) AS attempts FROM {self.ds}.rule_runs
                WHERE rule_id = @rule_id AND run_date BETWEEN @start AND @end
                QUALIFY ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY started_at DESC) = 1
                ORDER BY started_at DESC LIMIT @limit""",
            [
                P("rule_id", "STRING", rule_id),
                P("start", "DATE", start),
                P("end", "DATE", end),
                P("limit", "INT64", limit),
            ],
        )
        return [RuleRun.model_validate(r) for r in rows]

    def production_totals(self, rules, start, end):
        if not rules:
            return []
        P = self._bq.ScalarQueryParameter
        A = self._bq.ArrayQueryParameter
        rows = self._rows(
            # Commandes distinctes sur toute la période : exact même si deux versions ont remonté la même
            # commande à des jours différents. En production : commandes à transmettre ; sinon les autres.
            # Les commandes envoyées et celles observées sont aussi comptées à part, quel que soit l'état.
            f"""SELECT rule_id,
                       COUNT(DISTINCT IF(kept, order_id, NULL)) AS flagged,
                       COUNT(DISTINCT IF(kept AND is_verified, order_id, NULL)) AS processed,
                       COUNT(DISTINCT IF(kept AND is_confirmed, order_id, NULL)) AS confirmed,
                       COUNT(DISTINCT IF(to_send, order_id, NULL)) AS to_send,
                       COUNT(DISTINCT IF(NOT to_send, order_id, NULL)) AS observed
                FROM (
                  SELECT *, (rule_id IN UNNEST(@sent_ids)) = to_send AS kept
                  FROM {self.ds}.v_rule_orders
                  WHERE run_date BETWEEN @start AND @end
                    AND rule_id IN UNNEST(ARRAY_CONCAT(@sent_ids, @observed_ids))
                )
                GROUP BY rule_id""",
            [
                A("sent_ids", "STRING", [r for r, sent in rules.items() if sent]),
                A("observed_ids", "STRING", [r for r, sent in rules.items() if not sent]),
                P("start", "DATE", start),
                P("end", "DATE", end),
            ],
        )
        return [
            ProductionTotals(
                r["rule_id"],
                r["flagged"] or 0,
                r["processed"] or 0,
                r["confirmed"] or 0,
                r["to_send"] or 0,
                r["observed"] or 0,
            )
            for r in rows
        ]

    def run_stats(self):
        rows = self._rows(
            # Seuls les runs réussis comptent : une version dont le premier run a échoué n'a pas encore
            # tourné (elle reste « Publiée »), et une version qui échoue à chaque run devient inactive.
            f"""SELECT rule_id, rule_version, MIN(started_at) AS first_run_at, MAX(started_at) AS last_run_at,
                       ARRAY_AGG(airflow_dag_id ORDER BY started_at DESC LIMIT 1)[OFFSET(0)] AS dag_id
                FROM {self.ds}.rule_runs
                WHERE status = 'SUCCESS'
                GROUP BY rule_id, rule_version""",
            [],
        )
        return [RunStats(**r) for r in rows]

    def alerts(self, f):
        P = self._bq.ScalarQueryParameter
        table = self.settings.bq_feedback_table
        fb = (
            f"SELECT order_id, LOGICAL_OR(is_fraud) AS is_fraud FROM `{table}` GROUP BY order_id"
            if table
            else "SELECT CAST(NULL AS STRING) AS order_id, CAST(NULL AS BOOL) AS is_fraud LIMIT 0"
        )
        sql = f"""
            WITH reviews AS (
              SELECT order_id, is_fraud, reviewed_by, reviewed_at FROM {self.ds}.alert_reviews
              QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY reviewed_at DESC) = 1
            ),
            fb AS ({fb}),
            base AS (
              SELECT a.order_id, a.rule_id, a.rule_version, a.run_date, a.detected_at,
                     IFNULL(a.to_send, FALSE) AS to_send, TO_JSON_STRING(a.details) AS details,
                     fb.order_id IS NOT NULL AS has_feedback, fb.is_fraud AS provider_is_fraud,
                     r.is_fraud AS review_is_fraud, r.reviewed_by, r.reviewed_at
              FROM {self.ds}.rule_alerts a
              LEFT JOIN fb USING (order_id)
              LEFT JOIN reviews r USING (order_id)
              WHERE a.run_date BETWEEN @start AND @end
                AND (@rule_id IS NULL OR a.rule_id = @rule_id)
                AND (@phase IS NULL OR IFNULL(a.to_send, FALSE) = (@phase = 'PRODUCTION'))
                AND (@q IS NULL OR STRPOS(a.order_id, @q) > 0)
            ),
            judged AS (
              SELECT *,
                     CASE WHEN has_feedback THEN IF(provider_is_fraud, 'FRAUD', 'NOT_FRAUD')
                          WHEN to_send THEN 'PENDING'
                          WHEN review_is_fraud IS NULL THEN 'TO_REVIEW'
                          WHEN review_is_fraud THEN 'FRAUD' ELSE 'NOT_FRAUD' END AS verdict
              FROM base
            ),
            counted AS (SELECT *, COUNTIF(verdict = 'TO_REVIEW') OVER () AS to_review FROM judged)
            SELECT *, COUNT(*) OVER () AS total
            FROM counted
            WHERE @verdict IS NULL OR verdict = @verdict
            ORDER BY detected_at DESC, order_id
            LIMIT @limit OFFSET @offset"""
        rows = self._rows(
            sql,
            [
                P("start", "DATE", f.start),
                P("end", "DATE", f.end),
                P("rule_id", "STRING", f.rule_id),
                P("phase", "STRING", f.phase),
                P("verdict", "STRING", f.verdict),
                P("q", "STRING", f.q),
                P("limit", "INT64", f.limit),
                P("offset", "INT64", f.offset),
            ],
        )
        if not rows and f.offset:
            # Au-delà de la dernière page : totaux recomptés sur la première.
            _, total, to_review = self.alerts(AlertFilter(**{**f.__dict__, "limit": 1, "offset": 0}))
            return [], total, to_review
        items = [
            AlertRow(
                order_id=r["order_id"],
                rule_id=r["rule_id"],
                rule_version=r["rule_version"],
                run_date=r["run_date"],
                detected_at=r["detected_at"],
                to_send=r["to_send"],
                verdict=r["verdict"],
                provider_is_fraud=r["provider_is_fraud"] if r["has_feedback"] else None,
                review_is_fraud=r["review_is_fraud"],
                reviewed_by=r["reviewed_by"],
                reviewed_at=r["reviewed_at"],
                details=json.loads(r["details"]) if r["details"] else None,
            )
            for r in rows
        ]
        return items, (rows[0]["total"] if rows else 0), (rows[0]["to_review"] if rows else 0)

    def add_review(self, order_id, rule_id, version, is_fraud, by):
        P = self._bq.ScalarQueryParameter
        # Ajout seulement, et seulement pour une alerte en test de cette version (non transmise au
        # prestataire) : une commande transmise est vérifiée par le prestataire.
        sql = f"""
            INSERT INTO {self.ds}.alert_reviews
              (order_id, is_fraud, reviewed_by, reviewed_at, rule_id, rule_version)
            SELECT @order_id, @is_fraud, @by, CURRENT_TIMESTAMP(), @rule_id, @version
            FROM UNNEST([1])
            WHERE EXISTS (
              SELECT 1 FROM {self.ds}.rule_alerts
              WHERE order_id = @order_id AND rule_id = @rule_id AND rule_version = @version
                AND NOT IFNULL(to_send, FALSE)
            )"""
        params = [
            P("order_id", "STRING", order_id),
            P("is_fraud", "BOOL", is_fraud),
            P("by", "STRING", by),
            P("rule_id", "STRING", rule_id),
            P("version", "INT64", version),
        ]
        job = self.client.query(sql, job_config=self._bq.QueryJobConfig(query_parameters=params))
        job.result()
        return bool(job.num_dml_affected_rows)

    def set_registry(self, rule, rows):
        P = self._bq.ScalarQueryParameter
        keep = [v.version for v, *_ in rows]
        # Versions arrêtées (remplacées, écartées, reprises en brouillon) : leurs lignes disparaissent.
        cfg = self._bq.QueryJobConfig(
            query_parameters=[
                P("rule_id", "STRING", rule.rule_id),
                self._bq.ArrayQueryParameter("keep", "INT64", keep),
            ]
        )
        sql = f"""DELETE FROM {self.ds}.rules_registry
                  WHERE rule_id = @rule_id AND version NOT IN UNNEST(@keep)"""
        self.client.query(sql, job_config=cfg).result()
        for v, status, send in rows:
            params = [
                P("rule_id", "STRING", v.rule_id),
                P("version", "INT64", v.version),
                P("name", "STRING", v.name),
                P("description", "STRING", v.description),
                P("fraud_typology", "STRING", v.fraud_typology),
                P("criticality", "STRING", v.criticality),
                P("schedule", "STRING", v.schedule),
                P("schedule_every", "INT64", v.schedule_every or 1),
                P("sql_query", "STRING", v.sql_query),
                P("status", "STRING", status),
                P("send_to_provider", "BOOL", send),
                P("owner_matricule", "STRING", rule.owner_matricule),
                P("created_at", "TIMESTAMP", rule.created_at),
                P("updated_at", "TIMESTAMP", v.updated_at),
            ]
            # Clé : (rule_id, version). Au plus deux lignes par règle : la version en production et une
            # candidate. L'historique des versions reste dans la base de la plateforme (rule_versions).
            sql = f"""
            MERGE {self.ds}.rules_registry t
            USING (SELECT @rule_id AS rule_id, @version AS version) s
            ON t.rule_id = s.rule_id AND t.version = s.version
            WHEN MATCHED THEN UPDATE SET
              name = @name, description = @description, fraud_typology = @fraud_typology,
              criticality = @criticality, schedule = @schedule, schedule_every = @schedule_every,
              sql_query = @sql_query, status = @status,
              send_to_provider = @send_to_provider, updated_at = @updated_at
            WHEN NOT MATCHED THEN INSERT
              (rule_id, version, name, description, fraud_typology, criticality, schedule, schedule_every,
               sql_query, status, send_to_provider, owner_matricule, created_at, updated_at)
            VALUES (@rule_id, @version, @name, @description, @fraud_typology, @criticality, @schedule,
                    @schedule_every, @sql_query, @status, @send_to_provider, @owner_matricule, @created_at,
                    @updated_at)
            """
            self.client.query(sql, job_config=self._bq.QueryJobConfig(query_parameters=params)).result()


def _jsonable(v: Any) -> Any:
    if isinstance(v, str | int | float | bool) or v is None:
        return v
    return str(v)
