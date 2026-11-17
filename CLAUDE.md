# Fraud Rules — repères pour Claude

Plateforme de gestion des règles de détection de fraude. Les analystes écrivent une règle (une requête SQL
BigQuery), la testent, la publient : elle tourne alors **en test** (Airflow l'exécute, rien n'est envoyé au
prestataire), puis l'analyste la met **en production** (ses commandes partent chez le prestataire, qui rend
le verdict). Détails fonctionnels et choix d'architecture : `README.md`. Règles de style du front :
`frontend/STYLE.md`.

- **Langue** : réponses, commentaires, docstrings, messages de commit et textes de l'interface en français.
  Identifiants de code en anglais.
- **Neutralité du dépôt** : jamais de vrai projet GCP, dataset, identifiant de connexion, adresse e-mail ou
  référence au dépôt Git distant dans les fichiers. Les scripts BigQuery utilisent `${PROJECT}`, `${DATASET}`,
  `${FEEDBACK_TABLE}` ; le DAG de référence garde des valeurs d'exemple.

## Arborescence

```
backend/app/        FastAPI + SQLModel, organisé par couche
  main.py           création de l'app, branchement des routers
  models.py         TOUS les modèles SQLModel (tables PostgreSQL + formats d'API), par sections
  routers/          un fichier par groupe de routes (auth, rules, drafts, query, performance, alerts, audit)
  services/         logique métier partagée (auth, rules, drafts, query, audit)
  bigquery/         contract.py (interface + verdict_of), real.py, fake.py (dev et tests)
  core/             config (variables RM_*), db, errors, clock, periods (calendrier), sql (lecture du SQL)
  openapi_export.py écrit le contrat OpenAPI pour le front
backend/migrations/ Alembic (PostgreSQL)
frontend/src/       React + TypeScript + Vite
  api/              openapi.json et schema.gen.ts (GÉNÉRÉS), types.ts (noms côté front), client.ts, mock/
  pages/, components/, lib/, styles/ (tokens.css, ui.css)
infra/bigquery/     tables/ (001-005 création, 010+ mises à niveau), views/ (01 v_rule_orders, 02 v_rule_performance)
infra/airflow/      DAG de référence (un DAG par fréquence)
infra/prestataire/  requêtes de référence du script d'envoi
```

## Commandes

```bash
make install        # npm ci + venv Python avec les dépendances de dev
make test           # front : typecheck + vitest ; back : pytest
make lint           # ruff check + ruff format --check (back)
make api-types      # après tout changement de route ou de modèle : contrat OpenAPI + types du front
make dev-front      # front en mode démo (API simulée, aucune dépendance)
make dev-api        # API locale (BigQuery factice) ; PostgreSQL requis : make up-db
cd backend && .venv/bin/alembic upgrade head && .venv/bin/alembic check   # migrations sans écart
```

Avant de terminer une tâche : `make lint`, `make test`, et si le back a changé `make api-types` puis
`alembic check`. La CI rejoue tout cela et échoue si `schema.gen.ts` n'est pas à jour.

## Contrat front ↔ back

- Les formats d'échange viennent de FastAPI : `python -m app.openapi_export` écrit
  `frontend/src/api/openapi.json`, `npm run api:types` en tire `schema.gen.ts`. Ne jamais éditer ces deux
  fichiers à la main. `tests/test_contract.py` échoue si `openapi.json` est périmé.
- `types.ts` est écrit à la main : il nomme les types générés et porte les listes de valeurs de l'interface
  (statuts, criticités, fréquences), vérifiées à la compilation contre le contrat (`ContractChecks`).
- L'API simulée (`frontend/src/api/mock/`) implémente la même interface `Api` que `client.ts` : tout
  changement d'API se reporte dans le mock. Si la forme des données simulées change, incrémenter
  `SCHEMA_VERSION` (`mock/seed.ts`) pour régénérer les données enregistrées dans le navigateur.

## Back : conventions

