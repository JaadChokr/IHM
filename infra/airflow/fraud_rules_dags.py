"""DAG de référence : un DAG par fréquence de règles (horaire, quotidienne, hebdomadaire).

À adapter par l'équipe data (connexion, alertes). Chaque DAG lit `rules_registry`
à chaque exécution et lance une tâche par règle de sa fréquence (mappage dynamique, Airflow 2.9 ou plus) :
une règle publiée est prise en charge dès le run suivant, sans action manuelle.

Période du run : la requête de la règle reçoit `@period_start` / `@period_end` (TIMESTAMP), bornes
[début, fin[ de l'intervalle du run, calées par Airflow sur le cron du DAG (heure de Paris) : 1 h en
horaire, de 3 h à 3 h en quotidien, du lundi 4 h au lundi 4 h en hebdomadaire. Un rattrapage (catchup) ou
une relance d'un run passé repasse donc les bornes de la période d'origine, sans réécrire la requête.
L'IHM teste la requête avec la dernière période complète du même calendrier (backend/app/periods.py :
garder les crons alignés).

Pour chaque règle, la tâche :
  1. exécute `sql_query` et écrit dans `rule_alerts` les commandes que **cette version** n'a encore jamais
     remontées (une seule fois chacune) : une fenêtre glissante ou une règle écrite avec CURRENT_DATE() ne
     crée pas de doublon, et chaque version est mesurée sur tout ce qu'elle trouve ;
  2. marque chacune `to_send` (« à transmettre au prestataire ») si la règle est en production à ce run
     (`send_to_provider` de rules_registry, décision de l'analyste) et si la règle ne l'a jamais marquée,
     toutes versions confondues : la décision est figée au moment du run ;
  3. trace l'exécution dans `rule_runs` (version, période, statut) : c'est ce que lit la plateforme.

Envoi au prestataire : le DAG n'envoie rien. Un script externe lit dans `rule_alerts` les lignes
`to_send AND sent_at IS NULL`, les transmet (dédoublonnées par commande, toutes règles confondues) et
renseigne `sent_at`.

Relance et rattrapage : la requête est exécutée telle quelle, tables lues au présent.
  - Avec une plage @period_start / @period_end, elle porte sur la période d'origine : résultat exact.
  - Sans plage, elle relit toute la table : rien n'est perdu ni doublé (dédoublonnage par règle et par
    version), mais les commandes passées depuis sont rattachées au run rejoué. L'IHM incite à poser une
    plage, qui évite aussi de relire chaque fois un volume inutilement grand.
L'analyste peut dater lui-même une table (FOR SYSTEM_TIME AS OF @period_end) ; BigQuery ne le permet que
sur 7 jours : au-delà, la tâche échoue avec un message explicite.

Variables Airflow : fraud_rules_gcp_conn_id (google_cloud_default), fraud_rules_project (obligatoire),
fraud_rules_dataset (fraud_rules), fraud_rules_alert_emails (adresses séparées par des virgules, facultatif).
"""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime, timedelta

import pendulum
from airflow.decorators import dag, task
from airflow.exceptions import AirflowException
from airflow.models import Variable
from airflow.operators.python import get_current_context
from airflow.providers.google.cloud.hooks.bigquery import BigQueryHook
from google.cloud import bigquery

log = logging.getLogger("airflow.task")

TZ = "Europe/Paris"
# Fréquence de la règle (colonne `schedule` de rules_registry) → cron du DAG, en heure de Paris.
# À garder alignés sur backend/app/periods.py (période testée dans l'IHM).
SCHEDULES = {
    "HOURLY": "5 * * * *",  # toutes les heures, à h+5
    "DAILY": "0 3 * * *",  # chaque nuit à 3 h
    "WEEKLY": "0 4 * * 1",  # le lundi à 4 h
}
# Garde-fou : le SQL des règles est saisi dans l'IHM, pas relu ici.
MAX_BYTES_BILLED = 200 * 1024**3  # 200 Gio par requête
# Un run qui démarre plus tard que ça après la fin de sa période est un rattrapage ou une relance.
LATE_AFTER = timedelta(minutes=30)
# Voyage dans le temps de BigQuery : 7 jours au plus (marge pour la durée du run).
TIME_TRAVEL_MAX = timedelta(days=7) - timedelta(hours=1)
_TIME_TRAVEL = re.compile(r"\bFOR\s+SYSTEM_TIME\s+AS\s+OF\b", re.IGNORECASE)


