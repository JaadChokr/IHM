"""Connexion à la base applicative (Cloud SQL / PostgreSQL, SQLite en test).

Les tables sont des classes SQLModel (`table=True`), enregistrées sur `SQLModel.metadata`
(voir app/models.py).
"""

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

_engine = None

_SessionLocal: sessionmaker[Session] | None = None


def init_engine(url: str | None = None, **kwargs):
    global _engine, _SessionLocal
    _engine = create_engine(url or get_settings().database_url, pool_pre_ping=True, **kwargs)
    _SessionLocal = sessionmaker(_engine, expire_on_commit=False)
    return _engine


def get_db() -> Iterator[Session]:
    if _SessionLocal is None:
        init_engine()
    assert _SessionLocal is not None
    with _SessionLocal() as session:
        yield session
