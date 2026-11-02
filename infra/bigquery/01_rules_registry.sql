-- Table de référence des règles (PRD §7.2) : alimentée par la plateforme,
-- consommée par l'équipe data et Airflow. UNE LIGNE PAR RÈGLE, mise à jour (MERGE sur rule_id) à chaque
-- soumission : elle porte la dernière version soumise, celle qu'Airflow exécute. Le DAG lit à chaque run
--   SELECT sql_query, version, send_to_provider FROM rules_registry WHERE rule_id = @rule_id
-- écrit `version` dans rule_runs, les commandes dans rule_alerts, et ne les transmet au prestataire que si
-- send_to_provider est vrai. Une nouvelle version remplace la précédente EN OBSERVATION (envoi suspendu
-- jusqu'à la décision de l'analyste). L'historique des versions et les brouillons restent dans la base de
-- la plateforme ; une version reprise en brouillon avant tout run, ou écartée, ramène la ligne à la
-- version précédente.
-- Écarts au PRD : owner_matricule au lieu de owner_email (le matricule est la clé d'identité, PRD §5.4) ;
-- pas de colonne parameters : la requête s'exécute telle quelle (seuils en dur, dates via CURRENT_DATE()).
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
  updated_at       TIMESTAMP NOT NULL    -- dernière soumission
)
CLUSTER BY rule_id;
