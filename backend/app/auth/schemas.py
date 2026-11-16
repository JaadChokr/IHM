"""Formats d'échange de l'identification. `UserBase` est aussi la base de la table `users`."""

from sqlmodel import Field

from app.core.schemas import Model


class UserBase(Model):
    matricule: str = Field(primary_key=True, max_length=6)
    first_name: str = Field(max_length=100)
    last_name: str = Field(max_length=100)


class UserOut(UserBase):
    pass


class LoginIn(Model):
    matricule: str


class LoginOut(Model):
    user: UserOut | None
    needs_profile: bool


class ProfileIn(Model):
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
