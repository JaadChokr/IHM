"""Brouillons personnels."""

from sqlalchemy import UniqueConstraint
from sqlmodel import Field

from app.drafts.schemas import DraftBase


class Draft(DraftBase, table=True):
    """Brouillon personnel : la sauvegarde de travail d'un analyste, comme son profil.

    Visible de lui seul, jamais publié dans `rules_registry`. Il devient une version de règle
    (et la règle entre dans le référentiel partagé) au moment de la soumission.
    """

    __tablename__ = "drafts"
    __table_args__ = (UniqueConstraint("matricule", "rule_id"),)

    matricule: str = Field(max_length=6, foreign_key="users.matricule", index=True)
