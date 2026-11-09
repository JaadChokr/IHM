-- Commandes d'une règle, une ligne par commande et par version (rule_alerts), avec le retour du
-- prestataire. Sert aux chiffres d'une règle toutes versions confondues, calculés par la plateforme :
--   - « Remontées » : commandes distinctes des versions non candidates (la version en production, ou
--     la version en observation quand rien n'est en production) ;
--   - « Envoyées » : commandes distinctes marquées à transmettre (to_send).
-- Compter les commandes distinctes sur la période évite de compter deux fois une commande remontée par
-- deux versions. Le comparatif des versions, lui, lit v_rule_performance (chaque version en entier).
-- Colonnes de la table de feedback : même hypothèse que v_rule_performance (PRD Q2).
DROP VIEW IF EXISTS `${PROJECT}.${DATASET}.v_rule_orders_daily`;  -- remplacée par cette vue
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_rule_orders` AS
SELECT
  a.rule_id,
  a.rule_version,
  a.run_date,
  a.order_id,
  IFNULL(a.candidate, FALSE)       AS candidate,
  IFNULL(a.to_send, FALSE)         AS to_send,
  LOGICAL_OR(f.is_processed)       AS is_processed,
  LOGICAL_OR(f.is_fraud)           AS is_fraud
FROM `${PROJECT}.${DATASET}.rule_alerts` a
LEFT JOIN `${FEEDBACK_TABLE}` f   -- projet.dataset.table (complété par apply.sh / apply.ps1)
  ON f.order_id = a.order_id
GROUP BY 1, 2, 3, 4, 5, 6;
