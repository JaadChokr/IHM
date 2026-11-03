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

Trois garde-fous (détail dans le README) :
  - **Relance d'un run passé** : la requête est replacée à l'heure du run d'origine. CURRENT_DATE() et
    consorts renvoient la date du run, et les tables sont lues dans leur état d'alors (voyage dans le temps
    de BigQuery, 7 jours au plus, vraies tables seulement). Au-delà, ou pour une vue, la lecture se fait au
    présent et `rule_runs.note` le signale. `rules_registry` est lue elle aussi à cette heure : c'est la
    version qui était en place qui est rejouée.
  - **Âge maximal** : une version ne remonte pas de commande passée plus de `fraud_rules_max_age_days`
    jours (7 par défaut) avant sa mise en route (son premier run). Une requête sans fenêtre de dates ne
    déverse donc pas tout l'historique au premier run, ni au prestataire.
  - **Rattrapage** : les commandes antérieures à la dernière période avant la mise en route (la veille pour
    une règle quotidienne) sont marquées `backfill` : elles restent envoyables, mais la comparaison des
    versions (vue v_rule_performance) les écarte, une version récente n'étant pas créditée du stock d'avant
    sa naissance.
  Âge maximal et rattrapage demandent la date des commandes : ils ne s'appliquent que si la Variable
  `fraud_rules_orders_table` est renseignée.

