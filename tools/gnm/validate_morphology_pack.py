#!/usr/bin/env python3
"""Validate the portable morphology-pack contract."""

from __future__ import annotations

import json
import math
from pathlib import Path
import sys

FEATURE_KEYS = (
    "craniumWidth", "cheekWidth", "jawWidth", "chinWidth", "faceHeight",
    "foreheadHeight", "eyeSpacing", "eyeWidth", "eyeHeight", "noseLength",
    "noseWidth", "mouthWidth", "earSpan", "templeSlope",
)
REQUIRED_METRICS = set(FEATURE_KEYS)


def validate_features(family_id: str, centroid: object) -> None:
    if not isinstance(centroid, dict):
        raise ValueError(f"{family_id} missing centroid")
    keys = set(centroid)
    if keys != REQUIRED_METRICS:
        missing = REQUIRED_METRICS - keys
        extra = keys - REQUIRED_METRICS
        raise ValueError(f"{family_id} has invalid feature keys: missing={sorted(missing)}, extra={sorted(extra)}")
    invalid = [
        key for key, value in centroid.items()
        if isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
    ]
    if invalid:
        raise ValueError(f"{family_id} has invalid numeric metrics: {sorted(invalid)}")


def validate_document(document: dict) -> None:
    if document.get("schema") != "sports-face-morphology-pack/v1":
        raise ValueError("Unexpected morphology-pack schema")
    families = document.get("families", [])
    if not isinstance(families, list) or not families:
        raise ValueError("Morphology pack has no families")
    if document.get("clustering", {}).get("features") != list(FEATURE_KEYS):
        raise ValueError(f"Unexpected feature contract: {FEATURE_KEYS}")
    ids = set()
    for family in families:
        if not isinstance(family, dict):
            raise ValueError("Invalid family entry")
        family_id = family.get("id")
        if not family_id or family_id in ids:
            raise ValueError(f"Invalid or duplicate family id: {family_id}")
        ids.add(family_id)
        validate_features(family_id, family.get("centroid"))


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: validate_morphology_pack.py PACK.json")
    path = Path(sys.argv[1])
    document = json.loads(path.read_text(encoding="utf-8"))
    validate_document(document)
    families = document["families"]
    print(f"Morphology pack valid: {len(families)} families; source={document.get('source', {}).get('kind', 'unknown')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
