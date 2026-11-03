-- Met à niveau rule_runs et rule_alerts créées avant les relances « dans le passé » et le suivi de l'envoi
-- au prestataire (CREATE TABLE IF NOT EXISTS ne modifie pas une table existante). Sans effet sur des
-- tables déjà à jour.
ALTER TABLE `${PROJECT}.${DATASET}.rule_runs`
  ADD COLUMN IF NOT EXISTS replayed_as_of TIMESTAMP,
  ADD COLUMN IF NOT EXISTS rows_sent INT64,
  ADD COLUMN IF NOT EXISTS note STRING;
ALTER TABLE `${PROJECT}.${DATASET}.rule_alerts`
  ADD COLUMN IF NOT EXISTS sent_to_provider BOOL;