- Un champ commun à une table et à l'API est déclaré une fois, dans une base partagée de `models.py` dont
  héritent la table (`table=True`) et le format d'API (ex. `RuleInput` → `RuleVersion`, `Draft`,
  `RuleVersionOut`, `DraftOut`). Préciser le type de colonne quand SQLModel ne le déduit pas : `sa_type=Text`,
  `UtcDateTime` (horodatage avec fuseau), `sa_type=String(n)` pour un `Literal`, `max_length` pour une chaîne.
- Nouvelle colonne : migration `alembic revision --autogenerate`, relue, puis `alembic check` sans écart.
- **Les statuts ne sont pas stockés** dans PostgreSQL : `derive_status` (`services/rules.py`) les déduit de la
  décision de l'analyste et des exécutions Airflow (`first_run_at`, `last_run_at`). Codes : `TEST`,
  `IN_PRODUCTION`, `INACTIVE`, `REPLACED`, `DISCARDED`. Une version publiée est en test d'office ; elle ne
  peut être envoyée au prestataire qu'après une première exécution (`NOT_RUN_YET`).
- L'identité est résolue en un seul point : `get_current_user` (`services/auth.py`).
- Toute action de l'analyste est tracée par `record_audit` (`services/audit.py`).

## BigQuery : règles à respecter

- **Un seul écrivain par table** : `rules_registry` et `alert_reviews` (plateforme), `rule_runs` et
  `rule_alerts` (DAG), `rule_sends` (script d'envoi au prestataire).
- **La règle de verdict n'existe qu'une fois en SQL**, dans `views/01_v_rule_orders.sql`. La passerelle simulée
  la reproduit (`verdict_of`, `bigquery/contract.py`) ; `tests/test_verdict.py` vérifie qu'elles concordent.
  Verdicts : `FRAUD` (fraude avérée), `RISKY` (commande risquée, analystes seulement), `NOT_FRAUD` (RAS),
  `TO_REVIEW` (à vérifier, en test), `PENDING` (en attente de vérification, en production).
- **Pertinence** = (fraudes avérées + commandes risquées) ÷ commandes vérifiées (`is_relevant`,
  `orders_relevant`).
- Les scripts sont rejouables : une évolution d'une table existante passe par un nouveau script numéroté de
  mise à niveau dans `tables/` (`ADD COLUMN IF NOT EXISTS`, `UPDATE ... WHERE` idempotent), jamais par la
  modification seule du `CREATE`. `apply.sh` / `apply.ps1` exécutent `tables/` puis `views/`.
- Le SQL généré par `bigquery/real.py` est vérifié par `sqlglot` dans `tests/test_bigquery_sql.py`.

## Logique dupliquée à garder alignée

| Logique | Endroits |
| --- | --- |
| Calendrier des fréquences (échéances, périodes, pas autorisés, `ANCHOR`) | `backend/app/core/periods.py`, `frontend/src/lib/period.ts`, `infra/airflow/fraud_rules_dags.py` |
| Contrôles du texte SQL et empreinte `query_hash` (FNV-1a sur UTF-16) | `backend/app/core/sql.py` + `services/query.py`, `frontend/src/lib/sql.ts` |
| Statuts et décisions | `backend/app/services/rules.py`, `frontend/src/api/mock/mockApi.ts` |

## Front : conventions

- Style centralisé (`frontend/STYLE.md`) : aucune couleur en dur hors de `src/styles/tokens.css` (une
  nouvelle couleur devient un jeton défini pour les deux thèmes), pas de style inline statique, nouvelles
  classes dans `ui.css`. Vérifié par `src/__tests__/style.test.ts`.
- Une section = une `Card` ; tableaux `table.data` dans `.table-wrap`, paginés avec `usePaged` + `Pager`.
- Histogramme (`DailyBars`) : couleurs de la qualification (rouge fraude avérée, orange risquée, vert RAS,
  gris non vérifiée), pertinence en ligne neutre ; jetons `--chart-*`.
- Vocabulaire de l'interface : « En test » / « En production », « Verdict », « À vérifier », « En attente de
  vérification », « Pertinence », pages « Surveillance » et « Journal d'activité » (jamais « audit » à
  l'écran).
- Vérifier un changement d'interface dans le navigateur (mode démo : `make dev-front`), en clair, en sombre et
  à largeur de téléphone (pas de défilement horizontal).
