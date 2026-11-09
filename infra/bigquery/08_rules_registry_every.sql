-- Ajoute schedule_every (pas de la fréquence : toutes les N heures, jours ou semaines) à une table
-- rules_registry créée avant son introduction (CREATE TABLE IF NOT EXISTS ne modifie pas une table
-- existante). Sans effet si elle existe déjà. Les règles existantes gardent un pas de 1.
ALTER TABLE `${PROJECT}.${DATASET}.rules_registry` ADD COLUMN IF NOT EXISTS schedule_every INT64;
UPDATE `${PROJECT}.${DATASET}.rules_registry` SET schedule_every = 1 WHERE schedule_every IS NULL;
