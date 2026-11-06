-- Table de référence des règles (PRD §7.2) : alimentée par la plateforme,
-- consommée par l'équipe data et Airflow. UNE LIGNE PAR RÈGLE, mise à jour (MERGE sur rule_id) à chaque
-- publication : elle porte la dernière version publiée, celle qu'Airflow exécute. Le DAG de chaque
-- fréquence lit à chaque run
--   SELECT rule_id, version, name, sql_query, send_to_provider FROM rules_registry WHERE schedule = @schedule
-- écrit `version` dans rule_runs, les commandes dans rule_alerts, et ne les marque à transmettre au
-- prestataire (rule_alerts.to_send) que si send_to_provider est vrai. Une nouvelle version remplace la précédente EN OBSERVATION (envoi suspendu
-- jusqu'à la décision de l'analyste). L'historique des versions et les brouillons restent dans la base de
-- la plateforme ; une version reprise en brouillon avant tout run, ou écartée, ramène la ligne à la
-- version précédente.
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
  sql_query        STRING    NOT NULL,
  status           STRING    NOT NULL,   -- SUBMITTED | OBSERVATION | IN_PRODUCTION | INACTIVE
  -- Faux : la règle tourne « en observation », ses commandes sont écrites dans rule_alerts mais PAS
  -- envoyées au prestataire. Vrai : l'analyste a décidé de l'envoyer ; le DAG transmet ses commandes.
  send_to_provider BOOL      NOT NULL,
  owner_matricule  STRING    NOT NULL,
  created_at       TIMESTAMP NOT NULL,   -- création de la règle
  updated_at       TIMESTAMP NOT NULL,   -- dernière publication ou décision
  -- Clé logique : une ligne par règle (MERGE de la plateforme). BigQuery ne l'applique pas (NOT ENFORCED) :
  -- elle documente l'unicité et aide l'optimiseur pour les jointures.
  PRIMARY KEY (rule_id) NOT ENFORCED
)
CLUSTER BY rule_id;
