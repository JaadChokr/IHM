-- Indicateurs F6 (PRD §7.4) : une ligne par règle, version et jour, pour comparer les versions d'une même
-- règle. Simple regroupement de v_rule_orders (créée avant) : la règle de verdict n'est pas recopiée ici.
-- orders_processed : commandes vérifiées (par le prestataire, ou qualifiées par un analyste en test) ; la
-- précision porte sur celles-là, les autres sont en attente (orders_flagged - orders_processed).
-- Une commande remontée par deux versions figure pour chacune : ne pas additionner les versions pour
-- obtenir les totaux de la règle (voir v_rule_orders).
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_rule_performance` AS
SELECT
  rule_id,
  rule_version,
  run_date,
  COUNT(DISTINCT order_id)                            AS orders_flagged,
  COUNT(DISTINCT IF(is_verified, order_id, NULL))     AS orders_processed,
  COUNT(DISTINCT IF(is_confirmed, order_id, NULL))    AS orders_confirmed_fraud
FROM `${PROJECT}.${DATASET}.v_rule_orders`
GROUP BY rule_id, rule_version, run_date;
