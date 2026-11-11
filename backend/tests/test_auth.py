from datetime import timedelta

import pytest

from app.auth.models import UserSession
from tests.conftest import login


@pytest.mark.parametrize("bad", ["12345", "1234567", "12a456", ""])
def test_matricule_mal_forme_refuse(client, bad):
    r = client.post("/session", json={"matricule": bad})
    assert r.status_code == 422
    assert "6 chiffres" in r.json()["detail"]


def test_premiere_connexion_puis_me(client):
    r = client.post("/session", json={"matricule": "104233"})
    assert r.json() == {"user": None, "needsProfile": True}
    # Tant que le profil n'est pas rempli, pas d'identité.
    assert client.get("/me").status_code == 401
    client.post("/me/profile", json={"firstName": "Camille", "lastName": "Martin"})
    me = client.get("/me").json()
    assert me == {"matricule": "104233", "firstName": "Camille", "lastName": "Martin"}


def test_reconnexion_matricule_connu(client):
    login(client)
    client.delete("/session")
    assert client.get("/me").status_code == 401
    r = client.post("/session", json={"matricule": "104233"})
    assert r.json()["needsProfile"] is False
    assert client.get("/me").status_code == 200


def test_session_expiree_apres_8h(client, session_factory):
    login(client)
    with session_factory() as db:
        rec = db.query(UserSession).one()
        rec.last_seen = rec.last_seen - timedelta(hours=8, minutes=1)
        db.commit()
    assert client.get("/me").status_code == 401


def test_routes_protegees(client):
    for path in ("/rules", "/audit", "/users", "/config/guardrails"):
        assert client.get(path).status_code == 401, path
