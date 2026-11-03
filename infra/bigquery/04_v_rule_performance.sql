-- Indicateurs F6 (PRD §7.4). Colonnes de la table de feedback À CONFIRMER (PRD Q2) :
-- order_id, is_processed, is_fraud sont l'hypothèse de travail.
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_rule_performance` AS
-- Une ligne par règle, version et jour : permet de comparer les versions d'une même règle.
SELECT
  a.rule_id,
  a.rule_version,
  a.run_date,
  COUNT(DISTINCT a.order_id)                           AS orders_flagged,
  COUNT(DISTINCT IF(f.is_processed, a.order_id, NULL)) AS orders_processed,
  COUNT(DISTINCT IF(f.is_fraud,     a.order_id, NULL)) AS orders_confirmed_fraud
FROM `${PROJECT}.${DATASET}.rule_alerts` a
LEFT JOIN `${FEEDBACK_TABLE}` f   -- projet.dataset.table (complété par apply.sh / apply.ps1)
  ON f.order_id = a.order_id
GROUP BY a.rule_id, a.rule_version, a.run_date;
