"""Fréquence avec un pas : toutes les N heures, jours ou semaines (colonne schedule_every, 1 par défaut).

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-09
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for table in ("rule_versions", "drafts"):
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column("schedule_every", sa.Integer(), nullable=False, server_default="1"))


def downgrade() -> None:
    for table in ("drafts", "rule_versions"):
        with op.batch_alter_table(table) as batch:
            batch.drop_column("schedule_every")
