-- Ajoute la colonne `details` à une table rule_alerts créée avant son introduction
-- (CREATE TABLE IF NOT EXISTS ne modifie pas une table existante). Sans effet si elle existe déjà :
-- apply.sh peut être rejoué.
ALTER TABLE `${PROJECT}.${DATASET}.rule_alerts` ADD COLUMN IF NOT EXISTS details JSON;
