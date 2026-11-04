-- Indicateurs d'une règle toutes versions confondues (PRD §7.4) : une ligne par règle et par jour.
-- rule_alerts garde une ligne par commande et par version (chaque version est mesurée en entier, voir
-- v_rule_performance). Ici, chaque commande n'est comptée qu'une fois par règle, au jour où la règle l'a
-- remontée pour la première fois, quelle que soit la version : une commande remontée par la v1 puis
-- relue par la v2 (fenêtre glissante) n'est pas comptée deux fois dans les totaux de la règle.
-- Colonnes de la table de feedback : même hypothèse que v_rule_performance (PRD Q2).
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_rule_orders_daily` AS
WITH first_flag AS (
  SELECT
    rule_id,
    order_id,
    ARRAY_AGG(STRUCT(run_date, rule_version) ORDER BY run_date, rule_version LIMIT 1)[OFFSET(0)] AS first_hit
  FROM `${PROJECT}.${DATASET}.rule_alerts`
  GROUP BY rule_id, order_id
)
SELECT
  ff.rule_id,
  ff.first_hit.run_date                                 AS run_date,
  MAX(ff.first_hit.rule_version)                        AS rule_version,  -- version qui tournait ce jour-là
  COUNT(DISTINCT ff.order_id)                           AS orders_flagged,
  COUNT(DISTINCT IF(f.is_processed, ff.order_id, NULL)) AS orders_processed,
  COUNT(DISTINCT IF(f.is_fraud,     ff.order_id, NULL)) AS orders_confirmed_fraud
FROM first_flag ff
LEFT JOIN `${FEEDBACK_TABLE}` f   -- projet.dataset.table (complété par apply.sh / apply.ps1)
  ON f.order_id = ff.order_id
GROUP BY ff.rule_id, ff.first_hit.run_date;
