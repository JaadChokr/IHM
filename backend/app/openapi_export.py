"""Contrat de l'API, au format OpenAPI, partagé avec le front.

Le fichier `frontend/src/api/openapi.json` est généré à partir des routes et des schémas de l'API ; le front
en tire ses types TypeScript (`npm run api:types`). Après toute modification d'une route ou d'un schéma :

    python -m app.openapi_export          # régénère frontend/src/api/openapi.json
    cd ../frontend && npm run api:types   # régénère frontend/src/api/schema.gen.ts

Un test vérifie que le fichier est à jour (tests/test_contract.py) : un schéma modifié sans régénération fait
échouer les tests, au lieu de casser le front à l'exécution.
"""

import json
import sys
from pathlib import Path

from app.main import create_app

CONTRACT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "api" / "openapi.json"


def contract() -> str:
    """Le contrat OpenAPI de l'API, sérialisé de façon stable (même entrée, même texte)."""
    return json.dumps(create_app().openapi(), indent=2, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    CONTRACT.write_text(contract(), encoding="utf-8")
    print(f"Contrat écrit : {CONTRACT}", file=sys.stderr)
