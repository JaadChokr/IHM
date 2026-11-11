# Fraud Rules

Plateforme de gestion des règles de détection de fraude : l'équipe fraude **crée, teste et suit** ses règles
sans passer par le mail, et mesure leur efficacité grâce au retour du prestataire (PRD v0.1).

## Structure

```
.
├── frontend/            React + TypeScript + Vite — l'IHM (Nginx non-root en production)
│   ├── src/api/         contrat d'API (client.ts, types.ts) + implémentation mock pour la démo
│   ├── src/pages/       écrans (liste, éditeur, détail, vue production, audit, profil)
│   ├── src/styles/      style centralisé : tokens.css (valeurs) + ui.css (classes communes), voir frontend/STYLE.md
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
│   ├── bigquery/        contrat de données §7 : rules_registry, rule_runs, rule_alerts (+ details), rule_sends, v_rule_performance, v_rule_orders
│   ├── prestataire/     requêtes de référence du script d'envoi au prestataire (journal rule_sends)
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
.\run.cmd -BigQuery  # met d'abord à jour les tables et vues BigQuery (infra\bigquery\apply.ps1), puis démarre
```
Sans `-BigQuery`, le script ne touche jamais à BigQuery (tables partagées avec Airflow). Avec, il lit le
projet, le dataset et la table du prestataire dans `backend\.env`, demande l'outil `bq` connecté
(`gcloud auth login`) et s'arrête si la mise à jour échoue. Les options se combinent
(`.\run.cmd -Install -BigQuery`), sauf avec `-Demo`.
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
                                                                v_rule_performance, v_rule_orders,
                                                                rule_runs  ◄── Airflow
