-- Qualifications des alertes par les analystes (fraude ou non). Écrite par la plateforme, et par elle seule :
-- une ligne par qualification, ajoutée (jamais modifiée) ; la DERNIÈRE ligne d'une commande fait foi
-- (is_fraud NULL : qualification retirée).
-- Une qualification porte sur la COMMANDE, toutes règles confondues : une fraude est une fraude. L'analyste
-- qualifie les commandes d'une version EN TEST (non transmises au prestataire, rule_alerts.to_send faux) ; les
-- commandes transmises sont vérifiées par le prestataire (table de retour).
-- Utilisée par v_rule_orders et v_rule_performance : une commande en test qualifiée compte comme vérifiée ; le
-- verdict du prestataire, s'il existe (commande transmise par une autre règle), reste prioritaire.
CREATE TABLE IF NOT EXISTS `${PROJECT}.${DATASET}.alert_reviews` (
  order_id     STRING    NOT NULL,
  is_fraud     BOOL,                 -- vrai : fraude ; faux : pas une fraude ; NULL : qualification retirée
  reviewed_by  STRING    NOT NULL,   -- matricule de l'analyste
  reviewed_at  TIMESTAMP NOT NULL,
  rule_id      STRING    NOT NULL,   -- règle et version depuis lesquelles la commande a été qualifiée (contexte)
  rule_version INT64     NOT NULL
)
PARTITION BY DATE(reviewed_at)
CLUSTER BY order_id;
