#!/usr/bin/env bash
# Crée ou met à niveau les tables et les vues du contrat de données. Peut être rejoué. Usage :
#   ./apply.sh                                   # valeurs lues dans backend/.env
#   PROJECT=mon-projet DATASET=fraud_rules FEEDBACK_TABLE=dataset.table ./apply.sh   # ou projet.dataset.table
# Ordre de priorité : variable d'environnement, puis backend/.env (RM_GCP_PROJECT, RM_BQ_DATASET,
# RM_BQ_FEEDBACK_TABLE, RM_BQ_LOCATION), puis valeur par défaut (région europe-west9).
set -euo pipefail
cd "$(dirname "$0")"
ENV_FILE="${ENV_FILE:-../../backend/.env}"

# Valeur d'une clé de backend/.env (sans exécuter le fichier ; commentaire de fin de ligne, guillemets et
# fins de ligne Windows retirés).
from_env() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -n 1 | tr -d '\r' |
    sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

PROJECT="${PROJECT:-$(from_env RM_GCP_PROJECT)}"
DATASET="${DATASET:-$(from_env RM_BQ_DATASET)}"
FEEDBACK_TABLE="${FEEDBACK_TABLE:-$(from_env RM_BQ_FEEDBACK_TABLE)}"
LOCATION="${LOCATION:-$(from_env RM_BQ_LOCATION)}"
LOCATION="${LOCATION:-europe-west9}"
# La table du prestataire peut être dans un autre projet : « projet.dataset.table » est gardé tel quel,
# « dataset.table » est complété avec le projet de la plateforme.
case "$FEEDBACK_TABLE" in *.*.*) ;; ?*) FEEDBACK_TABLE="$PROJECT.$FEEDBACK_TABLE" ;; esac
export PROJECT DATASET FEEDBACK_TABLE

missing=()
[ -n "$PROJECT" ] || missing+=("PROJECT (ou RM_GCP_PROJECT dans backend/.env)")
[ -n "$DATASET" ] || missing+=("DATASET (ou RM_BQ_DATASET)")
[ -n "$FEEDBACK_TABLE" ] || missing+=("FEEDBACK_TABLE (ou RM_BQ_FEEDBACK_TABLE)")
if [ ${#missing[@]} -gt 0 ]; then
  printf 'Valeurs manquantes :\n' >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 1
fi

echo "Projet $PROJECT · dataset $DATASET · région $LOCATION · retour prestataire $FEEDBACK_TABLE"
bq --project_id="$PROJECT" mk --dataset --force --location="$LOCATION" "$PROJECT:$DATASET" >/dev/null
# Tables d'abord (création, puis mises à niveau des tables existantes), puis les vues, qui en dépendent :
# chaque dossier dans l'ordre de ses numéros. Tout est rejouable.
for f in tables/*.sql views/*.sql; do
  echo "→ $f"
  envsubst '${PROJECT} ${DATASET} ${FEEDBACK_TABLE}' < "$f" |
    bq --project_id="$PROJECT" --location="$LOCATION" query --use_legacy_sql=false --quiet
done
echo "Terminé."