```

- Le front ne détient aucun credential BigQuery ; il ne parle qu'à l'API, sur la même origine (cookie de session first-party).
- Les garde-fous de test (`maximumBytesBilled`, `jobTimeoutMs`, `maxResults`) sont appliqués par l'API.
- Les lignes renvoyées par un test ne sont jamais persistées ni journalisées : seules les métadonnées le sont.
- L'identité (matricule) est résolue en un seul point, `get_current_user` dans `backend/app/auth.py` ; le front la relit toujours via `/me`.
  Passer au SSO (PRD §5.4) revient à réécrire `get_current_user`.

## Décisions prises dans ce squelette — à valider

- **Q1, base applicative** : PostgreSQL (recommandation du PRD §8.3). L'exposition à l'équipe data se fait par
  `rules_registry` dans BigQuery, alimentée à l'écriture (`set_registry` dans `backend/app/bigquery.py`, mode `real`).
  **Une ligne par version qu'Airflow exécute** (clé `rule_id, version`, MERGE à chaque publication et décision) :
  au plus deux par règle, la version en production et une candidate. L'historique des versions vit dans
  `rule_versions`, côté plateforme, qui porte toute la logique des versions ; le DAG ne fait qu'exécuter les lignes. Si vous choisissez
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
  - *En production* : l'analyste a cliqué « Envoyer au prestataire » ; `send_to_provider` passe à vrai, et dès
    le run suivant le DAG marque ses commandes à transmettre (`to_send`) pour le script d'envoi. « Suspendre l'envoi » la ramène en observation ;
  - *Écartée* : l'analyste a décidé de ne pas l'envoyer ; elle sort de `rules_registry` et la version
    précédente reprend sa place (avec son envoi, si elle était envoyée) ;
  - *Inactive depuis X* : plus de run réussi depuis 3 périodes (3 h, 3 jours ou 3 semaines pour une règle à chaque unité ;
    6 jours pour une règle tous les 2 jours) ;
  - *Remplacée* : une version plus récente a été publiée ou tourne à sa place.

  **Version candidate** : une nouvelle version d'une règle **en production ne la remplace pas**. Elle tourne
  à côté comme *candidate*, en observation, sans envoi, pendant que la version en production continue de
  tourner et d'être envoyée. Les deux sont ainsi comparées sur les mêmes périodes et les mêmes commandes. Après
  au moins un run de la candidate, l'analyste choisit :
  - « **Mettre en production** » : en un geste, la candidate prend la place de la version en production, qui
    s'arrête au run suivant (pas de doublon chez le prestataire, pas de trou) ;
  - « **Écarter** » : la candidate s'arrête, la version en production continue ;
  - « Suspendre l'envoi » de la version en production : la candidate tourne alors seule, en observation.

  Une règle sans version en production (encore en observation) n'a pas de candidate : une nouvelle version
  remplace simplement la précédente, puisque rien n'est envoyé. Les décisions sont tracées dans le journal d'audit
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

  **Contrat côté Airflow, à valider avec l'équipe data** : **un DAG par fréquence** (`FRAUD_RULES_HOURLY`,
  `FRAUD_RULES_DAILY`, `FRAUD_RULES_WEEKLY`). À chaque exécution, il lit dans `rules_registry` les règles de sa
  fréquence (une ligne par version à exécuter : la version en production et une éventuelle candidate) et lance
  une tâche par ligne (mappage dynamique d'Airflow) : une règle en échec ne bloque pas les autres et se relance
  seule (2 nouvelles tentatives). L'identifiant de run d'une tâche contient la version, puisqu'une règle peut
  tourner en deux versions dans le même run. Un seul run à la fois par DAG (`max_active_runs=1`) : deux runs
  simultanés d'une même règle, lors d'un rattrapage, passeraient tous deux le dédoublonnage avant que l'autre
  ait écrit. La requête est exécutée telle quelle, sans être recopiée, avec pour seuls paramètres les bornes
  de la période du run (voir « Période du run »). Le DAG écrit dans `rule_runs` la version exécutée et son
  `airflow_dag_id` : c'est ce qui permet à la plateforme d'afficher quelle version tourne. Une règle publiée,
  nouvelle ou nouvelle version, tourne donc **dès le run suivant, sans aucune action de l'équipe data** ; une
  règle qui change de fréquence change simplement de DAG. Les brouillons ne sont jamais exécutés. DAG de
  référence à adapter : `infra/airflow/fraud_rules_dags.py` (l'envoi au prestataire n'y figure pas : il est
  fait par un script externe, voir « Envoi au prestataire »). Toutes les versions restent conservées dans la plateforme : comparatif
  SQL, comparaison des performances par version (repères sur le graphique de l'onglet Performance, tableau de
  comparaison dans l'onglet Versions) et
  **restauration** d'une version antérieure, recopiée dans un brouillon à tester puis soumettre.

  **Dédoublonnage : une fois par version pour le suivi, une fois par règle pour l'envoi.** Le DAG n'écrit dans
  `rule_alerts` que les commandes que *cette version* n'a jamais remontées : une requête peut relire les mêmes
  jours (fenêtre glissante, règle horaire sur la veille) sans doublon, une fenêtre un peu plus large que la
  fréquence rattrape d'elle-même un run manqué, et chaque version est mesurée sur tout ce qu'elle trouve (une
  v2 n'est pas amputée de ce que la v1 avait déjà remonté, sinon le comparatif serait faussé). Le DAG ne fait
  aucun autre dédoublonnage : le prestataire est protégé par le script d'envoi, et les chiffres d'une règle
  comptent les commandes distinctes.

  **Envoi au prestataire** : le DAG n'envoie rien. Au moment du run, il marque chaque commande écrite dans
  `rule_alerts` avec `to_send` (« à transmettre »), recopie de `send_to_provider` de la ligne de
  `rules_registry` : vrai si la version est en production à ce run. La décision est figée au moment du run :
  passer en production n'envoie pas le stock remonté en observation, et suspendre l'envoi ne bloque pas ce qui
  était déjà marqué. Une commande remontée par la v1 puis par la v2 est marquée par les deux ; elle ne part
  qu'une fois.

  Le **script d'envoi externe** tient son propre **journal des envois**, `rule_sends` (une ligne par commande
  transmise, `infra/bigquery/09_rule_sends.sql`). À chaque passage, il :
  1. lit les commandes `to_send` absentes du journal, une ligne par commande, toutes règles et versions
     confondues ;
  2. les transmet au prestataire ;
  3. les inscrit au journal (ajout seulement).

  Requêtes de référence : `infra/prestataire/requetes_envoi.sql`. Le script ne modifie jamais `rule_alerts` et le
  DAG n'écrit jamais dans `rule_sends` : les deux ne se gênent pas, même quand ils tournent en même temps (pas
  de conflit d'écriture BigQuery). Une nouvelle tentative du DAG efface et réécrit les lignes de son run, sauf les
  commandes inscrites au journal ; une commande réécrite ne repart pas, puisqu'elle est déjà au journal. Seul cas
  de double envoi restant : envoi réussi puis échec de l'inscription au journal ; le prestataire doit donc ignorer
  une commande déjà reçue (clé `order_id`). Le script ne doit pas tourner deux fois en parallèle.

  `rule_runs.rows_to_send` donne, par run, le nombre de commandes marquées. Des tables existantes reçoivent
  `to_send` et `rows_to_send` par `infra/bigquery/03_rule_upgrade_suivi.sql`. L'ancienne colonne
  `rule_alerts.sent_at` n'est plus écrite : `09_rule_sends.sql` reprend son historique dans le journal (les
  commandes déjà parties ne repartent pas), puis elle peut être supprimée. Les colonnes `sent_to_provider` et
  `rows_sent`, plus anciennes, ne sont plus écrites non plus (le script indique comment les supprimer).

  **Deux vues d'indicateurs** :
  - `v_rule_performance` (une ligne par règle, version et jour) sert au **comparatif des versions** : chaque
    version y garde toutes ses commandes, candidate comprise, y compris celles déjà remontées par une autre
    version ;
  - `v_rule_orders` (une ligne par commande et par version, avec le retour du prestataire) sert aux **chiffres
    de la règle** : graphique et indicateurs de la page règle, totaux sur 30 jours. Ils dépendent de l'état de la
    règle : **en production**, ses commandes à transmettre (`to_send`), c'est-à-dire celles de la version en
    production ; **en observation**, ses autres commandes. La plateforme compte les commandes **distinctes** :
    une commande remontée par deux versions n'est comptée qu'une fois. Une candidate n'entre donc jamais dans
    les chiffres d'une règle en production ; pour une version précise, candidate comprise, on lit le
    comparatif des versions.

  **Onglet « Exécutions » de la page règle** : l'historique des exécutions automatiques sur 90 jours
  (`GET /rules/{id}/runs`, lu dans `rule_runs`), une ligne par exécution avec sa période, sa version, sa durée,
  les commandes remontées et envoyées et son résultat. Une exécution retentée apparaît une seule fois, avec
  son nombre de tentatives ; le détail technique d'un échec est en infobulle, à transmettre à l'équipe data.
  Il remplace l'ancien onglet « Tests » (l'historique des vérifications faites avant publication) et la
  section « Dernières exécutions » de l'onglet Performance.

  **Graphique de la page règle** : un histogramme journalier sur une seule échelle, en nombre de commandes.
  Une barre **par version** et par jour : la barre entière donne les commandes **remontées** (teinte claire,
  **hachurée** quand la version est en observation : avant sa mise en production, ou candidate à côté de la
  version en production) ; superposée en bas, en couleur franche, la part **confirmée frauduleuse** par le
  prestataire. On voit ainsi, barre par barre, combien de remontées sont de vraies fraudes ; la précision du jour
  (confirmées ÷ vérifiées) s'affiche au survol. L'analyste affiche les remontées, les fraudes confirmées ou les
  deux. Une candidate et la version en production se comparent côte à côte sur les mêmes jours. Les fraudes
  confirmées ne sont comptées qu'en production : en observation, le prestataire ne traite que les commandes aussi remontées
  par une règle envoyée. L'indicateur de volume donne les deux totaux de la période, en commandes distinctes :
  envoyées au prestataire, et remontées en observation (ils ne s'additionnent pas, une commande pouvant être
  remontée par la version en production et par la candidate).

  Les chiffres du comparatif ne s'additionnent donc pas pour donner ceux de la règle ; une ligne
  d'explication l'indique sous le tableau. Les deux vues sont créées par `apply.sh` / `apply.ps1`
  (`04_v_rule_performance.sql`, `05_v_rule_orders.sql`, qui supprime l'ancienne `v_rule_orders_daily`).

  **Fréquence : une unité et un pas.** L'analyste choisit « toutes les heures », « toutes les 2 heures », « tous
  les 3 jours », « toutes les 2 semaines »… : une unité (`rules_registry.schedule`, le DAG qui l'exécute) et un
  pas (`schedule_every`). Pas autorisés : 1, 2, 3, 4, 6, 8 ou 12 heures (diviseurs de 24, pour des heures
  d'exécution identiques chaque jour), 1 à 30 jours, 1 à 12 semaines. Chaque DAG se déclenche à chaque unité
  et n'exécute une règle que lorsqu'elle est due, avec un calage fixe : les heures sont comptées depuis minuit
  (toutes les 6 h = 0 h 05, 6 h 05, 12 h 05, 18 h 05), les jours et les semaines depuis le lundi 5 janvier 2026
  (tous les 2 jours = un jour sur deux à 3 h). L'éditeur affiche les heures d'exécution et la prochaine ; la
  fiche d'une règle publiée qui n'a pas encore tourné aussi. Des tables existantes reçoivent la colonne par
  `infra/bigquery/08_rules_registry_every.sql` (pas de 1 pour les règles existantes).

  **Période du run (`@period_start` / `@period_end`)** : le DAG passe à la requête les bornes `[début, fin[`
  (TIMESTAMP) qui vont du déclenchement dû précédent de la règle à celui-ci, en heure de Paris : 1 h pour une
  règle horaire (de h+5 à h+5), **de 3 h à 3 h** pour une quotidienne, du lundi 4 h au lundi 4 h pour une
  hebdomadaire, 6 h pour une règle toutes les 6 h, 2 jours pour une règle tous les 2 jours. Aux changements
  d'heure, la période suit les déclenchements réels : ni trou ni chevauchement. Exemples :
  - période exacte : `created_at >= @period_start AND created_at < @period_end` ;
  - la veille, jour calendaire : `DATE(created_at, 'Europe/Paris') = DATE_SUB(DATE(@period_end, 'Europe/Paris'), INTERVAL 1 DAY)` ;
  - fenêtre glissante de 7 jours : `created_at >= TIMESTAMP_SUB(@period_end, INTERVAL 7 DAY) AND created_at < @period_end`.

  Un rattrapage (`catchup=True` : périodes manquées pendant un déploiement ou une panne) ou une relance d'un run
  passé (Clear dans Airflow) repasse les bornes de la période d'origine : une requête qui les utilise porte sur
  la bonne période sans être réécrite. Ces paramètres sont **facultatifs** : l'analyste peut aussi écrire ses
  dates avec `CURRENT_DATE()`, `CURRENT_DATETIME()` ou `CURRENT_TIMESTAMP()`, sans contrainte. Ces fonctions
  donnent la date réelle d'exécution : juste au run normal, mais un rattrapage ou une relance lit alors la
  période du jour de la relance, pas celle d'origine (sans doublon, grâce au dédoublonnage par version).

  **Relance et rattrapage** : la requête est exécutée telle quelle, tables lues au présent. Avec une plage
  `@period_start` / `@period_end`, elle porte sur la période d'origine : résultat exact. Sans plage, elle relit
  toute la table : rien n'est perdu ni doublé (dédoublonnage par règle et par version), mais les commandes
  passées depuis sont rattachées au run rejoué, ce qui décale légèrement le graphique. L'analyste reste libre
  d'écrire sa requête sans plage ; l'éditeur l'incite à en poser une (alerte `NO_DATE_WINDOW`), ce qui évite
  aussi de relire à chaque run un volume inutilement grand. Il peut aussi dater lui-même une table
  (`FROM t FOR SYSTEM_TIME AS OF @period_end`) ; BigQuery ne le permet que sur 7 jours, et au-delà la tâche
  échoue (erreur BigQuery). Le DAG lit `rules_registry` au présent : un rattrapage exécute les versions
  actuelles.

  `rule_runs` garde la période de chaque run (`period_start`, `period_end`) ; des tables existantes
  reçoivent les nouvelles colonnes par
  `infra/bigquery/03_rule_upgrade_suivi.sql`. Les crons sont à garder alignés entre le DAG et
  `backend/app/periods.py`, qui calcule la période testée dans l'IHM.

  **Premier run d'une version** : le dédoublonnage ne joue qu'à partir du deuxième run. Une requête sans
  plage de dates remonte donc, à son premier run, toutes les commandes qu'elle lit ;
  le comparatif des versions montre un pic ce jour-là. Rien n'est envoyé pour autant : toute version commence
  en observation, et seules les commandes des runs faits après la décision sont marquées à transmettre. L'éditeur
  l'annonce par une alerte (`NO_DATE_WINDOW`) quand la requête n'a aucune fenêtre de dates (ni
  `CURRENT_DATE()` et consorts, ni `@period_start` / `@period_end`).

  Pour chaque commande remontée, le DAG écrit une ligne dans `rule_alerts`. Chaque règle renvoie ses
  propres colonnes ; seule `order_id` est obligatoire (vérifiée à la publication) et sert aux indicateurs.
  Le reste de la ligne va dans la colonne **`details`** (JSON, facultative), pour que l'équipe qui traite
  les alertes sache pourquoi la commande a été remontée. Exemple d'écriture en une requête :
  ```sql
  INSERT INTO `projet.fraud_rules.rule_alerts`
    (rule_id, rule_version, run_id, run_date, order_id, detected_at, details)
  SELECT @rule_id, @rule_version, @run_id, @run_date,
         CAST(t.order_id AS STRING), CURRENT_TIMESTAMP(),
         TO_JSON(t)                 -- toute la ligne de résultat (order_id compris)
  FROM (
    /* sql_query lue dans rules_registry, exécutée telle quelle avec @period_start / @period_end */
  ) AS t
  ```
  Une table `rule_alerts` créée avant l'ajout de `details` est mise à jour par
  `infra/bigquery/06_rule_alerts_details.sql` (rejoué sans risque par `apply.sh` / `apply.ps1`).

  Les statuts « Validée » et « Refusée » disparaissent : un refus passe hors plateforme et l'analyste soumet
  une nouvelle version (risque R3 : le motif n'est pas tracé). L'état des runs est recopié par
  `POST /internal/sync-runs`, à appeler périodiquement (Cloud Scheduler, toutes les heures par exemple).
  Seuls les runs réussis comptent : une version dont le premier run a échoué reste « Publiée », et une
  version qui échoue à chaque run devient « Inactive » après 3 périodes.

  **Clés des tables BigQuery** : BigQuery n'applique aucune clé unique. Chaque table déclare sa clé logique
  (`PRIMARY KEY … NOT ENFORCED`), qui documente l'unicité attendue et aide l'optimiseur : `rules_registry`
  (`rule_id`), `rule_alerts` (`rule_id, rule_version, order_id`, garantie par le dédoublonnage du DAG) et
  `rule_runs` (`run_id, started_at` : **une ligne par tentative**, la dernière donnant l'état du run). Des
  tables existantes les reçoivent par `infra/bigquery/03_rule_upgrade_suivi.sql`.
- **Contraintes SQL** : seul le DML/DDL bloque l'enregistrement d'un brouillon. Pour tester, il faut une requête
  valide pour BigQuery exposant `order_id` ; publier exige un test réussi. Les dates en
  dur ne sont qu'une alerte : légitimes comme seuil fixe (`created_at >= '2024-01-01'`), à éviter comme jour
  traité (`order_date = '2026-10-27'` relirait ce jour à chaque exécution). L'absence de fenêtre de dates
  (ni `CURRENT_DATE()` et consorts, ni `@period_start` / `@period_end`) est aussi une simple alerte.
- **Paramètres (écart au PRD F2)** : seulement `@period_start` et `@period_end`, facultatifs, bornes de la
  période du run, fournies par Airflow et, au test, par la plateforme ; l'analyste ne les saisit jamais. Les seuils s'écrivent
  en dur dans le SQL (`amount_eur >= 500`) et leur évolution se lit dans le comparatif entre versions ; tout
  autre `@paramètre` est refusé. `rules_registry` n'a donc pas de colonne `parameters`.
- **Identité** : `owner_matricule` remplace `owner_email` dans `rules_registry`.
- **Résultat d'un test** : nombre de commandes remontées (distinctes), et combien sont déjà remontées par une
  autre règle (table `rule_alerts`, 90 derniers jours, réglable par `RM_OVERLAP_DAYS`).
  Le recoupement relit le résultat du test (table temporaire du job BigQuery) : la requête n'est pas rejouée.
  Les versions de la même règle ne sont pas comptées. Si `rule_alerts` est illisible, seul le total s'affiche.
- **Période d'un test** : `@period_start` / `@period_end` prennent la **dernière période complète** du DAG de
  la fréquence choisie dans l'éditeur, pas compris (quotidienne testée un mercredi à 10 h : du mardi 3 h au
  mercredi 3 h ; horaire à 14 h 02 : de 12 h 05 à 13 h 05 ; toutes les 2 h à 14 h 02 : de 10 h 05 à 12 h 05). La requête testée voit donc ce qu'a vu le dernier run. La
  période est affichée sous l'éditeur et dans le résultat du test. `CURRENT_DATE()` donne, au test comme en
  production, la date réelle d'exécution. Le modèle de départ vise la veille :
  `order_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)`.
- **Retour du prestataire** : on considère que le prestataire **traite toutes les commandes** qu'il reçoit ; il
  n'y a donc plus de taux de traitement. Une commande peut toutefois n'apparaître dans sa table de retour qu'un
  peu plus tard : la **précision** porte sur les **commandes vérifiées**, déjà présentes dans cette table
  (confirmées ÷ vérifiées), et les autres sont affichées **en attente de vérification** (page règle, comparatif
  des versions, page Production). Dans les vues, une commande est vérifiée dès qu'elle figure dans la table de retour
  (`f.order_id IS NOT NULL`) : seules les colonnes `order_id` et `is_fraud` de cette table sont utilisées.
- **Déploiement** : API en ingress interne sans IAM entre front et API (le contrôle d'accès est réseau, PRD F8).
  La topologie exacte (load balancer interne, routage `/api`) reste à arbitrer.
- **Valeurs provisoires** : typologies de fraude (Q4, `frontend/src/lib/format.ts`),
  colonnes de la table de feedback (Q2, `infra/bigquery/04_v_rule_performance.sql` et
  `05_v_rule_orders.sql`).
