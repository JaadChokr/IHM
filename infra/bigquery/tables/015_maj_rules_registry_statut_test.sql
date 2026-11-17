-- Statuts de rules_registry alignés sur la plateforme : une version publiée est en test d'office, qu'elle ait
-- déjà tourné ou non, sous le code TEST. Reprend les lignes écrites avant ce changement : SUBMITTED (publiée,
-- pas encore exécutée) et OBSERVATION (ancien code de « en test »). Rejouable : sans effet une fois fait.
-- Le DAG n'est pas concerné : il ne lit que send_to_provider.
UPDATE `${PROJECT}.${DATASET}.rules_registry`
SET status = 'TEST'
WHERE status IN ('SUBMITTED', 'OBSERVATION');
