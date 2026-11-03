-- Trace d'exécution d'un DAG (PRD §7.2). Écrite par Airflow.
-- C'est d'ici que la plateforme déduit qu'une version est en production, inactive ou remplacée :
-- l'équipe data n'a aucune action à faire sur la plateforme.
CREATE TABLE IF NOT EXISTS `${PROJECT}.${DATASET}.rule_runs` (
  run_id        STRING    NOT NULL,
  rule_id       STRING    NOT NULL,
  rule_version  INT64     NOT NULL,
  airflow_dag_id STRING   NOT NULL,      -- DAG qui exécute la règle
  run_date      DATE      NOT NULL,
  replayed_as_of TIMESTAMP,            -- relance : heure à laquelle la requête a été replacée ; NULL sinon
  started_at    TIMESTAMP NOT NULL,
  finished_at   TIMESTAMP,
  status        STRING    NOT NULL,      -- SUCCESS | FAILED
  rows_returned INT64,                 -- commandes écrites dans rule_alerts par ce run
  rows_sent     INT64,                 -- dont transmises au prestataire (NULL : version en observation)
  note          STRING,                -- ex. relance dont une partie des tables a été lue au présent
  error_message STRING
)
PARTITION BY run_date;
