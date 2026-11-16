.PHONY: install dev-front dev-api test lint up api-types

install:
	cd frontend && npm ci
	cd backend && python -m venv .venv && .venv/bin/pip install -e ".[dev]"

dev-front:            ## front en mode démo (données simulées)
	cd frontend && npm run dev

dev-front-http:       ## front branché sur l'API locale (localhost:8000)
	cd frontend && VITE_API_MODE=http npm run dev

dev-api:              ## API locale, BigQuery factice ; nécessite PostgreSQL (make up-db)
	cd backend && .venv/bin/alembic upgrade head && .venv/bin/uvicorn app.main:app --reload --port 8000

up-db:
	docker compose up -d db

up:                   ## tout en conteneurs → http://localhost:8081
	docker compose up --build

test:
	cd frontend && npm run typecheck && npm test
	cd backend && .venv/bin/pytest -q

lint:
	cd backend && .venv/bin/ruff check . && .venv/bin/ruff format --check .

api-types:            ## après un changement de route ou de schéma : régénère le contrat et les types du front
	cd backend && .venv/bin/python -m app.openapi_export
	cd frontend && npm run api:types
