-- Trace d'exécution d'un DAG (PRD §7.2). Écrite par Airflow.
-- C'est d'ici que la plateforme déduit qu'une version est en production, inactive ou remplacée :
-- l'équipe data n'a aucune action à faire sur la plateforme.
CREATE TABLE IF NOT EXISTS `${PROJECT}.${DATASET}.rule_runs` (
  run_id        STRING    NOT NULL,
  rule_id       STRING    NOT NULL,
  rule_version  INT64     NOT NULL,
  airflow_dag_id STRING   NOT NULL,      -- DAG qui exécute la règle
  run_date      DATE      NOT NULL,
  period_start  TIMESTAMP,             -- période du run, passée à la requête en @period_start / @period_end
  period_end    TIMESTAMP,
  started_at    TIMESTAMP NOT NULL,
  finished_at   TIMESTAMP,
  status        STRING    NOT NULL,      -- SUCCESS | FAILED
  rows_returned INT64,                 -- commandes écrites dans rule_alerts par ce run
  rows_to_send  INT64,                 -- dont marquées à transmettre au prestataire (0 en observation)
  error_message STRING,
  -- Une ligne par TENTATIVE : une tâche qui échoue puis réussit laisse deux lignes de même run_id. Pour
  -- l'état d'un run, prendre la dernière tentative :
  --   QUALIFY ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY started_at DESC) = 1
  -- Clé logique, non appliquée par BigQuery (NOT ENFORCED).
  PRIMARY KEY (run_id, started_at) NOT ENFORCED
)
PARTITION BY run_date;
