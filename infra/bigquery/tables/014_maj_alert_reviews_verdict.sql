-- Qualification en trois niveaux : ajoute verdict (FRAUD | RISKY | NOT_FRAUD) à une table alert_reviews créée
-- avec la seule colonne is_fraud, et y reprend les anciennes qualifications (fraude → FRAUD, pas une fraude →
-- NOT_FRAUD). Rejouable : sans effet une fois fait. is_fraud n'est plus écrite.
ALTER TABLE `${PROJECT}.${DATASET}.alert_reviews` ADD COLUMN IF NOT EXISTS verdict STRING;
UPDATE `${PROJECT}.${DATASET}.alert_reviews`
SET verdict = IF(is_fraud, 'FRAUD', 'NOT_FRAUD')
WHERE verdict IS NULL AND is_fraud IS NOT NULL;
