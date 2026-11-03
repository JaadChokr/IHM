"""DAG de référence : un DAG par fréquence de règles (horaire, quotidienne, hebdomadaire).

À adapter par l'équipe data (connexion BigQuery, envoi au prestataire, alertes). Chaque DAG lit
`rules_registry` à chaque exécution et lance une tâche par règle de sa fréquence (mappage dynamique,
Airflow 2.9 ou plus) : une règle publiée est prise en charge dès le run suivant, sans action manuelle,
et une règle qui change de fréquence change simplement de DAG.

Pour chaque règle, la tâche :
  1. exécute `sql_query` et écrit dans `rule_alerts` les commandes que **cette version** n'a encore jamais
     remontées : la requête peut relire les mêmes jours (fenêtre glissante, règle horaire sur la veille)
     sans doublon, et chaque version est mesurée sur tout ce qu'elle remonte, sans être amputée de ce
     qu'une version précédente avait déjà trouvé ;
  2. si `send_to_provider` est vrai, transmet au prestataire celles que **la règle** (toutes versions
     confondues) ne lui a jamais transmises : une nouvelle version ne renvoie pas les commandes de
     l'ancienne ;
  3. trace l'exécution dans `rule_runs` (version exécutée, DAG, statut) : c'est ce que lit la plateforme.

Relance d'un run manqué (détail dans le README) : un run qui démarre plus de 30 minutes après son heure
prévue (Clear d'un run ancien dans Airflow) est replacé à cette heure. CURRENT_DATE() et consorts renvoient
la date du run, et les tables sont lues dans leur état d'alors (voyage dans le temps de BigQuery), comme
`rules_registry` : c'est la version alors en place qui est rejouée. Une vue ou une table externe ne peut
pas remonter le temps : elle est lue au présent et `rule_runs.note` le signale. BigQuery limite le voyage
dans le temps à 7 jours : au-delà, la relance échoue avec un message explicite (on part du principe qu'un
run manqué est relancé dans la semaine).

Variables Airflow :
  fraud_rules_project (obligatoire), fraud_rules_dataset (fraud_rules), fraud_rules_location (europe-west9).

Module associé : fraud_rules_sql.py (réécriture de la requête, testé sans Airflow), à déposer à côté ;
dépendance : sqlglot (pip install sqlglot) dans l'environnement Airflow.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from airflow.decorators import dag, task
from airflow.exceptions import AirflowException
from airflow.models import Variable
from airflow.operators.empty import EmptyOperator
from airflow.operators.python import get_current_context
from google.api_core.exceptions import GoogleAPIError
from google.cloud import bigquery

from fraud_rules_sql import SqlglotError, as_of, referenced_tables

# Fréquence de la règle (colonne `schedule` de rules_registry) → planification du DAG.
SCHEDULES = {
    "HOURLY": "5 * * * *",  # toutes les heures, à h+5
    "DAILY": "0 3 * * *",  # chaque nuit à 3 h (la veille est complète)
    "WEEKLY": "0 4 * * 1",  # le lundi à 4 h
}
# Un run qui démarre plus tard que ça après son heure prévue est une relance : on le replace à son heure.
REPLAY_AFTER = timedelta(minutes=30)
# Voyage dans le temps de BigQuery : 7 jours au plus (marge pour la durée du run).
TIME_TRAVEL_MAX = timedelta(days=7) - timedelta(hours=1)


def _bq() -> tuple[bigquery.Client, str]:
    project = Variable.get("fraud_rules_project")
    dataset = Variable.get("fraud_rules_dataset", default_var="fraud_rules")
    location = Variable.get("fraud_rules_location", default_var="europe-west9")
    return bigquery.Client(project=project, location=location), f"`{project}.{dataset}`"


def _query(client: bigquery.Client, sql: str, **params: tuple[str, object]):
    """Requête paramétrée : chaque paramètre est (type BigQuery, valeur), valeur None comprise ; un
    paramètre de type « ARRAY<STRING> » est un tableau."""
    qp = [
        bigquery.ArrayQueryParameter(k, t[6:-1], v)
        if t.startswith("ARRAY<")
        else bigquery.ScalarQueryParameter(k, t, v)
        for k, (t, v) in params.items()
    ]
    job = client.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=qp))
    job.result()
    return job


def _full_name(client: bigquery.Client, key: str) -> str:
    return key if key.count(".") == 2 else f"{client.project}.{key}"


def _late(at: datetime) -> timedelta | None:
    """Retard du run sur son heure prévue s'il s'agit d'une relance, None sinon. Échoue au-delà de 7 jours."""
    late = datetime.now(UTC) - at
    if late <= REPLAY_AFTER:
        return None
    if late > TIME_TRAVEL_MAX:
        raise AirflowException(
            f"Relance d'un run du {at:%Y-%m-%d %H:%M} UTC : au-delà de 7 jours, BigQuery ne peut plus "
            "lire les tables dans leur état d'alors. Run à traiter à la main (ou à laisser de côté)."
        )
    return late


