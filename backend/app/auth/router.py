"""Identification par matricule, profil, liste des utilisateurs."""

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.models import User, UserSession
from app.auth.schemas import LoginIn, LoginOut, ProfileIn, UserOut
from app.auth.service import MATRICULE_RE, close_session, get_current_user, get_session_record, open_session
from app.core.clock import now
from app.core.db import get_db
from app.core.errors import ApiError

router = APIRouter(tags=["identification"])


@router.post("/session", response_model=LoginOut)
def login(body: LoginIn, response: Response, db: Session = Depends(get_db)):
    # Seul contrôle : le format. Ce n'est pas une authentification (PRD F8).
    if not MATRICULE_RE.match(body.matricule):
        raise ApiError(422, "Le matricule doit comporter exactement 6 chiffres.")
    user = db.get(User, body.matricule)
    open_session(db, response, body.matricule, pending_profile=user is None)
    if user:
        record_audit(db, user, "LOGIN")
    db.commit()
    return LoginOut(user=UserOut.model_validate(user) if user else None, needs_profile=user is None)


@router.post("/me/profile", response_model=UserOut)
def complete_profile(
    body: ProfileIn, rec: UserSession | None = Depends(get_session_record), db: Session = Depends(get_db)
):
    if rec is None or not rec.pending_profile:
        raise ApiError(400, "Aucune première connexion en cours.")
    user = db.get(User, rec.matricule) or User(
        matricule=rec.matricule,
        first_name=body.first_name.strip(),
        last_name=body.last_name.strip(),
        created_at=now(),
    )
    db.add(user)
    rec.pending_profile = False
    rec.last_seen = now()
    record_audit(db, user, "LOGIN", details="Première connexion")
    db.commit()
    return user


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user


@router.patch("/me", response_model=UserOut)
def update_me(body: ProfileIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    user.first_name, user.last_name = body.first_name.strip(), body.last_name.strip()
    record_audit(db, user, "PROFILE_UPDATE")
    db.commit()
    return user


@router.delete("/session", status_code=204)
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    close_session(db, request, response)
    db.commit()
    response.status_code = 204
    return response


@router.get("/users", response_model=list[UserOut])
def users(_: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return db.scalars(select(User).order_by(User.last_name)).all()