def _bq() -> tuple[bigquery.Client, str]:
    """Client BigQuery issu de la connexion Airflow, et dataset des règles. Créé à l'exécution de la
    tâche, jamais à l'analyse du fichier (pas de connexion GCP à chaque passage du scheduler)."""
    hook = BigQueryHook(
        gcp_conn_id=Variable.get("fraud_rules_gcp_conn_id", default_var="google_cloud_default"),
        use_legacy_sql=False,
    )
    project = Variable.get("fraud_rules_project")
    dataset = Variable.get("fraud_rules_dataset", default_var="fraud_rules")
    return hook.get_client(project_id=project), f"`{project}.{dataset}`"


def _query(client: bigquery.Client, sql: str, **params: tuple[str, object]):
    """Requête paramétrée, attendue jusqu'au bout (num_dml_affected_rows n'est connu qu'après) : chaque
    paramètre est (type BigQuery, valeur) ; « ARRAY<STRING> » pour un tableau."""
    qp = [
        bigquery.ArrayQueryParameter(k, t[6:-1], v)
        if t.startswith("ARRAY<")
        else bigquery.ScalarQueryParameter(k, t, v)
        for k, (t, v) in params.items()
    ]
    cfg = bigquery.QueryJobConfig(query_parameters=qp, maximum_bytes_billed=MAX_BYTES_BILLED)
    job = client.query(sql, job_config=cfg)
    job.result()
    return job


def _emails() -> list[str]:
    raw = Variable.get("fraud_rules_alert_emails", default_var="")
    return [e.strip() for e in raw.split(",") if e.strip()]


