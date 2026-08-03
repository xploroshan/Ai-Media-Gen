"""Env validation — fail fast at boot (SPEC §11.1)."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = Field(alias="DATABASE_URL")
    s3_endpoint: str = Field(alias="S3_ENDPOINT")
    s3_access_key: str = Field(alias="S3_ACCESS_KEY")
    s3_secret_key: str = Field(alias="S3_SECRET_KEY")
    s3_region: str = Field(default="us-east-1", alias="S3_REGION")
    bucket_originals: str = Field(default="originals", alias="S3_BUCKET_ORIGINALS")
    bucket_derived: str = Field(default="derived", alias="S3_BUCKET_DERIVED")
    bucket_renders: str = Field(default="renders", alias="S3_BUCKET_RENDERS")
    bucket_generated: str = Field(default="generated", alias="S3_BUCKET_GENERATED")
    worker_concurrency: int = Field(default=2, alias="WORKER_CONCURRENCY")
    fal_key: str = Field(default="", alias="FAL_KEY")
    model_cache_dir: str = Field(default="/tmp/reelforge-models", alias="MODEL_CACHE_DIR")
    worker_id: str = Field(default="", alias="WORKER_ID")

    @property
    def sqlalchemy_url(self) -> str:
        # psycopg3 driver
        return self.database_url.replace("postgresql://", "postgresql+psycopg://", 1)


@lru_cache
def get_settings() -> Settings:
    return Settings()  # raises pydantic.ValidationError on missing env → fail fast
