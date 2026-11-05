<#
.SYNOPSIS
  Lance Rules Manager en une commande sous Windows (équivalent du Makefile) : installe ce qui manque,
  prépare la base locale, démarre l'API puis l'interface et ouvre le navigateur.

.DESCRIPTION
  Premier lancement : crée l'environnement Python (backend\.venv), installe les dépendances Python et
  npm, crée backend\.env (SQLite, BigQuery simulé) s'il n'existe pas. Lancements suivants : ne réinstalle
  que si pyproject.toml ou package-lock.json a changé. Ctrl+C arrête l'interface et l'API.

.PARAMETER Demo
  Interface seule, données simulées dans le navigateur (pas de Python nécessaire).

.PARAMETER BigQuery
  Met aussi à jour les tables et vues BigQuery (infra\bigquery\apply.ps1) avant de démarrer : projet,
  dataset et table du prestataire lus dans backend\.env. Demande l'outil bq connecté (gcloud auth login)
  et des droits d'administration sur le dataset. S'arrête si la mise à jour échoue.

.PARAMETER Install
  Réinstallation propre : supprime l'environnement Python (backend\.venv, ou celui créé dans
  %LOCALAPPDATA%\RulesManager si Documents est protégé) et frontend\node_modules, puis réinstalle tout.
  La base locale (backend\rules.db) et backend\.env sont conservés.

.EXAMPLE
  .\run.cmd                 # double-clic possible
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\run.ps1 -Demo
.EXAMPLE
  .\run.cmd -BigQuery      # met d'abord à jour les tables BigQuery, puis démarre

.PARAMETER ApiPort
  Premier port essayé pour l'API (8000 par défaut) ; s'il est occupé, le suivant libre est pris.

.PARAMETER WebPort
  Premier port essayé pour l'interface (5173 par défaut) ; même principe.
#>
param(
  [switch]$Demo,
  [switch]$Install,
  [switch]$BigQuery,
  [int]$ApiPort = 8000,
  [int]$WebPort = 5173
)

$ErrorActionPreference = 'Stop'
if ($Demo -and $BigQuery) {
  throw "-BigQuery est sans objet avec -Demo (données simulées dans le navigateur, aucun accès à BigQuery)."
}
$root = $PSScriptRoot
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'

# Vrai si le port est libre en local (IPv4 et, si la machine l'a, IPv6 : Vite écoute sur « localhost »).
function Test-PortFree([int]$port) {
  foreach ($address in @([System.Net.IPAddress]::Loopback, [System.Net.IPAddress]::IPv6Loopback)) {
    $listener = [System.Net.Sockets.TcpListener]::new($address, $port)
    try { $listener.Start() }
    catch {
      # PowerShell enveloppe l'erreur .NET : on regarde l'exception d'origine.
      $e = $_.Exception
      if ($e.InnerException) { $e = $e.InnerException }
      # Occupé, ou réservé par Windows (Hyper-V, WSL) : AccessDenied.
      $code = if ($e -is [System.Net.Sockets.SocketException]) { "$($e.SocketErrorCode)" } else { '' }
      if ($code -eq 'AddressAlreadyInUse' -or $code -eq 'AccessDenied') { return $false }
      # Autre erreur (IPv6 absent…) : rien ne peut écouter à cette adresse, on l'ignore.
    }
    finally { $listener.Stop() }
  }
  return $true
}

# Premier port libre à partir de $start ; signale quand le port demandé était pris.
function Get-FreePort([int]$start, [string]$label) {
  for ($port = $start; $port -lt $start + 50; $port++) {
    if (Test-PortFree $port) {
      if ($port -ne $start) { Write-Host "  Port $start occupé : $label sur le port $port." -ForegroundColor Yellow }
      return $port
    }
  }
  throw "Aucun port libre entre $start et $($start + 49) pour $label."
}

function Step($text) { Write-Host "`n▶ $text" -ForegroundColor Cyan }

# Vrai si la cible est absente ou plus ancienne que la source (pour ne réinstaller qu'au besoin).
function NeedsUpdate($stamp, $source) {
  -not (Test-Path $stamp) -or (Get-Item $source).LastWriteTime -gt (Get-Item $stamp).LastWriteTime
}

