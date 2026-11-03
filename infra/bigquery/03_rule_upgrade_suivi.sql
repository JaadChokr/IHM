-- Met à niveau rule_runs et rule_alerts créées avant les relances « dans le passé », le dédoublonnage par
-- version et l'âge maximal (CREATE TABLE IF NOT EXISTS ne modifie pas une table existante). Sans effet sur
-- des tables déjà à jour. Passe avant 04 : la vue v_rule_performance lit rule_alerts.backfill.
ALTER TABLE `${PROJECT}.${DATASET}.rule_runs`
  ADD COLUMN IF NOT EXISTS run_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS replayed_as_of TIMESTAMP,
  ADD COLUMN IF NOT EXISTS rows_sent INT64,
  ADD COLUMN IF NOT EXISTS note STRING;
ALTER TABLE `${PROJECT}.${DATASET}.rule_alerts`
  ADD COLUMN IF NOT EXISTS backfill BOOL,
  ADD COLUMN IF NOT EXISTS sent_to_provider BOOL;
