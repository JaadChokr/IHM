-- Qualifications des alertes par les analystes. Écrite par la plateforme, et par elle seule : une ligne par
-- qualification, ajoutée (jamais modifiée) ; la DERNIÈRE ligne d'une commande fait foi (verdict NULL :
-- qualification retirée).
-- Une qualification porte sur la COMMANDE, toutes règles confondues : une fraude est une fraude. L'analyste
-- qualifie les seules commandes d'une version EN TEST (non transmises au prestataire, rule_alerts.to_send
-- faux), en trois niveaux : FRAUD (fraude avérée), RISKY (commande risquée), NOT_FRAUD (RAS). Les commandes
-- transmises sont vérifiées par le prestataire (table de retour).
-- Utilisée par v_rule_orders et v_rule_performance : une commande en test qualifiée compte comme vérifiée ; le
-- verdict du prestataire, s'il existe (commande transmise par une autre règle), reste prioritaire.
CREATE TABLE IF NOT EXISTS `${PROJECT}.${DATASET}.alert_reviews` (
  order_id     STRING    NOT NULL,
  verdict      STRING,               -- FRAUD | RISKY | NOT_FRAUD ; NULL : qualification retirée
  is_fraud     BOOL,                 -- ancienne qualification (fraude oui / non), reprise dans verdict par 014
  reviewed_by  STRING    NOT NULL,   -- matricule de l'analyste
  reviewed_at  TIMESTAMP NOT NULL,
  rule_id      STRING    NOT NULL,   -- règle et version depuis lesquelles la commande a été qualifiée (contexte)
  rule_version INT64     NOT NULL
)
PARTITION BY DATE(reviewed_at)
CLUSTER BY order_id;