def make_dag(frequency: str, cron: str):
    @dag(
        dag_id=f"fraud_rules_{frequency.lower()}",
        schedule=cron,
        # Fuseau de Paris : le cron suit l'heure locale, changements d'heure compris.
        start_date=pendulum.datetime(2026, 11, 1, tz=TZ),
        # Rattrapage des périodes manquées (déploiement, panne) : sans doublon grâce au dédoublonnage par
        # version, et chaque run reçoit les bornes de sa propre période.
        catchup=True,
        max_active_runs=3,
        max_active_tasks=8,  # règles exécutées en parallèle
        default_args={
            "owner": "fraud-rules",
            # Deux DELETE simultanés sur rule_alerts peuvent échouer (mise à jour concurrente) : une
            # nouvelle tentative suffit, et l'identifiant de run stable la rend sans effet de bord.
            "retries": 2,
            "retry_delay": timedelta(minutes=5),
            "email_on_failure": True,
            "email_on_retry": False,
            "email": _emails(),
        },
        # Pas d'e-mail de succès : 24 par jour pour le DAG horaire, et une rafale à chaque rattrapage.
        tags=["fraud-rules"],
    )
    def fraud_rules():
        @task
        def get_rules() -> list[dict]:
            """Règles de cette fréquence : une ligne par règle, sa dernière version non écartée. Pour un
            rattrapage de moins de 7 jours, le référentiel tel qu'il était en fin de période : c'est la
            version alors en place qui est exécutée (au-delà : la version actuelle)."""
            client, ds = _bq()
            end = get_current_context()["data_interval_end"]
            late = datetime.now(UTC) - end
            when = " FOR SYSTEM_TIME AS OF @period_end" if LATE_AFTER < late < TIME_TRAVEL_MAX else ""
            rows = _query(
                client,
                f"SELECT rule_id, version, name, sql_query, send_to_provider FROM {ds}.rules_registry{when}"
                " WHERE schedule = @schedule",
                schedule=("STRING", frequency),
                **({"period_end": ("TIMESTAMP", end)} if when else {}),
            ).result()
            return [dict(r.items()) for r in rows]

        @task(map_index_template="{{ rule_name }}")
        def run_rule(rule: dict) -> None:
            context = get_current_context()
            context["rule_name"] = f"{rule['name']} (v{rule['version']})"  # nom affiché dans Airflow
            client, ds = _bq()
            dag_id = context["dag"].dag_id
            # Identifiant stable entre deux tentatives : une nouvelle tentative remplace les commandes
            # (pas encore transmises) de la tentative ratée.
            run_id = f"{context['run_id']}__{rule['rule_id']}"
            period_start = context["data_interval_start"]
            period_end = context["data_interval_end"]
            run_date = period_end.in_timezone(TZ).date()
            started = datetime.now(UTC)
            ids = {"rule_id": ("STRING", rule["rule_id"]), "version": ("INT64", rule["version"])}
            sql = rule["sql_query"].strip().rstrip(";")
            status, rows, to_send, error = "SUCCESS", None, None, None
            try:
                if _TIME_TRAVEL.search(sql) and started - period_end > TIME_TRAVEL_MAX:
                    raise AirflowException(
                        f"Période terminée le {period_end.in_timezone(TZ):%d/%m/%Y %H:%M} : la règle date "
                        "elle-même une table (FOR SYSTEM_TIME AS OF), ce que BigQuery ne permet que sur "
                        "7 jours. Run à traiter à la main (ou à laisser de côté)."
                    )
                _query(
                    client,
                    f"""DELETE FROM {ds}.rule_alerts
                        WHERE rule_id = @rule_id AND run_id = @run_id
                          AND sent_at IS NULL  -- déjà transmises par le script d'envoi : gardées""",
                    rule_id=ids["rule_id"],
                    run_id=("STRING", run_id),
                )
                # @period_start / @period_end sont destinés à la requête de la règle : un paramètre est
                # visible dans toute la requête, sous-requête comprise. Filtrer à l'intérieur de {sql}
                # permet l'élagage des partitions. Retour à la ligne avant la parenthèse fermante : une
                # requête qui finit par un commentaire « -- … » ne la commente pas.
                job = _query(
                    client,
                    f"""INSERT INTO {ds}.rule_alerts
                          (rule_id, rule_version, run_id, run_date, order_id, detected_at, details, to_send)
                        SELECT @rule_id, @version, @run_id, @run_date,
                               CAST(t.order_id AS STRING), CURRENT_TIMESTAMP(), TO_JSON(t),
                               -- À transmettre : règle en production à ce run, et commande jamais
                               -- marquée par la règle (une autre version a pu la remonter avant).
                               @send AND NOT EXISTS (
                                 SELECT 1 FROM {ds}.rule_alerts s
                                 WHERE s.rule_id = @rule_id AND s.order_id = CAST(t.order_id AS STRING)
                                   AND s.to_send
                               )
                        FROM (
                    {sql}
                        ) AS t
                        -- Une commande n'est écrite qu'une fois par version de règle.
                        WHERE t.order_id IS NOT NULL
                          AND NOT EXISTS (
                          SELECT 1 FROM {ds}.rule_alerts a
                          WHERE a.rule_id = @rule_id AND a.rule_version = @version
                            AND a.order_id = CAST(t.order_id AS STRING)
                        )
                        QUALIFY ROW_NUMBER() OVER (PARTITION BY CAST(t.order_id AS STRING)) = 1""",
                    **ids,
                    run_id=("STRING", run_id),
                    run_date=("DATE", run_date),
                    send=("BOOL", bool(rule["send_to_provider"])),
                    period_start=("TIMESTAMP", period_start),
                    period_end=("TIMESTAMP", period_end),
                )
                rows = job.num_dml_affected_rows
                to_send = list(
                    _query(
                        client,
                        f"""SELECT COUNTIF(to_send) AS n FROM {ds}.rule_alerts
                            WHERE run_date = @run_date AND rule_id = @rule_id AND run_id = @run_id""",
                        rule_id=ids["rule_id"],
                        run_id=("STRING", run_id),
                        run_date=("DATE", run_date),
                    ).result()
                )[0]["n"]
            except Exception as e:  # tracé dans rule_runs, puis relancé pour qu'Airflow le voie
                status, error = "FAILED", str(e)[:2000]
                raise AirflowException(error) from e
            finally:
                try:
                    _query(
                        client,
                        f"""INSERT INTO {ds}.rule_runs
                              (run_id, rule_id, rule_version, airflow_dag_id, run_date, period_start,
                               period_end, started_at, finished_at, status, rows_returned, rows_to_send,
                               error_message)
                            VALUES (@run_id, @rule_id, @version, @dag_id, @run_date, @period_start,
                                    @period_end, @started_at, CURRENT_TIMESTAMP(), @status, @rows,
                                    @to_send, @error)""",
                        **ids,
                        run_id=("STRING", run_id),
                        dag_id=("STRING", dag_id),
                        run_date=("DATE", run_date),
                        period_start=("TIMESTAMP", period_start),
                        period_end=("TIMESTAMP", period_end),
                        started_at=("TIMESTAMP", started),
                        status=("STRING", status),
                        rows=("INT64", rows),
                        to_send=("INT64", to_send),
                        error=("STRING", error),
                    )
                except Exception:
                    # Run déjà en échec : on garde son erreur d'origine. Run réussi : sans trace, la
                    # plateforme ne le verrait pas ; l'échec provoque une nouvelle tentative.
                    if status == "FAILED":
                        log.exception("Trace dans rule_runs impossible")
                    else:
                        raise

        run_rule.expand(rule=get_rules())

    return fraud_rules()


for _frequency, _cron in SCHEDULES.items():
    globals()[f"fraud_rules_{_frequency.lower()}"] = make_dag(_frequency, _cron)
