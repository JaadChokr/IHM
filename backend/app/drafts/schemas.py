"""Schémas d'échange des brouillons."""

from datetime import datetime

from app.query.schemas import TestRecord
from app.rules.schemas import RuleInput


class DraftIn(RuleInput):
    rule_id: str | None = None  # règle existante dont on prépare une nouvelle version


class DraftOut(RuleInput):
    """Brouillon personnel (visible de son seul auteur)."""

    id: str
    rule_id: str
    base_version: int | None = None
    new_rule: bool  # la règle n'existe pas encore dans le référentiel
    latest_version: int | None = None  # dernière version soumise de la règle, pour signaler un décalage
    withdrawn: bool = False  # vient d'être créé en retirant une soumission
    created_at: datetime
    updated_at: datetime
    last_test: TestRecord | None = None
    tests: list[TestRecord] = []
