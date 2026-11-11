-- Requêtes de référence du SCRIPT D'ENVOI au prestataire (script externe à la plateforme).
-- Remplacer PROJET.DATASET par le projet et le dataset des tables de la plateforme.
--
-- Principe : le script ne modifie jamais rule_alerts (écrite par le DAG). Il note ce qu'il a envoyé dans son
-- propre journal, rule_sends, où il ne fait que des ajouts. Aucun conflit d'écriture avec le DAG, et une
-- commande réécrite par une nouvelle tentative du DAG ne repart pas : elle est déjà dans le journal.
--
-- Déroulé d'un passage :
--   1. lire les commandes à envoyer (requête 1) et garder leurs order_id ;
--   2. les transmettre au prestataire ;
--   3. une fois l'envoi confirmé, les inscrire au journal (requête 2) avec ces order_id.
-- Un seul passage à la fois (deux passages simultanés liraient les mêmes commandes) : planifier le script
-- sans chevauchement (ex. tâche Airflow avec max_active_runs=1).
-- Seul cas de double envoi restant : envoi réussi puis échec de la requête 2 (coupure). Le passage suivant
-- renverrait ces commandes : le prestataire doit ignorer une commande déjà reçue (clé order_id).


-- 1. Commandes à envoyer : marquées « à transmettre » par le DAG (version en production au moment du run)
--    et absentes du journal. Une ligne par commande, toutes règles et versions confondues : la première
--    remontée.
SELECT
  order_id,
  rule_id,
  rule_version,
  detected_at,
  details
FROM `PROJET.DATASET.rule_alerts` a
WHERE to_send
  AND NOT EXISTS (
    SELECT 1 FROM `PROJET.DATASET.rule_sends` s WHERE s.order_id = a.order_id
  )
QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY detected_at, rule_id, rule_version) = 1
ORDER BY detected_at;


-- 2. Inscription au journal des commandes envoyées.
--    @order_ids  ARRAY<STRING> : les order_id transmis à l'étape 2 ;
--    @batch_id   STRING        : identifiant du passage (ex. horodatage), pour la traçabilité.
--    Rejouable sans risque : une commande déjà inscrite ne l'est pas deux fois.
INSERT INTO `PROJET.DATASET.rule_sends` (order_id, sent_at, rule_id, rule_version, batch_id)
SELECT order_id, CURRENT_TIMESTAMP(), rule_id, rule_version, @batch_id
FROM `PROJET.DATASET.rule_alerts` a
WHERE to_send
  AND order_id IN UNNEST(@order_ids)
  AND NOT EXISTS (
    SELECT 1 FROM `PROJET.DATASET.rule_sends` s WHERE s.order_id = a.order_id
  )
QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY detected_at, rule_id, rule_version) = 1;
