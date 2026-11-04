-- Met à niveau rule_runs et rule_alerts créées avant la période du run (@period_start / @period_end)
-- et le suivi de l'envoi au prestataire (CREATE TABLE IF NOT EXISTS ne modifie pas une table
-- existante). Sans effet sur des tables déjà à jour.
ALTER TABLE `${PROJECT}.${DATASET}.rule_runs`
  ADD COLUMN IF NOT EXISTS period_start TIMESTAMP,
  ADD COLUMN IF NOT EXISTS period_end TIMESTAMP,
  ADD COLUMN IF NOT EXISTS rows_sent INT64;
ALTER TABLE `${PROJECT}.${DATASET}.rule_alerts`
  ADD COLUMN IF NOT EXISTS sent_to_provider BOOL;
