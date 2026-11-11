"""Schémas d'échange de l'identification."""

from pydantic import Field

from app.core.schemas import Model


class UserOut(Model):
    matricule: str
    first_name: str
    last_name: str


class LoginIn(Model):
    matricule: str


class LoginOut(Model):
    user: UserOut | None
    needs_profile: bool


class ProfileIn(Model):
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
