"""Erreurs métier, sérialisées en {detail, code} pour le front."""

from fastapi import Request
from fastapi.responses import JSONResponse


class ApiError(Exception):
    """Erreur métier : sérialisée en {detail, code}, format lu par le front."""

    def __init__(self, status: int, detail: str, code: str | None = None):
        self.status = status
        self.detail = detail
        self.code = code


async def api_error_handler(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ApiError)
    return JSONResponse({"detail": exc.detail, "code": exc.code}, status_code=exc.status)
