"""Observation puis décision : une version exécutée par Airflow n'est envoyée au prestataire
qu'après la décision de l'analyste (colonnes decision, decided_at, decided_by).

Les versions qui avaient déjà tourné étaient en production (envoyées) : elles passent en SENT.

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-02
"""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("rule_versions") as batch:
        batch.add_column(sa.Column("decision", sa.String(10)))
        batch.add_column(sa.Column("decided_at", sa.DateTime(timezone=True)))
        batch.add_column(sa.Column("decided_by", sa.String(6)))
    op.execute(
        "UPDATE rule_versions SET decision = 'SENT', decided_at = first_run_at, decided_by = submitted_by"
        " WHERE first_run_at IS NOT NULL"
    )


def downgrade() -> None:
    with op.batch_alter_table("rule_versions") as batch:
        batch.drop_column("decided_by")
        batch.drop_column("decided_at")
        batch.drop_column("decision")