def _replay(client: bigquery.Client, sql: str, at: datetime) -> tuple[str, str | None]:
    """La requête replacée à `at`, et une note pour rule_runs quand une partie est lue au présent."""
    try:
        keys = referenced_tables(sql)
    except SqlglotError:
        return as_of(sql, at), "Requête non analysable : dates replacées, tables lues au présent."
    frozen, present = set(), []
    for key in keys:
        try:
            # Le voyage dans le temps ne vaut que pour une vraie table (ni vue, ni table externe).
            kind = client.get_table(_full_name(client, key)).table_type
        except GoogleAPIError:
            kind = None
        (frozen.add(key) if kind == "TABLE" else present.append(key))
    note = f"Lues au présent (vue ou table externe) : {', '.join(present)}." if present else None
    return as_of(sql, at, frozen), note


def send_to_provider(rule: dict, orders: list[dict]) -> None:
    """Transmet au prestataire les commandes (order_id, details JSON) : script d'insertion dans sa base
    PostgreSQL, à écrire. L'insertion doit ignorer une commande déjà reçue (ON CONFLICT DO NOTHING) : si la
    tâche tombe entre l'envoi et son marquage, la relance renvoie le même lot.

    Exemple :
        from airflow.providers.postgres.hooks.postgres import PostgresHook
        PostgresHook("prestataire_postgres").insert_rows(
            "alerts", [(rule["rule_id"], o["order_id"], o["details"]) for o in orders],
            target_fields=["rule_id", "order_id", "details"], replace=False)

    Échoue tant que ce n'est pas fait, pour ne jamais laisser croire qu'une règle « en production » envoie
    ses commandes."""
    raise NotImplementedError("Envoi au prestataire à implémenter (voir send_to_provider).")


