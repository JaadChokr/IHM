"""Base des schémas d'échange : JSON en camelCase, miroir de frontend/src/api/types.ts."""

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)
