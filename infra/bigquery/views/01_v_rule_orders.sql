-- Commandes remontées : UNE LIGNE PAR COMMANDE ET PAR VERSION DE RÈGLE (rule_alerts), avec le retour du
-- prestataire et la qualification des analystes. SEULE DÉFINITION de la règle de verdict : la plateforme
-- (chiffres des règles, liste des alertes) et v_rule_performance la lisent, sans la recopier.
--
-- Règle de verdict d'une commande :
--   - le prestataire l'a vérifiée (elle figure dans sa table de retour) : son verdict, FRAUD ou NOT_FRAUD ;
--   - sinon, commande transmise (version en production, to_send) : PENDING, en attente du prestataire ;
--   - sinon (version en test) : la dernière qualification d'un analyste (alert_reviews), FRAUD ou
--     NOT_FRAUD, ou TO_REVIEW tant qu'il n'y en a pas.
-- is_verified : verdict connu ; is_confirmed : fraude. La précision porte sur les commandes vérifiées.
--
-- Chiffres d'une règle, selon son état : en production, ses commandes à transmettre (to_send) ; en test,
-- les autres. La plateforme compte les commandes distinctes sur la période : une commande remontée par
-- deux versions n'est comptée qu'une fois.
-- Colonnes de la table de feedback À CONFIRMER (PRD Q2) : order_id, is_fraud sont l'hypothèse de travail.
DROP VIEW IF EXISTS `${PROJECT}.${DATASET}.v_rule_orders_daily`;  -- ancienne vue, remplacée par celle-ci
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_rule_orders` AS
WITH feedback AS (
  SELECT order_id, LOGICAL_OR(is_fraud) AS is_fraud
  FROM `${FEEDBACK_TABLE}`   -- projet.dataset.table (complété par apply.sh / apply.ps1)
  GROUP BY order_id
),
reviews AS (
  SELECT order_id, is_fraud, reviewed_by, reviewed_at
  FROM `${PROJECT}.${DATASET}.alert_reviews`
  QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY reviewed_at DESC) = 1
),
orders AS (
  SELECT
    a.rule_id,
    a.rule_version,
    a.run_date,
    a.order_id,
    a.detected_at,
    a.details,
    IFNULL(a.to_send, FALSE) AS to_send,
    f.order_id IS NOT NULL   AS has_feedback,
    f.is_fraud,                         -- verdict du prestataire (NULL : pas vérifiée)
    r.is_fraud               AS review_is_fraud,  -- dernière qualification (NULL : aucune ou retirée)
    r.reviewed_by,
    r.reviewed_at
  FROM `${PROJECT}.${DATASET}.rule_alerts` a
  LEFT JOIN feedback f USING (order_id)
  LEFT JOIN reviews r USING (order_id)
),
judged AS (
  SELECT
    *,
    CASE
      WHEN has_feedback THEN IF(is_fraud, 'FRAUD', 'NOT_FRAUD')
      WHEN to_send THEN 'PENDING'
      WHEN review_is_fraud IS NULL THEN 'TO_REVIEW'
      WHEN review_is_fraud THEN 'FRAUD'
      ELSE 'NOT_FRAUD'
    END AS verdict
  FROM orders
)
SELECT
  *,
  verdict IN ('FRAUD', 'NOT_FRAUD') AS is_verified,
  verdict = 'FRAUD'                 AS is_confirmed
FROM judged;