# ---------------------------------------------------------------- outils
Step 'Vérification des outils'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js introuvable. Installer la version LTS (winget install OpenJS.NodeJS.LTS ou https://nodejs.org), puis rouvrir PowerShell."
}
Write-Host "  Node.js $(node -v)"

$python = $null
if (-not $Demo) {
  # Python 3.12 ou plus : lanceur py d'abord, puis python.
  foreach ($candidate in @(@('py', '-3.13'), @('py', '-3.12'), @('python'))) {
    if (-not (Get-Command $candidate[0] -ErrorAction SilentlyContinue)) { continue }
    $exe = $candidate[0]; $rest = @($candidate | Select-Object -Skip 1)
    # try/catch : sous Windows PowerShell 5.1, une sortie d'erreur redirigée lève une exception avec 'Stop'.
    try { $ok = & $exe @rest -c 'import sys; print(sys.version_info >= (3, 12))' 2>$null } catch { continue }
    if ($LASTEXITCODE -eq 0 -and "$ok".Trim() -eq 'True') { $python = $candidate; break }
  }
  if (-not $python) {
    throw "Python 3.12 ou plus introuvable. Installer : winget install Python.Python.3.12, puis rouvrir PowerShell. (Ou lancer l'interface seule avec -Demo.)"
  }
  $exe = $python[0]; $rest = @($python | Select-Object -Skip 1)
  $pythonPath = & $exe @rest -c 'import sys; print(sys.executable)'
  Write-Host "  $(& $exe @rest --version) ($pythonPath)"
  if ($pythonPath -like '*\WindowsApps\*') {
    Write-Host '  Attention : Python du Microsoft Store, source fréquente de problèmes. Préférer : winget install Python.Python.3.12' -ForegroundColor Yellow
  }
}

# Environnement Python : backend\.venv, ou à défaut un dossier hors du projet. Sur les postes d'entreprise,
# Documents est souvent protégé (accès contrôlé aux dossiers de Windows Defender, OneDrive) et python.exe
# ne peut pas y créer d'environnement. Un suffixe propre à ce dossier évite de mélanger deux copies du projet.
$sha = [System.Security.Cryptography.SHA256]::Create()  # SHA-256 : MD5 est interdit sur les postes en mode FIPS
$suffix = -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($root)) | Select-Object -First 4 | ForEach-Object { $_.ToString('x2') })
$venvDirs = @((Join-Path $backend '.venv'), (Join-Path $env:LOCALAPPDATA "RulesManager\venv-$suffix"))

# Crée un environnement Python ; en cas d'échec, retire ce qui a été créé à moitié.
function New-Venv($dir) {
  # Out-Host : la sortie de python ne doit pas se mêler à la valeur renvoyée par la fonction.
  try { & $exe @rest -m venv $dir | Out-Host } catch { Write-Host "  $_" }
  if (Test-Path (Join-Path $dir 'Scripts\python.exe')) { return $true }
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
  return $false
}

# Supprime un dossier d'installation ; échoue clairement s'il est verrouillé (application encore ouverte).
function Reset-Folder($path, $label) {
  if (-not (Test-Path $path)) { return }
  Write-Host "  Suppression de $label…"
  try { Remove-Item -Recurse -Force $path }
  catch { throw "Impossible de supprimer $label : fermer les autres fenêtres de Rules Manager (API, interface, VS Code) puis relancer." }
}

if ($Install) {
  Step 'Réinstallation propre demandée (-Install)'
  if (-not $Demo) { foreach ($dir in $venvDirs) { Reset-Folder $dir $dir } }
  Reset-Folder (Join-Path $frontend 'node_modules') 'frontend\node_modules'
}

