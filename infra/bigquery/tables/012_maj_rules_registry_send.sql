-- Ajoute send_to_provider à une table rules_registry créée avant l'étape d'observation
-- (CREATE TABLE IF NOT EXISTS ne modifie pas une table existante). Sans effet si elle existe déjà.
-- Les lignes existantes étaient en production : elles restent envoyées au prestataire.
ALTER TABLE `${PROJECT}.${DATASET}.rules_registry` ADD COLUMN IF NOT EXISTS send_to_provider BOOL;
UPDATE `${PROJECT}.${DATASET}.rules_registry` SET send_to_provider = (status IN ('IN_PRODUCTION', 'INACTIVE'))
WHERE send_to_provider IS NULL;
