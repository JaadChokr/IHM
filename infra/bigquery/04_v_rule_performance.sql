-- Indicateurs F6 (PRD §7.4). Colonnes de la table de feedback À CONFIRMER (PRD Q2) : order_id, is_fraud
-- sont l'hypothèse de travail. Le prestataire traite toutes les commandes qu'il reçoit : une commande est
-- « traitée » dès qu'elle figure dans sa table de retour (orders_processed), et la précision porte sur
-- celles-là. Les autres sont en attente de retour (orders_flagged - orders_processed).
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_rule_performance` AS
-- Une ligne par règle, version et jour : permet de comparer les versions d'une même règle. Une commande
-- remontée par deux versions y figure pour chacune : ne pas additionner les versions pour obtenir les
-- totaux de la règle (voir v_rule_orders).
SELECT
  a.rule_id,
  a.rule_version,
  a.run_date,
  COUNT(DISTINCT a.order_id)                           AS orders_flagged,
  COUNT(DISTINCT IF(f.order_id IS NOT NULL, a.order_id, NULL)) AS orders_processed,  -- avec retour
  COUNT(DISTINCT IF(f.is_fraud, a.order_id, NULL))             AS orders_confirmed_fraud
FROM `${PROJECT}.${DATASET}.rule_alerts` a
LEFT JOIN `${FEEDBACK_TABLE}` f   -- projet.dataset.table (complété par apply.sh / apply.ps1)
  ON f.order_id = a.order_id
GROUP BY a.rule_id, a.rule_version, a.run_date;
