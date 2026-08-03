"""Job payload validation — python mirror of packages/shared/src/jobs.ts (SPEC §5.2).

Light-weight on purpose: required keys + basic types, so a cross-language field
rename fails loudly at dispatch instead of as a KeyError deep in a handler.
"""

from __future__ import annotations

from typing import Any

# type -> {field: (required, type or tuple-of-types)}
_SCHEMAS: dict[str, dict[str, tuple[bool, tuple[type, ...]]]] = {
    "analyze_media": {"assetId": (True, (str,))},
    "detect_events": {"ownerId": (True, (str,))},
    "beats": {"assetId": (True, (str,))},
    "transcribe": {"assetId": (True, (str,)), "lang": (False, (str,))},
    "autoedit_generate": {
        "projectId": (True, (str,)),
        "assetIds": (True, (list,)),
        "vibeId": (True, (str,)),
        "presetId": (True, (str,)),
        "targetSec": (True, (int, float)),
        "seed": (True, (int,)),
        "steering": (False, (dict,)),
        "excludeAssetIds": (False, (list,)),
    },
    "render_preview": {"projectId": (True, (str,)), "exportId": (False, (str,))},
    "render_final": {
        "projectId": (True, (str,)),
        "exportId": (False, (str,)),
        "editSpecSnapshot": (False, (dict,)),
    },
    "generate_ai": {"generationId": (True, (str,))},
    "image_op": {
        "assetId": (True, (str,)),
        "op": (True, (str,)),
        "params": (False, (dict,)),
    },
}


class PayloadError(ValueError):
    pass


def validate_payload(job_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    schema = _SCHEMAS.get(job_type)
    if schema is None:
        raise PayloadError(f"unknown job type {job_type!r}")
    if not isinstance(payload, dict):
        raise PayloadError(f"{job_type}: payload must be an object")
    for field, (required, types) in schema.items():
        if field not in payload or payload[field] is None:
            if required:
                raise PayloadError(f"{job_type}: missing required field {field!r}")
            continue
        if not isinstance(payload[field], types):
            raise PayloadError(
                f"{job_type}: field {field!r} has type {type(payload[field]).__name__}, "
                f"expected {'/'.join(t.__name__ for t in types)}"
            )
    return payload
