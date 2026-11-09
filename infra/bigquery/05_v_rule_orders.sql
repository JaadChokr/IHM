-- Commandes d'une règle, une ligne par commande et par version (rule_alerts), avec le retour du
-- prestataire. Sert aux chiffres d'une règle, calculés par la plateforme selon son état :
--   - règle en production : ses commandes à transmettre (to_send) ;
--   - règle en observation : ses autres commandes.
-- La plateforme compte les commandes distinctes sur la période : une commande remontée par deux versions
-- n'est comptée qu'une fois. Une version précise (une candidate, par exemple) se lit dans le comparatif
-- des versions, v_rule_performance, où chaque version est mesurée en entier.
-- Colonnes de la table de feedback : même hypothèse que v_rule_performance (PRD Q2). has_feedback : la
-- commande figure dans la table de retour du prestataire (traitée) ; sinon elle est en attente de retour.
DROP VIEW IF EXISTS `${PROJECT}.${DATASET}.v_rule_orders_daily`;  -- remplacée par cette vue
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_rule_orders` AS
SELECT
  a.rule_id,
  a.rule_version,
  a.run_date,
  a.order_id,
  IFNULL(a.to_send, FALSE)         AS to_send,
  LOGICAL_OR(f.order_id IS NOT NULL) AS has_feedback,
  LOGICAL_OR(f.is_fraud)           AS is_fraud
FROM `${PROJECT}.${DATASET}.rule_alerts` a
LEFT JOIN `${FEEDBACK_TABLE}` f   -- projet.dataset.table (complété par apply.sh / apply.ps1)
  ON f.order_id = a.order_id
GROUP BY 1, 2, 3, 4, 5;
