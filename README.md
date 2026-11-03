# Rules Manager

Plateforme de gestion des règles de détection de fraude : l'équipe fraude **crée, teste et suit** ses règles
sans passer par le mail, et mesure leur efficacité grâce au retour du prestataire (PRD v0.1).

## Structure

```
.
├── frontend/            React + TypeScript + Vite — l'IHM (Nginx non-root en production)
│   ├── src/api/         contrat d'API (client.ts, types.ts) + implémentation mock pour la démo
│   ├── src/pages/       écrans (liste, éditeur, détail, vue production, audit, profil)
│   └── nginx/           conf Nginx : sert la SPA et relaie /api vers l'API
├── backend/             Python 3.12 + FastAPI — l'API, un fichier par domaine (routes + logique)
│   ├── app/main.py      création de l'application, branchement des routes
│   ├── app/core.py      configuration (variables RM_*), erreurs, horloge
│   ├── app/database.py  connexion PostgreSQL, tables, écriture du journal d'audit
│   ├── app/schemas.py   formats JSON échangés avec le front
│   ├── app/auth.py      identification par matricule ; point UNIQUE de résolution de l'identité
│   ├── app/rules.py     règles : liste, versions, décision d'envoi (F1, F5) ; app/drafts.py : brouillons et publication (F4)
│   ├── app/query.py     test d'une requête : dry-run, exécution, garde-fous (F3)
│   ├── app/sql_checks.py contrôles du SQL non couverts par BigQuery (paramètres, dates en dur…)
│   ├── app/pilotage.py  indicateurs de performance et journal d'audit, en lecture (F6, F7, F8)
│   ├── app/bigquery.py  tout l'accès BigQuery (réel ou factice), dont la publication dans rules_registry
│   ├── migrations/      Alembic (PostgreSQL / Cloud SQL)
│   └── tests/           pytest (SQLite en mémoire + BigQuery factice)
├── infra/
│   ├── airflow/         DAG de référence : un DAG par fréquence, une tâche par règle
│   ├── bigquery/        contrat de données §7 : rules_registry, rule_runs, rule_alerts (+ details), v_rule_performance
│   └── cloudbuild.yaml  build → Artifact Registry → Cloud Run (+ job de migration)
├── docker-compose.yml   environnement local complet (PostgreSQL + API + front)
├── .github/workflows/   CI : typecheck, tests, lint, migrations sur PostgreSQL, build des images
├── Makefile             commandes courantes (macOS / Linux)
└── run.cmd, run.ps1     tout lancer en une commande sous Windows
```

## Démarrer

Aucun Docker n'est nécessaire : en local, l'API tourne sur SQLite (un simple fichier) au lieu de PostgreSQL,
avec BigQuery simulé. Il faut seulement **Node.js**, **Python 3.12 ou plus** et **Git**.

### 1. Installer les outils (une seule fois)

**Windows** (PowerShell) — fermer puis rouvrir PowerShell après l'installation :
```powershell
winget install OpenJS.NodeJS.LTS
winget install Python.Python.3.12
winget install Git.Git
```

