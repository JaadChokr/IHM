import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import alerts, auth, drafts, pilotage, query, rules
from app.core import ApiError, api_error_handler, get_settings


def create_app() -> FastAPI:
    settings = get_settings()
    logging.basicConfig(
        level=logging.INFO, format='{"level":"%(levelname)s","logger":"%(name)s","message":"%(message)s"}'
    )

    # Le front appelle /api/... ; le préfixe est retiré par le proxy (Vite en local, Nginx en production).
    app = FastAPI(title="Fraud Rules API", version="0.1.0")
    app.add_exception_handler(ApiError, api_error_handler)
    if settings.env == "local":
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    for module in (auth, rules, drafts, query, pilotage, alerts):
        app.include_router(module.router)

    @app.get("/healthz", include_in_schema=False)
    def healthz():
        return {"status": "ok"}

    return app


app = create_app()
