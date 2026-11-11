-- Indicateurs F6 (PRD §7.4). Colonnes de la table de feedback À CONFIRMER (PRD Q2) : order_id, is_fraud
-- sont l'hypothèse de travail. Une commande transmise au prestataire est « vérifiée » dès qu'elle figure dans
-- sa table de retour ; une commande d'une version en test l'est aussi quand un analyste l'a qualifiée
-- (alert_reviews ; le verdict du prestataire, s'il existe, reste prioritaire). La précision porte sur les
-- commandes vérifiées ; les autres sont en attente de vérification (orders_flagged - orders_processed).
-- Même règle de calcul que v_rule_orders (is_verified / is_confirmed), reprise ici : une vue ne peut pas
-- dépendre d'une vue créée après elle.
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_rule_performance` AS
-- Une ligne par règle, version et jour : permet de comparer les versions d'une même règle. Une commande
-- remontée par deux versions y figure pour chacune : ne pas additionner les versions pour obtenir les
-- totaux de la règle (voir v_rule_orders).
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
  o.rule_id,
  o.rule_version,
  o.run_date,
  COUNT(DISTINCT o.order_id) AS orders_flagged,
  COUNT(DISTINCT IF(IF(o.to_send, o.has_feedback, o.has_feedback OR r.is_fraud IS NOT NULL), o.order_id, NULL))
    AS orders_processed,  -- vérifiées
  COUNT(DISTINCT IF(IFNULL(IF(o.to_send OR o.has_feedback, o.is_fraud, r.is_fraud), FALSE), o.order_id, NULL))
    AS orders_confirmed_fraud
FROM orders o
LEFT JOIN reviews r USING (order_id)
GROUP BY o.rule_id, o.rule_version, o.run_date;