**macOS** (avec [Homebrew](https://brew.sh)) :
```bash
brew install node python@3.12 git
```

**Linux (Ubuntu/Debian)** :
```bash
sudo apt install -y git python3 python3-venv
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
```

Vérification : `node -v` (22.x ou plus) et `python --version` / `python3 --version` (3.12 ou plus).

### 2. Récupérer le code

```bash
git clone -b claude/rules-manager-prd-oldfut https://github.com/jxc18/ihm.git
cd ihm
```
Sans Git : télécharger https://github.com/JxC18/IHM/archive/refs/heads/claude/rules-manager-prd-oldfut.zip,
le décompresser et ouvrir un terminal dans le dossier `IHM-claude-rules-manager-prd-oldfut`.

### Windows : tout lancer en une commande

Après l'étape 1 (Node.js et Python installés), à la racine du projet : **double-cliquer sur `run.cmd`**, ou
dans PowerShell :
```powershell
.\run.cmd            # API + interface, navigateur ouvert sur http://localhost:5173
.\run.cmd -Demo      # interface seule, données simulées (Python inutile)
.\run.cmd -Install   # réinstallation propre (supprime backend\.venv et frontend\node_modules ; base et .env conservés)
```
Le premier lancement installe tout (quelques minutes) et crée `backend\.env` (SQLite, BigQuery simulé) s'il
n'existe pas ; les suivants démarrent directement. Journal de l'API : `backend\api.log`, `backend\api-errors.log`.
`Ctrl+C` arrête l'interface et l'API. Si le port 8000 (API) ou 5173 (interface) est occupé, le script prend
le suivant libre et l'indique. Si Python ne peut pas créer `backend\.venv` (dossier *Documents*
protégé par Windows Defender ou synchronisé par OneDrive), l'environnement est créé dans
`%LOCALAPPDATA%\RulesManager` et réutilisé ensuite automatiquement. Les étapes 3a et 3b ci-dessous détaillent ce que fait le script.

### 3a. Voir l'interface seule (données simulées)

```bash
cd frontend
npm install
npm run dev
```
Ouvrir http://localhost:5173 et se connecter avec le matricule `104233` (ou `118870`, `120415`).

### 3b. Interface + vraie API

Deux terminaux, depuis le dossier du projet.

**Terminal 1 — API**

Windows (PowerShell) :
```powershell
cd backend
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev]"
$env:RM_DATABASE_URL="sqlite:///./rules.db"; $env:RM_COOKIE_SECURE="false"
.venv\Scripts\alembic upgrade head
.venv\Scripts\uvicorn app.main:app --port 8000
```

macOS / Linux :
```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
export RM_DATABASE_URL=sqlite:///./rules.db RM_COOKIE_SECURE=false
.venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --port 8000
```
Documentation interactive de l'API : http://localhost:8000/docs

**Terminal 2 — interface branchée sur l'API**

Windows : `cd frontend`, `npm install`, puis `$env:VITE_API_MODE="http"; npm run dev`

macOS / Linux :
```bash
cd frontend
npm install
VITE_API_MODE=http npm run dev
```
Ouvrir http://localhost:5173. La base est vide : n'importe quel matricule à 6 chiffres, puis nom et prénom à la
première connexion.

### 4. Tests automatiques

```bash
cd frontend && npm test          # tests de l'interface
cd ../backend
.venv/bin/pytest -q              # tests de l'API (Windows : .venv\Scripts\pytest -q)
```

### Avec Docker (optionnel)

`docker compose up --build`, puis http://localhost:8081 (PostgreSQL + API + interface).

### À savoir

- Les variables d'environnement (`export …` / `$env:…`) ne valent que pour le terminal courant : les redéfinir
  si on le rouvre.
- En local, BigQuery est simulé : un test de requête répond toujours « 6 Go, 5 lignes » et les tableaux de
  performance sont vides. Pour le vrai BigQuery : accès GCP et `RM_BIGQUERY_MODE=real`.
- Le panneau « Simulation Airflow » (premiers runs d'une version publiée, arrêt du DAG) n'existe qu'en mode démo (3a).

### Dépannage : « npm is not recognized » (Windows)

Windows ne trouve pas Node.js : il n'est pas installé, ou le terminal a été ouvert avant son installation.

1. **Fermer et rouvrir le terminal** (toutes les fenêtres PowerShell, et VS Code si on utilise son terminal),
   puis vérifier avec `node -v` et `npm -v`.
2. **Installer Node.js** : `winget install OpenJS.NodeJS.LTS`, ou, si `winget` est inconnu, l'installateur **LTS**
   de https://nodejs.org (options par défaut, « Add to PATH » cochée). Rouvrir le terminal.
3. **Node installé mais npm introuvable** : le dossier n'est pas dans le PATH.
   ```powershell
   Test-Path "C:\Program Files\nodejs\npm.cmd"
   ```
   Si `True`, l'ajouter au PATH du compte puis rouvrir le terminal :
   ```powershell
   [Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";C:\Program Files\nodejs", "User")
   ```
   Si `False`, relancer l'installateur.
4. **« L'exécution de scripts est désactivée sur ce système »** : autoriser les scripts pour son compte,
   ou utiliser l'Invite de commandes (`cmd`) à la place de PowerShell.
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
   ```

**PC d'entreprise sans droits administrateur** : prendre la version **.zip** sur
https://nodejs.org/en/download, la décompresser (par ex. dans `C:\Users\<vous>\node`) et ajouter ce dossier au
PATH avec la commande du point 3. Si le poste bloque aussi cela, demander l'installation au service informatique ;
en attendant, l'API se teste seule via http://localhost:8000/docs.

### Créer les tables BigQuery (mode `real`, une seule fois)

Prérequis : Google Cloud SDK (`bq`) et `gcloud auth login`. Le script lit le projet, le dataset, la région et la
table du prestataire dans `backend/.env` ; un paramètre ou une variable d'environnement les remplace.
```ini
RM_GCP_PROJECT=mon-projet
RM_BQ_DATASET=fraud_rules
RM_BQ_LOCATION=europe-west9                    # valeur par défaut
RM_BQ_FEEDBACK_TABLE=prestataire.feedback      # dataset.table, ou projet.dataset.table (vue v_rule_performance)
```

macOS / Linux / WSL (nécessite aussi `envsubst` : `sudo apt install -y gettext-base`) :
```bash
infra/bigquery/apply.sh
# ou, pour remplacer une valeur : PROJECT=autre-projet infra/bigquery/apply.sh
```

Windows (PowerShell) :
```powershell
powershell -ExecutionPolicy Bypass -File infra\bigquery\apply.ps1
# ou : ... apply.ps1 -Project autre-projet -FeedbackTable prestataire.feedback
```
`-ExecutionPolicy Bypass` évite le blocage des scripts téléchargés (archive .zip). Le script peut être rejoué.

### Commandes du Makefile (macOS / Linux ; sous Windows : `run.cmd`)

| Besoin | Commande |
|---|---|
| Tout installer | `make install` |
| Interface en mode démo | `make dev-front` |
| API locale (avec PostgreSQL : `make up-db`) | `make dev-api` |
| Interface branchée sur l'API | `make dev-front-http` |
| Tests / lint | `make test` · `make lint` |

### Configuration de l'API (variables `RM_*`, voir `backend/.env.example`)

| Variable | Rôle | Défaut |
|---|---|---|
| `RM_DATABASE_URL` | base applicative | PostgreSQL local |
| `RM_BIGQUERY_MODE` | `fake` (sans GCP) ou `real` | `fake` |
| `RM_GCP_PROJECT`, `RM_BQ_DATASET`, `RM_BQ_LOCATION` | projet, dataset et région du contrat de données | — / `fraud_rules` / `europe-west9` |
| `RM_BQ_FEEDBACK_TABLE` | table de retour du prestataire (`dataset.table` ou `projet.dataset.table`), pour créer la vue des indicateurs | — |
| `RM_MAX_BYTES_BILLED`, `RM_JOB_TIMEOUT_MS`, `RM_MAX_RESULTS` | garde-fous des tests (F3) | 50 Go, 60 s, 100 |
| `RM_NOTIFY_WEBHOOK_URL` | notification facultative de l'équipe data (publication, décisions), pour information | vide = log (Q6) |

## Architecture (PRD §8)

```
navigateur ──► front (Nginx, Cloud Run) ──/api──► API FastAPI (Cloud Run) ──► Cloud SQL (état applicatif)
                                                           │
                                                           └──► BigQuery : dry-run / tests, rules_registry,
                                                                v_rule_performance, rule_runs  ◄── Airflow
```

- Le front ne détient aucun credential BigQuery ; il ne parle qu'à l'API, sur la même origine (cookie de session first-party).
- Les garde-fous de test (`maximumBytesBilled`, `jobTimeoutMs`, `maxResults`) sont appliqués par l'API.
- Les lignes renvoyées par un test ne sont jamais persistées ni journalisées : seules les métadonnées le sont.
- L'identité (matricule) est résolue en un seul point, `get_current_user` dans `backend/app/auth.py` ; le front la relit toujours via `/me`.
  Passer au SSO (PRD §5.4) revient à réécrire `get_current_user`.

## Décisions prises dans ce squelette — à valider

- **Q1, base applicative** : PostgreSQL (recommandation du PRD §8.3). L'exposition à l'équipe data se fait par
  `rules_registry` dans BigQuery, alimentée à l'écriture (`upsert_rule` dans `backend/app/bigquery.py`, mode `real`).
  **Une ligne par règle**, mise à jour à chaque publication (MERGE sur `rule_id`) : l'historique des versions vit
  dans `rule_versions`, côté plateforme. Si vous choisissez
  une vue fédérée `EXTERNAL_QUERY`, cette synchronisation devient inutile.
- **Cycle de vie (écart au PRD F5 et §4.2)** : **pas d'étape de validation**. L'analyste publie lui-même sa
  règle, qui part en observation ; l'équipe data n'agit pas sur la plateforme et n'exploite que les DAG. Les gestes
  de l'analyste sont stockés (brouillon, publication, décision d'envoi) ; l'exécution se **déduit des runs Airflow**
  dans `rule_runs` :
  - *Publiée* : écrite dans `rules_registry`, pas encore exécutée (elle le sera au prochain run du DAG de sa
    fréquence) ;
  - *En observation* : Airflow l'exécute et écrit ses commandes dans `rule_alerts`, **sans les envoyer au
    prestataire** (`send_to_provider = false`). On mesure son volume et son recoupement avec les autres règles ;
    la précision n'est pas représentative, le prestataire ne traitant que les commandes aussi remontées par une
    règle envoyée. L'observation n'a pas d'échéance ;
  - *En production* : l'analyste a cliqué « Envoyer au prestataire » ; `send_to_provider` passe à vrai et le DAG
    transmet ses commandes dès le run suivant. « Suspendre l'envoi » la ramène en observation ;
  - *Écartée* : l'analyste a décidé de ne pas l'envoyer ; elle sort de `rules_registry` et la version
    précédente reprend sa place (avec son envoi, si elle était envoyée) ;
  - *Inactive depuis X* : plus de run depuis 3 périodes (3 h, 3 jours ou 3 semaines selon la fréquence) ;
  - *Remplacée* : une version plus récente a été publiée ou tourne à sa place.

  Une nouvelle version d'une règle envoyée la **remplace en observation** : l'envoi au prestataire est
  suspendu jusqu'à la décision sur la nouvelle version. Les décisions sont tracées dans le journal d'audit
  (`RULE_SEND_TO_PROVIDER`, `RULE_SUSPEND_SENDING`, `RULE_DISCARD`) et peuvent être notifiées à l'équipe data pour information. Une table
  `rules_registry` existante reçoit la colonne par `infra/bigquery/07_rules_registry_send.sql`.

  **Brouillons personnels** : un brouillon est la sauvegarde de travail d'un analyste, stocké comme son profil
  dans la base de la plateforme (table `drafts`, rattachée à son matricule) et **visible de lui seul** : ni les
  collègues, ni le journal d'audit (un test de brouillon y est tracé sans nommer la règle), ni BigQuery ne le
  voient. La table `rule_versions` ne contient que des versions publiées, et une règle n'entre dans le
  référentiel partagé qu'à sa première publication. Chacun peut préparer sa propre nouvelle version d'une règle
  (un brouillon par règle et par personne) ; la première publiée prend le numéro suivant, l'éditeur des autres
  signale le décalage. La saisie non encore enregistrée est en plus gardée dans le navigateur.

  Une version **publiée mais jamais exécutée** peut être reprise par celui qui l'a publiée : elle sort de
  `rule_versions`, la ligne de `rules_registry` revient à la version précédente (ou est supprimée s'il n'y en
  a pas), elle redevient son brouillon, puis elle doit être retestée et republiée (même numéro). Dès qu'une version a
  tourné, elle est figée : toute modification passe par un brouillon de nouvelle version.

  **Contrat côté Airflow, à valider avec l'équipe data** : **un DAG par fréquence** (`fraud_rules_hourly`,
  `fraud_rules_daily`, `fraud_rules_weekly`). À chaque exécution, il lit dans `rules_registry` les règles de sa
  fréquence (une ligne par règle : sa dernière version non écartée) et lance une tâche par règle (mappage
  dynamique d'Airflow) : une règle en échec ne bloque pas les autres et se relance seule. La requête est
  exécutée telle quelle, sans être recopiée. Le DAG écrit dans `rule_runs` la version exécutée et son
  `airflow_dag_id` : c'est ce qui permet à la plateforme d'afficher quelle version tourne. Une règle publiée,
  nouvelle ou nouvelle version, tourne donc **dès le run suivant, sans aucune action de l'équipe data** ; une
  règle qui change de fréquence change simplement de DAG. Les brouillons ne sont jamais exécutés. DAG de
  référence à adapter : `infra/airflow/fraud_rules_dags.py` (l'envoi au prestataire y reste à implémenter). Toutes les versions restent conservées dans la plateforme : comparatif
  SQL, comparaison des performances par version (repères sur les courbes, tableau par version) et
  **restauration** d'une version antérieure, recopiée dans un brouillon à tester puis soumettre.

  **Dédoublonnage : une fois par version pour le suivi, une fois par règle pour l'envoi.** Le DAG n'écrit dans
  `rule_alerts` que les commandes que *cette version* n'a jamais remontées : une requête peut relire les mêmes
  jours (fenêtre glissante, règle horaire sur la veille) sans doublon, une fenêtre un peu plus large que la
  fréquence rattrape d'elle-même un run manqué, et chaque version est mesurée sur tout ce qu'elle trouve (une
  v2 n'est pas amputée de ce que la v1 avait déjà remonté, sinon le comparatif serait faussé). Au prestataire,
  en revanche, le DAG ne transmet que ce que *la règle*, toutes versions confondues, ne lui a jamais transmis
  (colonne `rule_alerts.sent_to_provider`) : passer à la v2 ne renvoie pas les commandes de la v1.

  **Relance d'un run passé (« voyage dans le temps »)** : un run relancé après coup depuis Airflow (Clear d'un
  run ancien) est replacé à son heure d'origine (`data_interval_end`). `CURRENT_DATE()`, `CURRENT_DATETIME()`
  et `CURRENT_TIMESTAMP()` y renvoient la date du run (fuseau conservé :
  `CURRENT_DATE('Europe/Paris')` → `DATE(TIMESTAMP '…', 'Europe/Paris')`), et chaque table est lue dans son état
  d'alors (`FOR SYSTEM_TIME AS OF`), comme `rules_registry`, pour rejouer la version qui était en place. La
  requête de l'analyste n'est modifiée qu'à ces endroits (module `infra/airflow/fraud_rules_sql.py`, analysé par
  sqlglot, à installer dans l'environnement Airflow : une chaîne ou un commentaire n'est jamais touché ;
  tests : `pytest infra/airflow`). Limites de
  BigQuery : 7 jours au plus et vraies tables seulement. Au-delà, ou pour une vue / une table externe, la
  lecture se fait au présent et `rule_runs.note` le signale ; `rule_runs.replayed_as_of` marque les relances.

  **Âge maximal et rattrapage** : une version ne remonte pas de commande passée plus de 7 jours
  (`fraud_rules_max_age_days`) avant sa mise en route, c'est-à-dire son premier run. Une requête sans fenêtre de
  dates ne déverse donc pas tout l'historique dans `rule_alerts` ni chez le prestataire. Les commandes
  antérieures à la dernière période avant la mise en route (la veille pour une règle quotidienne, l'heure
  précédente pour une règle horaire) sont marquées `backfill` : elles restent envoyables, mais la vue
  `v_rule_performance` les écarte, une version n'étant mesurée que sur ce qui s'est passé pendant qu'elle tournait.
  Ces deux garde-fous lisent la date de chaque commande dans la table des commandes, à déclarer dans les
  Variables Airflow `fraud_rules_orders_table`, `fraud_rules_orders_id_column` (`order_id`),
  `fraud_rules_orders_date_column` (`created_at`, de type DATE, DATETIME ou TIMESTAMP) et
  `fraud_rules_orders_timezone` (`Europe/Paris`). Sans `fraud_rules_orders_table`, ils sont désactivés.
  Des tables `rule_runs` / `rule_alerts` existantes reçoivent les nouvelles colonnes par
  `infra/bigquery/03_rule_upgrade_suivi.sql`.

  Pour chaque commande remontée, le DAG écrit une ligne dans `rule_alerts`. Chaque règle renvoie ses
  propres colonnes ; seule `order_id` est obligatoire (vérifiée à la publication) et sert aux indicateurs.
  Le reste de la ligne va dans la colonne **`details`** (JSON, facultative), pour que l'équipe qui traite
  les alertes sache pourquoi la commande a été remontée. Exemple d'écriture en une requête :
  ```sql
  INSERT INTO `projet.fraud_rules.rule_alerts`
    (rule_id, rule_version, run_id, run_date, order_id, detected_at, details)
  SELECT @rule_id, @rule_version, @run_id, CURRENT_DATE(),
         CAST(t.order_id AS STRING), CURRENT_TIMESTAMP(),
         TO_JSON(t)                 -- toute la ligne de résultat (order_id compris)
  FROM (
    /* sql_query lue dans rules_registry, exécutée telle quelle */
  ) AS t
  ```
  Une table `rule_alerts` créée avant l'ajout de `details` est mise à jour par
  `infra/bigquery/06_rule_alerts_details.sql` (rejoué sans risque par `apply.sh` / `apply.ps1`).

  Les statuts « Validée » et « Refusée » disparaissent : un refus passe hors plateforme et l'analyste soumet
  une nouvelle version (risque R3 : le motif n'est pas tracé). L'état des runs est recopié par
  `POST /internal/sync-runs`, à appeler périodiquement (Cloud Scheduler, toutes les heures par exemple).
- **Contraintes SQL** : seul le DML/DDL bloque l'enregistrement d'un brouillon. Pour tester, il faut une requête
  valide pour BigQuery exposant `order_id` ; publier exige un test réussi. Les dates en
  dur ne sont qu'une alerte : légitimes comme seuil fixe (`created_at >= '2024-01-01'`), à éviter comme jour
  traité (`order_date = '2026-10-27'` relirait ce jour à chaque exécution).
- **Paramètres (écart au PRD F2)** : aucun. La requête s'exécute telle quelle, au test comme en production :
  les seuils s'écrivent en dur dans le SQL (`amount_eur >= 500`), leur évolution se lit dans le comparatif
  entre versions, et les dates sont relatives au jour d'exécution (`CURRENT_DATE()`). Tout `@paramètre` est
  refusé. `rules_registry` n'a donc pas de colonne `parameters`. Rejouer un jour passé ne demande pas de
  réécrire la requête : le DAG la replace à l'heure du run (voir « Relance d'un run passé »).
- **Identité** : `owner_matricule` remplace `owner_email` dans `rules_registry`.
- **Résultat d'un test** : nombre de commandes remontées (distinctes), et combien sont déjà remontées par une
  autre règle (table `rule_alerts`, 90 derniers jours, réglable par `RM_OVERLAP_DAYS`).
  Le recoupement relit le résultat du test (table temporaire du job BigQuery) : la requête n'est pas rejouée.
  Les versions de la même règle ne sont pas comptées. Si `rule_alerts` est illisible, seul le total s'affiche.
- **Période d'un test** : la requête s'exécute le jour même. Le modèle de départ vise la veille, dernière journée
  complète : `order_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)`. La période couverte dépend de la
  requête (ex. `BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 8 DAY) AND DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)`).
- **Règles horaires** : la fenêtre s'écrit avec `CURRENT_TIMESTAMP()` (ex. dernière heure écoulée).
- **Déploiement** : API en ingress interne sans IAM entre front et API (le contrôle d'accès est réseau, PRD F8).
  La topologie exacte (load balancer interne, routage `/api`) reste à arbitrer.
- **Valeurs provisoires** : typologies de fraude (Q4, `frontend/src/lib/format.ts`),
  colonnes de la table de feedback (Q2, `infra/bigquery/04_v_rule_performance.sql`).
