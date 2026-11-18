-- Requêtes de référence du SCRIPT D'ENVOI au prestataire (script externe à la plateforme).
-- Remplacer ${PROJECT}.${DATASET} par le projet et le dataset des tables de la plateforme (même convention
-- que infra/bigquery : envsubst, ou à la main).
--
-- Principe : chaque table n'a qu'un écrivain. Le DAG écrit rule_alerts ; le script ne la modifie jamais. Il
-- note ce qu'il a envoyé dans son propre journal, rule_sends, où il ne fait que des ajouts. Le DAG n'efface
-- jamais une commande présente au journal. Aucun conflit d'écriture, et une commande réécrite par une
-- nouvelle tentative du DAG ne repart pas.
--
-- Déroulé d'un passage :
--   1. lire les commandes à envoyer (requête 1) et garder, pour chacune, order_id, rule_id et rule_version ;
--   2. les transmettre au prestataire ;
--   3. une fois l'envoi confirmé, les inscrire au journal (requête 2) avec ces valeurs, telles que lues à
--      l'étape 1. La requête 2 ne relit pas rule_alerts : si le DAG relance un run entre les étapes 1 et 3, il
--      efface puis réécrit les commandes de ce run, et une commande envoyée pourrait y manquer au moment de
--      l'inscription (elle repartirait au passage suivant).
-- L'étape 3 est indispensable : sans elle, chaque passage renverrait toutes les commandes à transmettre.
-- Un seul passage à la fois (deux passages simultanés liraient les mêmes commandes) : planifier le script
-- sans chevauchement (ex. tâche Airflow avec max_active_runs=1).
-- Seul cas de double envoi restant : envoi réussi puis échec de la requête 2 (coupure). Le passage suivant
-- renverrait ces commandes : le prestataire doit ignorer une commande déjà reçue (clé order_id).


-- 1. Commandes à envoyer : marquées « à transmettre » par le DAG (version en production au moment du run)
--    et absentes du journal. Une ligne par commande, toutes règles et versions confondues : la première
--    remontée. details : les autres colonnes renvoyées par la règle (JSON).
SELECT
  order_id,
  rule_id,
  rule_version,
  detected_at,
  details
FROM `${PROJECT}.${DATASET}.rule_alerts` a
WHERE to_send
  AND NOT EXISTS (
    SELECT 1 FROM `${PROJECT}.${DATASET}.rule_sends` s WHERE s.order_id = a.order_id
  )
QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY detected_at, rule_id, rule_version) = 1
ORDER BY detected_at;


-- 2. Inscription au journal des commandes envoyées, telles que lues à l'étape 1.
--    @sent      ARRAY<STRUCT<order_id STRING, rule_id STRING, rule_version INT64>> : les commandes transmises ;
--    @batch_id  STRING : identifiant du passage (ex. horodatage), pour la traçabilité.
--    Rejouable sans risque : une commande déjà inscrite ne l'est pas deux fois.
INSERT INTO `${PROJECT}.${DATASET}.rule_sends` (order_id, sent_at, rule_id, rule_version, batch_id)
SELECT e.order_id, CURRENT_TIMESTAMP(), e.rule_id, e.rule_version, @batch_id
FROM UNNEST(@sent) AS e
WHERE NOT EXISTS (
  SELECT 1 FROM `${PROJECT}.${DATASET}.rule_sends` s WHERE s.order_id = e.order_id
)
QUALIFY ROW_NUMBER() OVER (PARTITION BY e.order_id) = 1;


-- Exemple en Python (google-cloud-bigquery), étape 3 (à sauter si rien n'a été envoyé : un tableau vide de
-- STRUCT ne peut pas être typé) :
--   from google.cloud import bigquery
--   params = [
--       bigquery.ArrayQueryParameter("sent", "STRUCT", [
--           bigquery.StructQueryParameter(None,
--               bigquery.ScalarQueryParameter("order_id", "STRING", r["order_id"]),
--               bigquery.ScalarQueryParameter("rule_id", "STRING", r["rule_id"]),
--               bigquery.ScalarQueryParameter("rule_version", "INT64", r["rule_version"]),
--           ) for r in rows_envoyees
--       ]),
--       bigquery.ScalarQueryParameter("batch_id", "STRING", batch_id),
--   ]
--   client.query(requete_2, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
