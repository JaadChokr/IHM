-- Commandes remontées par une règle (PRD §7.2). Écrite par Airflow. LE CONTRAT.
-- Une ligne par commande et par version de règle (une commande n'est écrite qu'une fois par version).
CREATE TABLE IF NOT EXISTS `${PROJECT}.${DATASET}.rule_alerts` (
  rule_id      STRING    NOT NULL,
  rule_version INT64     NOT NULL,
  run_id       STRING    NOT NULL,
  run_date     DATE      NOT NULL,
  order_id     STRING    NOT NULL,
  detected_at  TIMESTAMP NOT NULL,
  -- Autres colonnes renvoyées par la règle pour cette commande (montant, BIN…), écrites telles
  -- quelles par Airflow. Chaque règle a ses propres colonnes : un JSON garde le schéma commun.
  -- Facultatif : un DAG qui ne la remplit pas reste conforme. Les indicateurs n'en dépendent pas.
  details      JSON,
  -- À transmettre au prestataire, décision figée au moment du run par le DAG : vrai si la règle était en
  -- production (rules_registry.send_to_provider) et ne l'avait jamais marquée, toutes versions confondues.
  to_send      BOOL,
  -- Recopié de rules_registry : commande remontée par une version candidate (en parallèle de la version
  -- en production). Exclue des chiffres de la règle, comptée dans le comparatif des versions.
  candidate    BOOL,
  -- Date de transmission, renseignée par le script d'envoi ; vide tant que la commande n'est pas partie.
  -- Le script lit les lignes « to_send AND sent_at IS NULL » et dédoublonne par commande, toutes règles
  -- confondues.
  sent_at      TIMESTAMP,
  -- Clé logique : une ligne par commande et par version de règle, garantie par le dédoublonnage du DAG.
  -- BigQuery ne l'applique pas (NOT ENFORCED).
  PRIMARY KEY (rule_id, rule_version, order_id) NOT ENFORCED
)
PARTITION BY run_date
CLUSTER BY rule_id, order_id;  -- rule_id en tête : presque toutes les lectures filtrent sur la règle
