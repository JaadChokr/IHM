-- Journal des envois au prestataire. Écrit par le SCRIPT D'ENVOI externe, et par lui seul : une ligne par
-- commande transmise, ajoutée après l'envoi. Le script n'écrit jamais dans rule_alerts, le DAG n'écrit jamais
-- ici : les deux ne modifient plus la même table, donc plus de conflit d'écriture ni de double envoi quand une
-- nouvelle tentative du DAG réécrit les commandes d'un run pendant un passage du script.
--   - Commandes à envoyer : rule_alerts.to_send, et commande absente de ce journal (dédoublonnage par
--     commande, toutes règles et versions confondues) ;
--   - le DAG n'efface jamais une commande présente ici (DELETE … AND NOT EXISTS rule_sends).
-- Requêtes de référence du script : infra/prestataire/requetes_envoi.sql.
CREATE TABLE IF NOT EXISTS `${PROJECT}.${DATASET}.rule_sends` (
  order_id     STRING    NOT NULL,   -- commande transmise (une seule fois, toutes règles confondues)
  sent_at      TIMESTAMP NOT NULL,   -- date de transmission
  rule_id      STRING    NOT NULL,   -- règle et version au titre desquelles elle est partie (première remontée)
  rule_version INT64     NOT NULL,
  batch_id     STRING    NOT NULL,   -- passage du script d'envoi
  -- Clé logique : une ligne par commande. BigQuery ne l'applique pas (NOT ENFORCED) : le script s'en charge
  -- (INSERT … WHERE NOT EXISTS).
  PRIMARY KEY (order_id) NOT ENFORCED
)
PARTITION BY DATE(sent_at)
CLUSTER BY order_id;

-- Reprise de l'historique : les commandes déjà marquées envoyées dans rule_alerts.sent_at (ancien mode de
-- suivi) entrent dans le journal, pour ne pas repartir à la bascule. Sans effet sur une installation neuve
-- (pas de colonne sent_at) ni au second passage (commandes déjà présentes).
IF EXISTS (SELECT 1 FROM `${PROJECT}.${DATASET}.INFORMATION_SCHEMA.COLUMNS`
           WHERE table_name = 'rule_alerts' AND column_name = 'sent_at') THEN
  EXECUTE IMMEDIATE """
    INSERT INTO `${PROJECT}.${DATASET}.rule_sends` (order_id, sent_at, rule_id, rule_version, batch_id)
    SELECT order_id, sent_at, rule_id, rule_version, 'reprise-sent_at'
    FROM `${PROJECT}.${DATASET}.rule_alerts` a
    WHERE sent_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM `${PROJECT}.${DATASET}.rule_sends` s WHERE s.order_id = a.order_id)
    QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY sent_at, rule_id, rule_version) = 1
  """;
END IF;
