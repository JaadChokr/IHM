"""Brouillons personnels : table et formats d'API."""

from datetime import datetime

from sqlalchemy import UniqueConstraint
from sqlmodel import Field

from app.core.models import UtcDateTime
from app.query.models import TestRecord
from app.rules.models import RuleInput


class DraftIn(RuleInput):
    rule_id: str | None = None  # règle existante dont on prépare une nouvelle version


class DraftBase(RuleInput):
    """Champs d'un brouillon communs à la table `drafts` et à l'API : le contenu (RuleInput) et sa cible."""

    id: str = Field(primary_key=True, max_length=36)
    # Règle visée. Pour une nouvelle règle, identifiant réservé : la règle est créée à la soumission.
    rule_id: str = Field(max_length=36)
    # Version de départ (None : nouvelle règle).
    base_version: int | None = None
    created_at: datetime = Field(sa_type=UtcDateTime)
    updated_at: datetime = Field(sa_type=UtcDateTime)


class DraftOut(DraftBase):
    """Brouillon personnel (visible de son seul auteur)."""

    new_rule: bool  # la règle n'existe pas encore dans le référentiel
    latest_version: int | None = None  # dernière version soumise de la règle, pour signaler un décalage
    withdrawn: bool = False  # vient d'être créé en retirant une soumission
    last_test: TestRecord | None = None
    tests: list[TestRecord] = []


class Draft(DraftBase, table=True):
    """Brouillon personnel : la sauvegarde de travail d'un analyste, comme son profil.

    Visible de lui seul, jamais publié dans `rules_registry`. Il devient une version de règle
    (et la règle entre dans le référentiel partagé) au moment de la soumission.
    """

    __tablename__ = "drafts"
    __table_args__ = (UniqueConstraint("matricule", "rule_id"),)

    matricule: str = Field(max_length=6, foreign_key="users.matricule", index=True)
