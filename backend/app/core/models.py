"""Base commune des tables et des formats d'échange (SQLModel).

Une même classe peut décrire une table (avec `table=True`) et un format de l'API. On déclare donc une
seule fois les champs partagés. Le JSON est en camelCase, et le front en tire ses types
(src/api/openapi.json).
"""

from pydantic import ConfigDict
from pydantic.alias_generators import to_camel
from sqlalchemy import DateTime
from sqlmodel import SQLModel


class Model(SQLModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)


# Horodatages stockés avec leur fuseau (sans précision, SQLModel crée des dates sans fuseau).
UtcDateTime = DateTime(timezone=True)
