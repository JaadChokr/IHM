"""DAG de référence : un DAG par fréquence de règles (horaire, quotidienne, hebdomadaire).

À adapter par l'équipe data (connexion BigQuery, envoi au prestataire, alertes). Chaque DAG lit
`rules_registry` à chaque exécution et lance une tâche par règle de sa fréquence (mappage dynamique,
Airflow 2.9 ou plus) : une règle soumise est prise en charge dès le run suivant, sans action manuelle,
et une règle qui change de fréquence change simplement de DAG.

Pour chaque règle, la tâche :
  1. exécute `sql_query` telle quelle et écrit dans `rule_alerts` (order_id + details) les commandes que
     cette règle n'a encore jamais remontées : la requête peut relire les mêmes jours (fenêtre glissante,
     règle horaire sur la veille) sans créer de doublon, et une fenêtre un peu plus large que la
     fréquence rattrape d'elle-même un run manqué ;
  2. si `send_to_provider` est vrai, transmet ces commandes au prestataire (sinon : observation) ;
  3. trace l'exécution dans `rule_runs` (version exécutée, DAG, statut) : c'est ce que lit la plateforme.

Variables Airflow : fraud_rules_project (obligatoire), fraud_rules_dataset (fraud_rules par défaut),
fraud_rules_location (europe-west9 par défaut).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from airflow.decorators import dag, task
from airflow.exceptions import AirflowException
from airflow.models import Variable
from airflow.operators.empty import EmptyOperator
from airflow.operators.python import get_current_context
from google.cloud import bigquery

# Fréquence de la règle (colonne `schedule` de rules_registry) → planification du DAG.
SCHEDULES = {
    "HOURLY": "5 * * * *",  # toutes les heures, à h+5
    "DAILY": "0 3 * * *",  # chaque nuit à 3 h (la veille est complète)
    "WEEKLY": "0 4 * * 1",  # le lundi à 4 h
}


def _bq() -> tuple[bigquery.Client, str]:
    project = Variable.get("fraud_rules_project")
    dataset = Variable.get("fraud_rules_dataset", default_var="fraud_rules")
    location = Variable.get("fraud_rules_location", default_var="europe-west9")
    return bigquery.Client(project=project, location=location), f"`{project}.{dataset}`"


def _query(client: bigquery.Client, sql: str, **params: tuple[str, object]):
    """Requête paramétrée : chaque paramètre est (type BigQuery, valeur), valeur None comprise."""
    qp = [bigquery.ScalarQueryParameter(k, t, v) for k, (t, v) in params.items()]
    job = client.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=qp))
    job.result()
    return job


def send_to_provider(client: bigquery.Client, ds: str, rule: dict, run_id: str) -> None:
    """Transmet au prestataire les commandes de ce run (rule_alerts, run_id) : à implémenter selon le
    canal convenu avec lui (table partagée, fichier, API). Échoue tant que ce n'est pas fait, pour ne
    jamais laisser croire qu'une règle « en production » envoie ses commandes."""
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
            """Règles de cette fréquence : une ligne par règle, sa dernière version non écartée."""
            client, ds = _bq()
            rows = client.query(
                f"SELECT rule_id, version, name, sql_query, send_to_provider FROM {ds}.rules_registry"
                " WHERE schedule = @schedule",
                job_config=bigquery.QueryJobConfig(
                    query_parameters=[bigquery.ScalarQueryParameter("schedule", "STRING", frequency)]
                ),
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
            run_date = context["data_interval_end"].date()
            started = datetime.now(UTC)
            # La requête est exécutée telle quelle ; retour à la ligne avant la parenthèse fermante pour
            # ne pas la commenter si la requête finit par un commentaire « -- … ».
            sql = rule["sql_query"].strip().rstrip(";")
            status, rows, error = "SUCCESS", None, None
            try:
                _query(
                    client,
                    f"DELETE FROM {ds}.rule_alerts WHERE rule_id = @rule_id AND run_id = @run_id",
                    rule_id=("STRING", rule["rule_id"]),
                    run_id=("STRING", run_id),
                )
                job = _query(
                    client,
                    f"""INSERT INTO {ds}.rule_alerts
                          (rule_id, rule_version, run_id, run_date, order_id, detected_at, details)
                        SELECT @rule_id, @version, @run_id, @run_date,
                               CAST(t.order_id AS STRING), CURRENT_TIMESTAMP(), TO_JSON(t)
                        FROM (
                    {sql}
                        ) AS t
                        -- Une commande n'est remontée qu'une fois par règle (toutes versions confondues) :
                        -- fenêtres glissantes, règles horaires sur la veille et rattrapages ne créent pas
                        -- de doublon, ni dans rule_alerts ni chez le prestataire.
                        WHERE NOT EXISTS (
                          SELECT 1 FROM {ds}.rule_alerts a
                          WHERE a.rule_id = @rule_id AND a.order_id = CAST(t.order_id AS STRING)
                        )
                        QUALIFY ROW_NUMBER() OVER (PARTITION BY CAST(t.order_id AS STRING)) = 1""",
                    rule_id=("STRING", rule["rule_id"]),
                    version=("INT64", rule["version"]),
                    run_id=("STRING", run_id),
                    run_date=("DATE", run_date),
                )
                rows = job.num_dml_affected_rows
                if rule["send_to_provider"]:
                    send_to_provider(client, ds, rule, run_id)
            except Exception as e:  # tracé dans rule_runs, puis relancé pour qu'Airflow le voie
                status, error = "FAILED", str(e)[:2000]
                raise AirflowException(error) from e
            finally:
                _query(
                    client,
                    f"""INSERT INTO {ds}.rule_runs
                          (run_id, rule_id, rule_version, airflow_dag_id, run_date, started_at, finished_at,
                           status, rows_returned, error_message)
                        VALUES (@run_id, @rule_id, @version, @dag_id, @run_date, @started_at,
                                CURRENT_TIMESTAMP(), @status, @rows, @error)""",
                    run_id=("STRING", run_id),
                    rule_id=("STRING", rule["rule_id"]),
                    version=("INT64", rule["version"]),
                    dag_id=("STRING", dag_id),
                    run_date=("DATE", run_date),
                    started_at=("TIMESTAMP", started),
                    status=("STRING", status),
                    rows=("INT64", rows),
                    error=("STRING", error),
                )

        due = rules_due()
        start >> due
        run_rule.expand(rule=due) >> end

    return fraud_rules()


for _frequency, _cron in SCHEDULES.items():
    globals()[f"fraud_rules_{_frequency.lower()}"] = make_dag(_frequency, _cron)
