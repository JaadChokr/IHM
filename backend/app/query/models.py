"""Métadonnées des tests de requête (jamais les lignes retournées, PRD §10)."""

from app.query.schemas import TestRunBase


class TestRun(TestRunBase, table=True):
    """Métadonnées d'un test (F3). Mêmes champs que l'API, sans le nom de l'auteur (calculé)."""

    __tablename__ = "rule_tests"
