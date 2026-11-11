-- Commandes d'une règle, une ligne par commande et par version (rule_alerts), avec le retour du
-- prestataire et la qualification des analystes. Sert aux chiffres d'une règle, calculés par la plateforme
-- selon son état :
--   - règle en production : ses commandes à transmettre (to_send) ;
--   - règle en test : ses autres commandes.
-- La plateforme compte les commandes distinctes sur la période : une commande remontée par deux versions
-- n'est comptée qu'une fois. Une version précise (une candidate, par exemple) se lit dans le comparatif
-- des versions, v_rule_performance, où chaque version est mesurée en entier.
--   - has_feedback / is_fraud : la commande figure dans la table de retour du prestataire, et son verdict
--     (colonnes de la table de feedback : même hypothèse que v_rule_performance, PRD Q2) ;
--   - review_is_fraud : dernière qualification d'un analyste (alert_reviews), NULL si non qualifiée ;
--   - is_verified / is_confirmed : ce qui compte dans les chiffres. Commande transmise (to_send) : le
--     prestataire seul. Commande en test : le prestataire s'il l'a vérifiée (transmise par une autre règle),
--     sinon la qualification de l'analyste.
DROP VIEW IF EXISTS `${PROJECT}.${DATASET}.v_rule_orders_daily`;  -- remplacée par cette vue
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_rule_orders` AS
WITH reviews AS (
  SELECT order_id, is_fraud
  FROM `${PROJECT}.${DATASET}.alert_reviews`
  QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY reviewed_at DESC) = 1
),
orders AS (
  SELECT
    a.rule_id,
    a.rule_version,
    a.run_date,
    a.order_id,
    IFNULL(a.to_send, FALSE)           AS to_send,
    LOGICAL_OR(f.order_id IS NOT NULL) AS has_feedback,
    LOGICAL_OR(f.is_fraud)             AS is_fraud
  FROM `${PROJECT}.${DATASET}.rule_alerts` a
  LEFT JOIN `${FEEDBACK_TABLE}` f   -- projet.dataset.table (complété par apply.sh / apply.ps1)
    ON f.order_id = a.order_id
  GROUP BY 1, 2, 3, 4, 5
)
SELECT
  o.*,
  r.is_fraud AS review_is_fraud,
  IF(o.to_send, o.has_feedback, o.has_feedback OR r.is_fraud IS NOT NULL)            AS is_verified,
  IFNULL(IF(o.to_send OR o.has_feedback, o.is_fraud, r.is_fraud), FALSE)             AS is_confirmed
FROM orders o
LEFT JOIN reviews r USING (order_id);
