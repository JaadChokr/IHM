"""Passerelle BigQuery : interface (contract.py), implémentation réelle (real.py) et simulée (fake.py).

`get_bigquery` est la dépendance FastAPI : implémentation réelle si RM_BIGQUERY_MODE=real, simulée sinon.
Les modules métier n'importent que le contrat et cette dépendance.
"""

from functools import lru_cache

from app.bigquery.contract import (
    AlertFilter,
    AlertRow,
    BigQueryGateway,
    BytesLimitExceeded,
    DryRunMeta,
    ExecMeta,
    Overlap,
    ProductionTotals,
    QueryError,
    RunStats,
    verdict_of,
)
from app.bigquery.fake import FakeBigQueryGateway
from app.bigquery.real import RealBigQueryGateway
from app.core.config import get_settings

__all__ = [
    "AlertFilter",
    "AlertRow",
    "BigQueryGateway",
    "BytesLimitExceeded",
    "DryRunMeta",
    "ExecMeta",
    "FakeBigQueryGateway",
    "Overlap",
    "ProductionTotals",
    "QueryError",
    "RealBigQueryGateway",
    "RunStats",
    "get_bigquery",
    "verdict_of",
]


@lru_cache
def _gateway() -> BigQueryGateway:
    s = get_settings()
    return RealBigQueryGateway(s) if s.bigquery_mode == "real" else FakeBigQueryGateway()


def get_bigquery() -> BigQueryGateway:
    return _gateway()
