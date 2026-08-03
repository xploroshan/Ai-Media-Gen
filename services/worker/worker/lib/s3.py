"""MinIO/S3 access. storageKey format everywhere: '<bucket>/<key/...>'."""

from __future__ import annotations

import mimetypes
import tempfile
from functools import lru_cache
from pathlib import Path

import boto3
from botocore.config import Config

from worker.lib.settings import get_settings


@lru_cache
def client():
    s = get_settings()
    return boto3.client(
        "s3",
        endpoint_url=s.s3_endpoint,
        aws_access_key_id=s.s3_access_key,
        aws_secret_access_key=s.s3_secret_key,
        region_name=s.s3_region,
        config=Config(s3={"addressing_style": "path"}),
    )


def split_storage_key(storage_key: str) -> tuple[str, str]:
    bucket, _, key = storage_key.partition("/")
    if not bucket or not key:
        raise ValueError(f"bad storageKey {storage_key!r}, want '<bucket>/<key>'")
    return bucket, key


def download_to_tmp(storage_key: str, suffix: str = "") -> Path:
    bucket, key = split_storage_key(storage_key)
    with tempfile.NamedTemporaryFile(
        suffix=suffix or Path(key).suffix, delete=False
    ) as fd:
        name = fd.name
    try:
        client().download_file(bucket, key, name)
    except BaseException:
        Path(name).unlink(missing_ok=True)
        raise
    return Path(name)


def upload_file(path: Path | str, storage_key: str, content_type: str | None = None) -> str:
    bucket, key = split_storage_key(storage_key)
    ct = content_type or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    client().upload_file(str(path), bucket, key, ExtraArgs={"ContentType": ct})
    return storage_key


def object_exists(storage_key: str) -> bool:
    bucket, key = split_storage_key(storage_key)
    try:
        client().head_object(Bucket=bucket, Key=key)
        return True
    except client().exceptions.ClientError:
        return False
