-- Table de référence des règles (PRD §7.2) : alimentée par la plateforme, consommée par l'équipe data et
-- Airflow. UNE LIGNE PAR VERSION QU'AIRFLOW EXÉCUTE (clé rule_id, version), mise à jour par la plateforme
-- (MERGE) à chaque publication et décision : au plus deux par règle, la version en production
-- (send_to_provider vrai) et, à côté, une version candidate en observation (send_to_provider faux). Sans
-- version en production, une nouvelle version remplace la précédente. Le DAG de chaque fréquence lit à
-- chaque run
--   SELECT rule_id, version, name, sql_query, send_to_provider, schedule_every FROM rules_registry
--   WHERE schedule = @schedule
-- et recopie send_to_provider (→ rule_alerts.to_send) sur chaque commande, sans l'interpréter. L'historique des versions et les brouillons restent dans la base de la plateforme.
-- Écarts au PRD : owner_matricule au lieu de owner_email (le matricule est la clé d'identité, PRD §5.4) ;
-- pas de colonne parameters : seuls @period_start / @period_end, fournis par Airflow (seuils en dur).
CREATE TABLE IF NOT EXISTS `${PROJECT}.${DATASET}.rules_registry` (
  rule_id          STRING    NOT NULL,   -- UUID, stable entre versions
  version          INT64     NOT NULL,
  name             STRING    NOT NULL,
  description      STRING    NOT NULL,
  fraud_typology   STRING    NOT NULL,
  criticality      STRING    NOT NULL,   -- HIGH | MEDIUM | LOW
  schedule         STRING    NOT NULL,   -- DAILY | HOURLY | WEEKLY
  -- Pas de la fréquence : la règle tourne toutes les `schedule_every` heures, jours ou semaines (heures :
  -- 1, 2, 3, 4, 6, 8 ou 12 ; jours : 1 à 30 ; semaines : 1 à 12). Le DAG de l'unité se déclenche à chaque
  -- unité et n'exécute la règle que lorsqu'elle est due (calage : voir infra/airflow/fraud_rules_dags.py).
  -- NULL (tables antérieures) = 1.
  schedule_every   INT64,
  sql_query        STRING    NOT NULL,
  status           STRING    NOT NULL,   -- SUBMITTED | OBSERVATION | IN_PRODUCTION | INACTIVE
  -- Faux : la règle tourne « en observation », ses commandes sont écrites dans rule_alerts mais PAS
  -- envoyées au prestataire. Vrai : l'analyste a décidé de l'envoyer ; le DAG transmet ses commandes.
  send_to_provider BOOL      NOT NULL,
  owner_matricule  STRING    NOT NULL,
  created_at       TIMESTAMP NOT NULL,   -- création de la règle
  updated_at       TIMESTAMP NOT NULL,   -- dernière publication ou décision
  -- Clé logique : une ligne par version exécutée (MERGE de la plateforme). BigQuery ne l'applique pas
  -- (NOT ENFORCED) : elle documente l'unicité et aide l'optimiseur pour les jointures.
  PRIMARY KEY (rule_id, version) NOT ENFORCED
)
CLUSTER BY rule_id;
