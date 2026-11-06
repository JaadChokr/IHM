-- Met à niveau rule_runs et rule_alerts créées avant la période du run (@period_start / @period_end)
-- et le suivi de l'envoi au prestataire (CREATE TABLE IF NOT EXISTS ne modifie pas une table
-- existante). Sans effet sur des tables déjà à jour.
ALTER TABLE `${PROJECT}.${DATASET}.rule_runs`
  ADD COLUMN IF NOT EXISTS period_start TIMESTAMP,
  ADD COLUMN IF NOT EXISTS period_end TIMESTAMP,
  ADD COLUMN IF NOT EXISTS rows_to_send INT64;
ALTER TABLE `${PROJECT}.${DATASET}.rule_alerts`
  ADD COLUMN IF NOT EXISTS to_send BOOL,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP;
-- Les colonnes sent_to_provider (rule_alerts) et rows_sent (rule_runs) des versions précédentes ne sont
-- plus écrites. Elles ne sont pas supprimées ici, pour ne pas casser un script qui les lirait encore ;
-- une fois le script d'envoi passé à to_send / sent_at :
--   ALTER TABLE `${PROJECT}.${DATASET}.rule_alerts` DROP COLUMN IF EXISTS sent_to_provider;
--   ALTER TABLE `${PROJECT}.${DATASET}.rule_runs` DROP COLUMN IF EXISTS rows_sent;

-- Clés logiques (PRIMARY KEY NOT ENFORCED) des tables créées avant leur déclaration. BigQuery refuse d'en
-- ajouter une seconde : chaque ajout n'a lieu que si la table n'en a pas encore.
IF NOT EXISTS (SELECT 1 FROM `${PROJECT}.${DATASET}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS`
               WHERE table_name = 'rules_registry' AND constraint_type = 'PRIMARY KEY') THEN
  ALTER TABLE `${PROJECT}.${DATASET}.rules_registry` ADD PRIMARY KEY (rule_id) NOT ENFORCED;
END IF;
IF NOT EXISTS (SELECT 1 FROM `${PROJECT}.${DATASET}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS`
               WHERE table_name = 'rule_runs' AND constraint_type = 'PRIMARY KEY') THEN
  ALTER TABLE `${PROJECT}.${DATASET}.rule_runs` ADD PRIMARY KEY (run_id, started_at) NOT ENFORCED;
END IF;
IF NOT EXISTS (SELECT 1 FROM `${PROJECT}.${DATASET}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS`
               WHERE table_name = 'rule_alerts' AND constraint_type = 'PRIMARY KEY') THEN
  ALTER TABLE `${PROJECT}.${DATASET}.rule_alerts` ADD PRIMARY KEY (rule_id, rule_version, order_id) NOT ENFORCED;
END IF;