# ---------------------------------------------------------------- API
$api = $null
if (-not $Demo) {
  Push-Location $backend
  try {
    $venvDir = $venvDirs | Where-Object { Test-Path (Join-Path $_ 'Scripts\python.exe') } | Select-Object -First 1
    if (-not $venvDir) {
      foreach ($dir in $venvDirs) {
        Step "Création de l'environnement Python ($dir)"
        if (New-Venv $dir) { $venvDir = $dir; break }
        Write-Host '  Échec à cet emplacement.' -ForegroundColor Yellow
      }
      if (-not $venvDir) {
        throw "Impossible de créer l'environnement Python, même hors du dossier Documents. Vérifier l'installation de Python (winget install Python.Python.3.12) ou demander au service informatique d'autoriser python.exe."
      }
    }
    $venvPython = Join-Path $venvDir 'Scripts\python.exe'
    $stamp = Join-Path $venvDir '.installed'
    if (NeedsUpdate $stamp (Join-Path $backend 'pyproject.toml')) {
      Step 'Installation des dépendances Python'
      & $venvPython -m pip install --disable-pip-version-check -e '.[dev]'
      if ($LASTEXITCODE -ne 0) { throw 'pip install a échoué (voir ci-dessus).' }
      Set-Content -Path $stamp -Value (Get-Date -Format o)
    }

    if (-not (Test-Path '.env')) {
      Step 'Création de backend\.env (SQLite local, BigQuery simulé)'
      @(
        'RM_ENV=local'
        'RM_DATABASE_URL=sqlite:///./rules.db'
        'RM_BIGQUERY_MODE=fake'
        'RM_COOKIE_SECURE=false'
      ) | Set-Content -Path '.env' -Encoding ASCII
    }

    Step 'Mise à jour de la base (alembic upgrade head)'
    & $venvPython -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw 'La migration de la base a échoué (voir ci-dessus).' }

    if ($BigQuery) {
      # Tables partagées avec Airflow : seulement sur demande. apply.ps1 lève une erreur en cas d'échec,
      # ce qui arrête le lancement avant de démarrer l'API.
      Step 'Mise à jour des tables BigQuery (infra\bigquery\apply.ps1)'
      & (Join-Path $root 'infra\bigquery\apply.ps1') -EnvFile (Join-Path $backend '.env')
    }

    $ApiPort = Get-FreePort $ApiPort "l'API"
    Step "Démarrage de l'API sur http://127.0.0.1:$ApiPort (journal : backend\api.log)"
    $api = Start-Process -FilePath $venvPython -WorkingDirectory $backend -NoNewWindow -PassThru `
      -ArgumentList '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', $ApiPort `
      -RedirectStandardOutput (Join-Path $backend 'api.log') -RedirectStandardError (Join-Path $backend 'api-errors.log')

    # On attend que l'API réponde avant d'ouvrir l'interface.
    $ready = $false
    for ($i = 0; $i -lt 40 -and -not $api.HasExited; $i++) {
      try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$ApiPort/healthz" | Out-Null; $ready = $true; break }
      catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) {
      Get-Content (Join-Path $backend 'api-errors.log') -Tail 20 -ErrorAction SilentlyContinue | Write-Host
      throw "L'API ne répond pas (voir backend\api-errors.log)."
    }
    Write-Host '  API prête.'
  }
  finally { Pop-Location }
}

# ---------------------------------------------------------------- interface
try {
  Push-Location $frontend
  if (-not (Test-Path 'node_modules') -or (NeedsUpdate 'node_modules\.package-lock.json' 'package-lock.json')) {
    Step 'Installation des dépendances npm'
    npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw 'npm install a échoué (voir ci-dessus).' }
  }

  $env:VITE_API_MODE = if ($Demo) { 'mock' } else { 'http' }
  # 127.0.0.1 plutôt que localhost : Node résout localhost en IPv6 (::1), où l'API n'écoute pas.
  $env:API_URL = "http://127.0.0.1:$ApiPort"
  $WebPort = Get-FreePort $WebPort "l'interface"
  Step $(if ($Demo) { 'Interface en mode démo (données simulées)' } else { "Interface branchée sur l'API (port $ApiPort)" })
  Write-Host "  http://localhost:$WebPort s'ouvre dans le navigateur. Ctrl+C pour tout arrêter." -ForegroundColor Green
  # Vite lancé directement (pas via npm.cmd) : Ctrl+C arrête sans la question « Terminer le programme de commandes ? ».
  node node_modules\vite\bin\vite.js --open --port $WebPort --strictPort
}
finally {
  Pop-Location
  if ($api -and -not $api.HasExited) {
    Write-Host "`nArrêt de l'API…"
    Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue
  }
}
