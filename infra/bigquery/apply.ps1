<#
.SYNOPSIS
  Crée ou met à niveau les tables et les vues du contrat de données dans BigQuery (équivalent Windows de apply.sh).

.DESCRIPTION
  Crée le dataset s'il n'existe pas, puis exécute dans l'ordre les fichiers de tables/ puis de views/
  après y avoir remplacé ${PROJECT}, ${DATASET} et ${FEEDBACK_TABLE}. Peut être rejoué sans risque.
  Ordre de priorité de chaque valeur : paramètre, variable d'environnement, puis backend/.env
  (RM_GCP_PROJECT, RM_BQ_DATASET, RM_BQ_FEEDBACK_TABLE, RM_BQ_LOCATION), puis défaut (europe-west9).
  Prérequis : Google Cloud SDK (commande bq) et une connexion faite avec « gcloud auth login ».

.EXAMPLE
  .\apply.ps1                       # tout est lu dans backend/.env

.EXAMPLE
  .\apply.ps1 -Project mon-projet -Dataset fraud_rules -FeedbackTable prestataire.feedback
#>
param(
  [string]$Project = $env:PROJECT,
  [string]$Dataset = $env:DATASET,
  # Table de retour du prestataire (dataset.table, ou projet.dataset.table si elle est dans un autre projet).
  [string]$FeedbackTable = $env:FEEDBACK_TABLE,
  [string]$Location = $env:LOCATION,
  [string]$EnvFile = (Join-Path $PSScriptRoot '..\..\backend\.env')
)

$ErrorActionPreference = 'Stop'

# Valeurs de backend/.env (lues sans être exécutées ; guillemets retirés).
$dotEnv = @{}
if (Test-Path $EnvFile) {
  foreach ($line in Get-Content -Encoding UTF8 $EnvFile) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      # Commentaire en fin de ligne (« valeur  # commentaire ») retiré, comme le fait l'API.
      $dotEnv[$Matches[1]] = $Matches[2] -replace '\s+#.*$', '' -replace '^"(.*)"$', '$1' -replace "^'(.*)'$", '$1'
    }
  }
}
if (-not $Project) { $Project = $dotEnv['RM_GCP_PROJECT'] }
if (-not $Dataset) { $Dataset = $dotEnv['RM_BQ_DATASET'] }
if (-not $FeedbackTable) { $FeedbackTable = $dotEnv['RM_BQ_FEEDBACK_TABLE'] }
if (-not $Location) { $Location = $dotEnv['RM_BQ_LOCATION'] }
if (-not $Location) { $Location = 'europe-west9' }

$missing = @()
if (-not $Project) { $missing += 'Project (ou RM_GCP_PROJECT dans backend/.env)' }
if (-not $Dataset) { $missing += 'Dataset (ou RM_BQ_DATASET)' }
if (-not $FeedbackTable) { $missing += 'FeedbackTable (ou RM_BQ_FEEDBACK_TABLE)' }
if ($missing) { throw "Paramètres manquants : $($missing -join ', ')" }

# La table du prestataire peut être dans un autre projet : « projet.dataset.table » est gardé tel quel,
# « dataset.table » est complété avec le projet de la plateforme.
if (($FeedbackTable.ToCharArray() | Where-Object { $_ -eq '.' }).Count -lt 2) { $FeedbackTable = "$Project.$FeedbackTable" }

if (-not (Get-Command bq -ErrorAction SilentlyContinue)) {
  throw "Commande bq introuvable : installer le Google Cloud SDK (https://cloud.google.com/sdk/docs/install), puis rouvrir PowerShell."
}

# Le SQL est envoyé à bq par l'entrée standard : UTF-8 pour garder les accents des commentaires.
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Write-Host "Projet $Project · dataset $Dataset · région $Location · retour prestataire $FeedbackTable"
bq --project_id=$Project mk --dataset --force --location=$Location "${Project}:${Dataset}" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Création du dataset ${Project}:${Dataset} impossible." }

$vars = @{ PROJECT = $Project; DATASET = $Dataset; FEEDBACK_TABLE = $FeedbackTable }
# Tables d'abord (création, puis mises à niveau), puis les vues, qui en dépendent : chaque dossier dans
# l'ordre de ses numéros. Tout est rejouable.
$files = @('tables', 'views') | ForEach-Object { Get-ChildItem -Path (Join-Path $PSScriptRoot $_) -Filter '*.sql' | Sort-Object Name }
foreach ($file in $files) {
  Write-Host "→ $($file.Directory.Name)/$($file.Name)"
  $sql = Get-Content -Raw -Encoding UTF8 $file.FullName
  foreach ($var in $vars.GetEnumerator()) { $sql = $sql.Replace('${' + $var.Key + '}', $var.Value) }
  $sql | bq --project_id=$Project --location=$Location query --use_legacy_sql=false --quiet
  if ($LASTEXITCODE -ne 0) { throw "Échec de $($file.Name) (voir le message de bq ci-dessus)." }
}

Write-Host "Terminé : dataset ${Project}:${Dataset} à jour."
