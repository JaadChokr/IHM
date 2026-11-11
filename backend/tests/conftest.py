import os

os.environ.setdefault("RM_ENV", "test")
os.environ.setdefault("RM_COOKIE_SECURE", "false")
os.environ.setdefault("RM_BIGQUERY_MODE", "fake")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from app.bigquery import FakeBigQueryGateway, get_bigquery  # noqa: E402
from app.core.db import get_db
from app.main import create_app  # noqa: E402
from app.models import Base  # noqa: E402


@pytest.fixture
def bq():
    return FakeBigQueryGateway()


@pytest.fixture
def session_factory():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def client(bq, session_factory):
    def db():
        with session_factory() as s:
            yield s

    app = create_app()
    app.dependency_overrides[get_db] = db
    app.dependency_overrides[get_bigquery] = lambda: bq
    with TestClient(app) as c:
        yield c


def login(client, matricule="104233", first="Camille", last="Martin"):
    r = client.post("/session", json={"matricule": matricule})
    assert r.status_code == 200, r.text
    if r.json()["needsProfile"]:
        r = client.post("/me/profile", json={"firstName": first, "lastName": last})
        assert r.status_code == 200, r.text
    return client