def make_dag(frequency: str, cron: str):
    @dag(
        dag_id=f"fraud_rules_{frequency.lower()}",
        schedule=cron,
        start_date=datetime(2026, 1, 1),
        catchup=False,
        max_active_runs=1,
        max_active_tasks=8,  # règles exécutées en parallèle
        default_args={"retries": 2, "retry_delay": timedelta(minutes=5)},
        tags=["fraud-rules"],
    )
    def fraud_rules():
        # Bornes du DAG. « end » : none_failed, pour aboutir aussi quand il n'y a aucune règle (tâches
        # sautées) tout en restant en échec si une règle échoue, ce qui met le run en échec dans Airflow.
        start = EmptyOperator(task_id="start")
        end = EmptyOperator(task_id="end", trigger_rule="none_failed")

        @task
        def rules_due() -> list[dict]:
            """Règles de cette fréquence : une ligne par règle, sa dernière version non écartée. Pour une
            relance, le référentiel tel qu'il était à l'heure du run (la version alors en place)."""
            client, ds = _bq()
            at = get_current_context()["data_interval_end"]
            when = " FOR SYSTEM_TIME AS OF @at" if _late(at) else ""
            rows = _query(
                client,
                f"SELECT rule_id, version, name, sql_query, send_to_provider FROM {ds}.rules_registry{when}"
                " WHERE schedule = @schedule",
                schedule=("STRING", frequency),
                **({"at": ("TIMESTAMP", at)} if when else {}),
            ).result()
            return [dict(r.items()) for r in rows]

        @task(map_index_template="{{ rule_name }}")
        def run_rule(rule: dict) -> None:
            context = get_current_context()
            context["rule_name"] = f"{rule['name']} (v{rule['version']})"  # nom affiché dans Airflow
            client, ds = _bq()
            dag_id = context["dag"].dag_id
            # Identifiant stable entre deux tentatives : une relance remplace les commandes du run raté.
            run_id = f"{context['run_id']}__{rule['rule_id']}"
            at = context["data_interval_end"]  # heure que représente ce run
            run_date = at.date()
            started = datetime.now(UTC)
            ids = {"rule_id": ("STRING", rule["rule_id"]), "version": ("INT64", rule["version"])}
            sql = rule["sql_query"].strip().rstrip(";")
            replayed, note = None, None
            status, rows, sent, error = "SUCCESS", None, None, None
            try:
                if _late(at):
                    sql, note = _replay(client, sql, at)
                    replayed = at
                # Relance : on retire ce que la tentative ratée avait écrit, sauf ce qui est déjà parti.
                _query(
                    client,
                    f"""DELETE FROM {ds}.rule_alerts
                        WHERE rule_id = @rule_id AND run_id = @run_id
                          AND NOT IFNULL(sent_to_provider, FALSE)""",
                    rule_id=ids["rule_id"],
                    run_id=("STRING", run_id),
                )
                # Retour à la ligne avant la parenthèse fermante : une requête qui finit par un commentaire
                # « -- … » ne la commente pas.
                job = _query(
                    client,
                    f"""INSERT INTO {ds}.rule_alerts
                          (rule_id, rule_version, run_id, run_date, order_id, detected_at, details,
                           sent_to_provider)
                        SELECT @rule_id, @version, @run_id, @run_date,
                               CAST(t.order_id AS STRING), CURRENT_TIMESTAMP(), TO_JSON(t),
                               FALSE
                        FROM (
                    {sql}
                        ) AS t
                        -- Une commande n'est écrite qu'une fois par version de règle.
                        WHERE NOT EXISTS (
                          SELECT 1 FROM {ds}.rule_alerts a
                          WHERE a.rule_id = @rule_id AND a.rule_version = @version
                            AND a.order_id = CAST(t.order_id AS STRING)
                        )
                        QUALIFY ROW_NUMBER() OVER (PARTITION BY CAST(t.order_id AS STRING)) = 1""",
                    **ids,
                    run_id=("STRING", run_id),
                    run_date=("DATE", run_date),
                )
                rows = job.num_dml_affected_rows
                if rule["send_to_provider"]:
                    sent = _send(client, ds, rule, run_id)
            except Exception as e:  # tracé dans rule_runs, puis relancé pour qu'Airflow le voie
                status, error = "FAILED", str(e)[:2000]
                raise AirflowException(error) from e
            finally:
                _query(
                    client,
                    f"""INSERT INTO {ds}.rule_runs
                          (run_id, rule_id, rule_version, airflow_dag_id, run_date, replayed_as_of,
                           started_at, finished_at, status, rows_returned, rows_sent, note, error_message)
                        VALUES (@run_id, @rule_id, @version, @dag_id, @run_date, @replayed,
                                @started_at, CURRENT_TIMESTAMP(), @status, @rows, @sent, @note, @error)""",
                    **ids,
                    run_id=("STRING", run_id),
                    dag_id=("STRING", dag_id),
                    run_date=("DATE", run_date),
                    replayed=("TIMESTAMP", replayed),
                    started_at=("TIMESTAMP", started),
                    status=("STRING", status),
                    rows=("INT64", rows),
                    sent=("INT64", sent),
                    note=("STRING", note),
                    error=("STRING", error),
                )

        due = rules_due()
        start >> due
        run_rule.expand(rule=due) >> end

    return fraud_rules()


def _send(client: bigquery.Client, ds: str, rule: dict, run_id: str) -> int:
    """Envoie les commandes de ce run que la règle n'a jamais transmises (toutes versions) et les marque."""
    batch = [
        dict(r.items())
        for r in _query(
            client,
            f"""SELECT order_id, TO_JSON_STRING(details) AS details FROM {ds}.rule_alerts n
                WHERE n.rule_id = @rule_id AND n.run_id = @run_id AND NOT n.sent_to_provider
                  AND NOT EXISTS (
                    SELECT 1 FROM {ds}.rule_alerts s
                    WHERE s.rule_id = @rule_id AND s.order_id = n.order_id AND s.sent_to_provider
                  )""",
            rule_id=("STRING", rule["rule_id"]),
            run_id=("STRING", run_id),
        ).result()
    ]
    if batch:
        send_to_provider(rule, batch)
        _query(
            client,
            f"""UPDATE {ds}.rule_alerts SET sent_to_provider = TRUE
                WHERE rule_id = @rule_id AND run_id = @run_id AND order_id IN UNNEST(@ids)""",
            rule_id=("STRING", rule["rule_id"]),
            run_id=("STRING", run_id),
            ids=("ARRAY<STRING>", [o["order_id"] for o in batch]),
        )
    return len(batch)


for _frequency, _cron in SCHEDULES.items():
    globals()[f"fraud_rules_{_frequency.lower()}"] = make_dag(_frequency, _cron)
