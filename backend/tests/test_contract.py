"""Le contrat partagé avec le front (frontend/src/api/openapi.json) doit refléter l'API telle qu'elle est.

Une route ou un schéma modifié sans régénération (python -m app.openapi_export) fait échouer ce test : le
front tire ses types de ce fichier, il ne doit jamais décrire une autre API que celle-ci.
"""

from app.openapi_export import CONTRACT, contract


def test_contrat_openapi_a_jour():
    assert CONTRACT.exists(), "Contrat absent : lancer python -m app.openapi_export"
    assert (
        CONTRACT.read_text(encoding="utf-8") == contract()
    ), "Contrat du front périmé : lancer python -m app.openapi_export, puis npm run api:types dans frontend/"