Variables Airflow :
  fraud_rules_project (obligatoire), fraud_rules_dataset (fraud_rules), fraud_rules_location (europe-west9),
  fraud_rules_orders_table (« dataset.table » ou « projet.dataset.table » ; vide : pas d'âge maximal),
  fraud_rules_orders_id_column (order_id), fraud_rules_orders_date_column (created_at),
  fraud_rules_orders_timezone (Europe/Paris : fuseau d'une colonne DATE ou DATETIME, et des jours),
  fraud_rules_max_age_days (7).

Module associé : fraud_rules_sql.py (réécriture de la requête, testé sans Airflow), à déposer à côté ;
dépendance : sqlglot (pip install sqlglot) dans l'environnement Airflow.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from airflow.decorators import dag, task
from airflow.exceptions import AirflowException
from airflow.models import Variable
from airflow.operators.empty import EmptyOperator
from airflow.operators.python import get_current_context
from google.api_core.exceptions import GoogleAPIError
from google.cloud import bigquery

from fraud_rules_sql import SqlglotError, as_of, referenced_tables

# Fréquence de la règle (colonne `schedule` de rules_registry) → planification du DAG et durée d'une période.
SCHEDULES = {
    "HOURLY": ("5 * * * *", timedelta(hours=1)),  # toutes les heures, à h+5
    "DAILY": ("0 3 * * *", timedelta(days=1)),  # chaque nuit à 3 h (la veille est complète)
    "WEEKLY": ("0 4 * * 1", timedelta(weeks=1)),  # le lundi à 4 h
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


def _replay(client: bigquery.Client, sql: str, at: datetime, late: timedelta) -> tuple[str, str | None]:
    """La requête replacée à `at`, et une note pour rule_runs quand une partie est lue au présent."""
    if late > TIME_TRAVEL_MAX:
        return as_of(sql, at), "Relance au-delà de 7 jours : dates replacées, tables lues au présent."
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


def _orders_filter(client: bigquery.Client) -> tuple[str, str] | None:
    """(jointure, date de commande en TIMESTAMP) sur la table des commandes, ou None si non configurée."""
    table = Variable.get("fraud_rules_orders_table", default_var="").strip().strip("`")
    if not table:
        return None
    id_col = Variable.get("fraud_rules_orders_id_column", default_var="order_id")
    date_col = Variable.get("fraud_rules_orders_date_column", default_var="created_at")
    tz = Variable.get("fraud_rules_orders_timezone", default_var="Europe/Paris")
    table = _full_name(client, table)
    kind = next((f.field_type for f in client.get_table(table).schema if f.name == date_col), None)
    if kind is None:
        raise AirflowException(f"Colonne {date_col} absente de {table} (fraud_rules_orders_date_column).")
    date = f"commande.`{date_col}`" if kind == "TIMESTAMP" else f"TIMESTAMP(commande.`{date_col}`, '{tz}')"
    join = f"LEFT JOIN `{table}` commande ON CAST(commande.`{id_col}` AS STRING) = CAST(t.order_id AS STRING)"
    return join, date


def _backfill_before(started: datetime, period: timedelta) -> datetime:
    """Début de la dernière période avant la mise en route : heure pleine (horaire), jour (sinon)."""
    tz = ZoneInfo(Variable.get("fraud_rules_orders_timezone", default_var="Europe/Paris"))
    t = (started - period).astimezone(tz)
    t = (
        t.replace(minute=0, second=0, microsecond=0)
        if period < timedelta(days=1)
        else t.replace(hour=0, minute=0, second=0, microsecond=0)
    )
    return t.astimezone(UTC)


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


def make_dag(frequency: str, cron: str, period: timedelta):
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
            late = datetime.now(UTC) - at
            when = " FOR SYSTEM_TIME AS OF @at" if REPLAY_AFTER < late < TIME_TRAVEL_MAX else ""
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
            if started - at > REPLAY_AFTER:
                sql, note = _replay(client, sql, at, started - at)
                replayed = at
            status, rows, sent, error = "SUCCESS", None, None, None
            try:
                # Mise en route de la version : son premier run réussi, ou celui-ci.
                first = list(
                    _query(
                        client,
                        f"""SELECT MIN(COALESCE(run_at, started_at)) AS first FROM {ds}.rule_runs
                            WHERE rule_id = @rule_id AND rule_version = @version AND status = 'SUCCESS'""",
                        **ids,
                    ).result()
                )[0]["first"]
                version_start = min(first, at) if first else at
                orders = _orders_filter(client)
                join, age, backfill = "", "", "CAST(NULL AS BOOL)"
                extra: dict[str, tuple[str, object]] = {}
                if orders:
                    join, date = orders
                    max_age = timedelta(days=int(Variable.get("fraud_rules_max_age_days", default_var="7")))
                    # Commande à date inconnue (absente de la table) : gardée, non marquée.
                    age = f"AND ({date} IS NULL OR {date} >= @oldest)"
                    backfill = f"{date} < @backfill_before"
                    extra = {
                        "oldest": ("TIMESTAMP", version_start - max_age),
                        "backfill_before": ("TIMESTAMP", _backfill_before(version_start, period)),
                    }
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
                           backfill, sent_to_provider)
                        SELECT @rule_id, @version, @run_id, @run_date,
                               CAST(t.order_id AS STRING), CURRENT_TIMESTAMP(), TO_JSON(t),
                               {backfill}, FALSE
                        FROM (
                    {sql}
                        ) AS t
                        {join}
                        -- Une commande n'est écrite qu'une fois par version de règle.
                        WHERE NOT EXISTS (
                          SELECT 1 FROM {ds}.rule_alerts a
                          WHERE a.rule_id = @rule_id AND a.rule_version = @version
                            AND a.order_id = CAST(t.order_id AS STRING)
                        ) {age}
                        QUALIFY ROW_NUMBER() OVER (PARTITION BY CAST(t.order_id AS STRING)) = 1""",
                    **ids,
                    run_id=("STRING", run_id),
                    run_date=("DATE", run_date),
                    **extra,
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
                          (run_id, rule_id, rule_version, airflow_dag_id, run_date, run_at, replayed_as_of,
                           started_at, finished_at, status, rows_returned, rows_sent, note, error_message)
                        VALUES (@run_id, @rule_id, @version, @dag_id, @run_date, @run_at, @replayed,
                                @started_at, CURRENT_TIMESTAMP(), @status, @rows, @sent, @note, @error)""",
                    **ids,
                    run_id=("STRING", run_id),
                    dag_id=("STRING", dag_id),
                    run_date=("DATE", run_date),
                    run_at=("TIMESTAMP", at),
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


for _frequency, (_cron, _period) in SCHEDULES.items():
    globals()[f"fraud_rules_{_frequency.lower()}"] = make_dag(_frequency, _cron, _period)
