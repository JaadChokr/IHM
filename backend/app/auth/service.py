"""Sessions (cookie HttpOnly, 8 h glissantes) et utilisateur courant."""

import hashlib
import re
import secrets
from datetime import timedelta

from fastapi import Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import User, UserSession
from app.core.clock import as_utc, now
from app.core.config import Settings, get_settings
from app.core.db import get_db
from app.core.errors import ApiError

MATRICULE_RE = re.compile(r"^\d{6}$")


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def open_session(db: Session, response: Response, matricule: str, pending_profile: bool) -> None:
    settings = get_settings()
    token = secrets.token_urlsafe(32)
    db.add(
        UserSession(
            token_hash=_hash(token), matricule=matricule, pending_profile=pending_profile, last_seen=now()
        )
    )
    response.set_cookie(
        settings.session_cookie,
        token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


def close_session(db: Session, request: Request, response: Response) -> None:
    settings = get_settings()
    token = request.cookies.get(settings.session_cookie)
    if token:
        db.query(UserSession).filter_by(token_hash=_hash(token)).delete()
    response.delete_cookie(settings.session_cookie, path="/")


def get_session_record(
    request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)
) -> UserSession | None:
    token = request.cookies.get(settings.session_cookie)
    if not token:
        return None
    rec = db.get(UserSession, _hash(token))
    if rec is None:
        return None
    if now() - as_utc(rec.last_seen) > timedelta(hours=settings.session_ttl_hours):
        db.delete(rec)
        db.commit()
        return None
    return rec


def get_current_user(
    rec: UserSession | None = Depends(get_session_record), db: Session = Depends(get_db)
) -> User:
    if rec is None or rec.pending_profile:
        raise ApiError(401, "Session expirée ou absente.")
    user = db.get(User, rec.matricule)
    if user is None:
        raise ApiError(401, "Utilisateur inconnu.")
    rec.last_seen = now()  # session glissante
    db.commit()
    return user


def users_by_matricule(db: Session) -> dict[str, User]:
    return {u.matricule: u for u in db.scalars(select(User))}


def display_name(users: dict[str, User], matricule: str) -> str:
    u = users.get(matricule)
    return u.full_name if u else matricule
