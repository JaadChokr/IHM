"""DAG de référence : un DAG par fréquence de règles (horaire, quotidienne, hebdomadaire).

À adapter par l'équipe data : GCP_CONN_ID, RULES_DS et ALERT_EMAILS ci-dessous. Chaque DAG lit
`rules_registry` à chaque exécution et lance une tâche par version à exécuter (mappage dynamique, Airflow 2.9
ou plus) : une règle publiée est prise en charge dès le run suivant, sans action manuelle.

Fréquence d'une règle : une unité (colonne `schedule` : le DAG qui l'exécute) et un pas
(`schedule_every`) : « toutes les 2 heures », « tous les 3 jours ». Le DAG se déclenche à chaque unité
(SCHEDULES, heure de Paris) et n'exécute une règle que lorsqu'elle est due (_due), avec un calage fixe :
  - heures : comptées depuis minuit (pas diviseur de 24) : toutes les 2 h = 0 h 05, 2 h 05, 4 h 05… ;
  - jours et semaines : comptés depuis ANCHOR (le lundi 5 janvier 2026).

Période du run : la requête de la règle reçoit `@period_start` / `@period_end` (TIMESTAMP), bornes
[début, fin[ : du déclenchement dû précédent à celui-ci (pas de 1 : 1 h en horaire, de 3 h à 3 h en
quotidien, du lundi 4 h au lundi 4 h en hebdomadaire). Un rattrapage (catchup) ou une relance d'un run
passé repasse donc les bornes de la période d'origine, sans réécrire la requête. L'IHM teste la requête
avec la dernière période complète du même calendrier (backend/app/query/periods.py : garder SCHEDULES, ANCHOR,
_due et _period_start alignés).

rules_registry a une ligne par version à exécuter (au plus deux par règle : la version en production et
une candidate). Le DAG lance une tâche par ligne, sans logique propre aux versions. Pour chaque version :
  1. exécute `sql_query` et écrit dans `rule_alerts` les commandes que **cette version** n'a encore jamais
     remontées (une seule fois chacune) ;
  2. recopie sur chaque commande `send_to_provider` de rules_registry dans `to_send` (version en
     production à ce run : à transmettre) ; la décision est figée au moment du run ;
  3. trace l'exécution dans `rule_runs` (version, période, statut, volumes) : c'est ce que lit la plateforme.

Envoi au prestataire : le DAG n'envoie rien. Un script externe lit dans `rule_alerts` les commandes `to_send`
absentes de son journal `rule_sends`, les transmet (dédoublonnées par commande, toutes règles confondues) et
les inscrit au journal (infra/prestataire/requetes_envoi.sql). Le script ne modifie jamais `rule_alerts` et le
DAG n'écrit jamais dans `rule_sends` : pas de conflit d'écriture entre eux. Une nouvelle tentative du DAG
n'efface pas les commandes déjà transmises, et une commande réécrite ne repart pas.

Relance et rattrapage : la requête est exécutée telle quelle, tables lues au présent, avec les versions
actuelles de rules_registry. Avec une plage @period_start / @period_end, elle porte sur la période
d'origine. Sans plage, rien n'est perdu ni doublé (dédoublonnage par règle et par version), mais les
commandes passées depuis sont rattachées au run rejoué.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from functools import partial
from zoneinfo import ZoneInfo

import pendulum
from airflow.decorators import dag, task
from airflow.exceptions import AirflowException
from airflow.operators.python import get_current_context
from airflow.providers.google.cloud.hooks.bigquery import BigQueryHook
from airflow.utils.email import send_email
from google.cloud import bigquery

# --- À adapter ---------------------------------------------------------------------------------------
GCP_CONN_ID = "google_cloud_default"  # connexion Airflow vers BigQuery
RULES_DS = "mon-projet.fraud_rules"  # projet.dataset des tables de la plateforme
ALERT_EMAILS: list[str] = []  # destinataires des e-mails d'échec et de succès
# -----------------------------------------------------------------------------------------------------

TZ = "Europe/Paris"

default_args = {
    "owner": "fraud-rules",
    # Deux DELETE simultanés sur rule_alerts peuvent échouer (mise à jour concurrente) : une nouvelle
    # tentative suffit, et l'identifiant de run stable la rend sans effet de bord.
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
    "email": ALERT_EMAILS,
    "email_on_failure": bool(ALERT_EMAILS),
    "email_on_retry": False,
}


def send_success_email(context, to: list[str]) -> None:
    """E-mail de fin de run réussi (on_success_callback du DAG)."""
    if not to:
        return
    run = context["dag_run"]
    send_email(
        to=to,
        subject=f"[Airflow] {run.dag_id} : run réussi",
        html_content=f"Run {run.run_id} terminé avec succès "
        f"(période du {context['data_interval_start']} au {context['data_interval_end']}).",
    )


SCHEDULES = {
    "HOURLY": "5 * * * *",  # toutes les heures, à h+5
    "DAILY": "0 3 * * *",  # chaque nuit à 3 h (la veille est complète)
    "WEEKLY": "0 4 * * 1",  # le lundi à 4 h
}
ANCHOR = date(2026, 1, 5)  # un lundi : origine du calage des jours et des semaines
UNIT = {"HOURLY": timedelta(hours=1), "DAILY": timedelta(days=1), "WEEKLY": timedelta(weeks=1)}
PARIS = ZoneInfo(TZ)


def _due(frequency: str, every: int, tick: datetime) -> bool:
    """La règle (toutes les `every` unités) tourne-t-elle à ce déclenchement du DAG ?"""
    local = tick.astimezone(PARIS)
    if frequency == "HOURLY":
        return local.hour % every == 0
    days = (local.date() - ANCHOR).days
    return (days // 7 if frequency == "WEEKLY" else days) % every == 0


def _prev_tick(frequency: str, tick: datetime) -> datetime:
    """Déclenchement précédent du DAG : une heure réelle avant, ou la même heure de Paris la veille / la
    semaine d'avant (changements d'heure compris)."""
    if frequency == "HOURLY":
        return tick.astimezone(timezone.utc) - UNIT[frequency]
    wall = tick.astimezone(PARIS).replace(tzinfo=None) - UNIT[frequency]
    return wall.replace(tzinfo=PARIS).astimezone(timezone.utc)


def _period_start(frequency: str, every: int, end: datetime) -> datetime:
    """Début de la période d'un run : le déclenchement dû précédent (ni trou ni chevauchement)."""
    t = _prev_tick(frequency, end)
    while not _due(frequency, every, t):
        t = _prev_tick(frequency, t)
    return t


