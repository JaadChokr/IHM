"""Journal d'audit, en ajout seul (immuable, conservation 24 mois)."""

from app.audit.schemas import AuditEventOut


class AuditEvent(AuditEventOut, table=True):
    """Journal d'audit, en ajout seul (immuable, conservation 24 mois). Mêmes champs que l'API."""

    __tablename__ = "audit_events"