# Garde-fou : le SQL des règles est saisi dans l'IHM, pas relu ici.
MAX_BYTES_BILLED = 200 * 1024**3  # 200 Gio par règle


def _bq():
    """Client BigQuery issu de la connexion Airflow + dataset des règles.

    Instancié à l'exécution de la tâche (jamais au parse du DAG) pour ne pas
    ouvrir une connexion GCP à chaque scan du scheduler.
    """
    hook = BigQueryHook(gcp_conn_id=GCP_CONN_ID, use_legacy_sql=False)
    return hook.get_client(), RULES_DS


def _query(client, sql, **params):
    """client.query() avec paramètres nommés : _query(c, sql, rule_id=("STRING", x)).

    Attend la fin du job avant de rendre la main : sans ça le job suivant
    démarrerait avant que celui-ci ait écrit, et num_dml_affected_rows serait None.
    """
    job = client.query(
        sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter(name, type_, value) for name, (type_, value) in params.items()
            ],
            maximum_bytes_billed=MAX_BYTES_BILLED,
        ),
    )
    job.result()
    return job


def make_dag(frequency: str, cron: str):
    @dag(
        dag_id=f"FRAUD_RULES_{frequency.upper()}",
        schedule=cron,
        start_date=pendulum.datetime(2026, 11, 1, tz=TZ),
        catchup=True,
        # Un run à la fois : deux runs simultanés d'une même règle (rattrapage) passeraient tous deux
        # le dédoublonnage avant que l'autre ait écrit. Les règles d'un même run restent en parallèle.
        max_active_runs=1,
        max_active_tasks=8,
        default_args=default_args,
        tags=["fraud-rules"],
        on_success_callback=partial(send_success_email, to=default_args["email"]),
    )
    def fraud_rules():
        @task
        def get_rules() -> list[dict]:
            """Versions dues à ce déclenchement : une ligne par version (celle en production et, le cas
            échéant, une candidate en observation), dont le pas tombe sur ce déclenchement."""
            client, ds = _bq()
            tick = get_current_context()["data_interval_end"]
            rows = _query(
                client,
                "SELECT rule_id, version, name, sql_query, send_to_provider,"
                f" IFNULL(schedule_every, 1) AS schedule_every FROM `{ds}.rules_registry`"
                " WHERE schedule = @schedule",
                schedule=("STRING", frequency),
            ).result()
            return [dict(r.items()) for r in rows if _due(frequency, r["schedule_every"], tick)]

        @task(map_index_template="{{ rule_name }}")
        def run_rule(rule: dict) -> None:
            context = get_current_context()
            context["rule_name"] = f"{rule['name']} (v{rule['version']})"  # nom affiché dans Airflow
            client, ds = _bq()
            dag_id = context["dag"].dag_id
            # Identifiant stable entre deux tentatives : une relance remplace les commandes du run raté.
            # La version y figure : une règle peut tourner en deux versions dans le même run
            # (production et candidate).
            run_id = f"{context['run_id']}__{rule['rule_id']}__v{rule['version']}"
            # Fenêtre d'analyse du run : du déclenchement dû précédent de la règle à celui-ci.
            period_end = context["data_interval_end"]
            period_start = _period_start(frequency, rule["schedule_every"], period_end)
            run_date = period_end.in_timezone(TZ).date()
            started = datetime.now(timezone.utc)
            sql = rule["sql_query"].strip().rstrip(";")
            # Décision d'envoi de la version, figée sur chaque commande au moment du run.
            send = bool(rule["send_to_provider"])
            status, rows, to_send, error = "SUCCESS", None, None, None

            try:
                _query(
                    client,
                    f"""DELETE FROM `{ds}.rule_alerts` a
                        WHERE rule_id = @rule_id AND run_id = @run_id
                          -- Déjà transmises au prestataire (journal du script d'envoi) : on les garde.
                          AND NOT EXISTS (SELECT 1 FROM `{ds}.rule_sends` s WHERE s.order_id = a.order_id)""",
                    rule_id=("STRING", rule["rule_id"]),
                    run_id=("STRING", run_id),
                )
                job = _query(
                    client,
                    f"""INSERT INTO `{ds}.rule_alerts`
                          (rule_id, rule_version, run_id, run_date, order_id, detected_at, details, to_send)
                        SELECT @rule_id, @version, @run_id, @run_date,
                               CAST(t.order_id AS STRING), CURRENT_TIMESTAMP(), TO_JSON(t),
                               -- Recopié de rules_registry.send_to_provider : version en production
                               -- (à transmettre) ou en observation.
                               @send
                        FROM (
                    {sql}
                        ) AS t
                        WHERE t.order_id IS NOT NULL
                          -- Dédoublonnage historique : une commande n'est alertée qu'une seule fois
                          -- pour une même règle et une même version.
                          AND NOT EXISTS (
                              SELECT 1
                              FROM `{ds}.rule_alerts` a
                              WHERE a.rule_id = @rule_id
                                AND a.rule_version = @version
                                AND a.order_id = CAST(t.order_id AS STRING)
                          )
                        -- Dédoublonnage intra-requête : au cas où le SQL de la règle renvoie
                        -- plusieurs lignes avec le même order_id dans ce même run.
                        QUALIFY ROW_NUMBER() OVER (PARTITION BY CAST(t.order_id AS STRING)) = 1""",
                    rule_id=("STRING", rule["rule_id"]),
                    version=("INT64", rule["version"]),
                    run_id=("STRING", run_id),
                    run_date=("DATE", run_date),
                    send=("BOOL", send),
                    period_start=("TIMESTAMP", period_start),
                    period_end=("TIMESTAMP", period_end),
                )
                rows = job.num_dml_affected_rows
                # Toutes les commandes du run portent la même décision d'envoi.
                to_send = rows if send else 0
            except Exception as e:
                status, error = "FAILED", str(e)[:2000]
                raise AirflowException(error) from e
            finally:
                try:
                    _query(
                        client,
                        f"""INSERT INTO `{ds}.rule_runs`
                              (run_id, rule_id, rule_version, airflow_dag_id, run_date, period_start,
                               period_end, started_at, finished_at, status, rows_returned, rows_to_send,
                               error_message)
                            VALUES (@run_id, @rule_id, @version, @dag_id, @run_date, @period_start,
                                    @period_end, @started_at, CURRENT_TIMESTAMP(), @status, @rows,
                                    @to_send, @error)""",
                        run_id=("STRING", run_id),
                        rule_id=("STRING", rule["rule_id"]),
                        version=("INT64", rule["version"]),
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
                except Exception as trace_error:
                    print(f"Trace dans rule_runs impossible : {trace_error}")
                    # Si le run était un succès, l'absence de trace d'audit est anormale :
                    # on lève l'exception pour qu'Airflow retente la tâche.
                    # Si le run était déjà FAILED, on ne lève rien pour ne pas masquer l'erreur SQL d'origine.
                    if status == "SUCCESS":
                        raise AirflowException(
                            f"Échec de l'enregistrement dans rule_runs : {trace_error}"
                        ) from trace_error

        run_rule.expand(rule=get_rules())

    return fraud_rules()


for _frequency, _cron in SCHEDULES.items():
    globals()[f"FRAUD_RULES_{_frequency.upper()}"] = make_dag(_frequency, _cron)
