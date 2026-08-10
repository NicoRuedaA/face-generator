#!/usr/bin/env python3
"""Cluster normalized landmark samples into a Sports Face morphology pack."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import random
from statistics import mean

REQUIRED = (
    "top", "templeLeft", "templeRight", "cheekLeft", "cheekRight",
    "jawLeft", "jawRight", "chin", "chinLeft", "chinRight", "eyeLeft",
    "eyeRight", "eyeLeftOuter", "eyeLeftInner", "eyeLeftTop", "eyeLeftBottom",
    "eyeRightOuter", "eyeRightInner", "eyeRightTop", "eyeRightBottom",
    "noseBridge", "noseTip", "noseLeft", "noseRight", "mouthLeft", "mouthRight",
    "hairlineLeft", "hairlineCenter", "hairlineRight", "earLeft", "earRight",
)
FEATURE_KEYS = (
    "craniumWidth", "cheekWidth", "jawWidth", "chinWidth", "faceHeight",
    "foreheadHeight", "eyeSpacing", "eyeWidth", "eyeHeight", "noseLength",
    "noseWidth", "mouthWidth", "earSpan", "templeSlope",
)


def is_finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_feature_values(owner: str, values: dict[str, float]) -> None:
    invalid = [
        key for key, value in values.items()
        if not is_finite_number(value) or value <= 0
    ]
    if invalid:
        raise ValueError(f"{owner} has invalid positive finite features: {', '.join(invalid)}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--families", type=int, default=8)
    parser.add_argument("--seed", type=int, default=400)
    return parser.parse_args()


def distance(a: list[float], b: list[float]) -> float:
    value = math.sqrt(sum((left - right) ** 2 for left, right in zip(a, b)))
    if not math.isfinite(value):
        raise ValueError("K-means distance is not finite")
    return value


def midpoint(a: dict, b: dict) -> tuple[float, float]:
    return ((a["x"] + b["x"]) / 2, (a["y"] + b["y"]) / 2)


def span(a: dict, b: dict) -> float:
    value = math.dist((a["x"], a["y"]), (b["x"], b["y"]))
    if not math.isfinite(value):
        raise ValueError("Landmark span is not finite")
    return value


def temple_angle(a: dict, b: dict) -> float:
    """Return the unsigned temple-to-hairline angle in radians."""
    value = math.atan2(abs(a["y"] - b["y"]), abs(a["x"] - b["x"]))
    if not math.isfinite(value):
        raise ValueError("Temple-to-hairline angle is not finite")
    return value


def vector(sample: dict) -> dict[str, float]:
    if not isinstance(sample, dict) or not isinstance(sample.get("landmarks"), dict):
        raise ValueError(f"{sample.get('id', '?') if isinstance(sample, dict) else '?'} has invalid landmarks")
    landmarks = sample["landmarks"]
    missing = [name for name in REQUIRED if name not in landmarks]
    if missing:
        raise ValueError(f"{sample.get('id', '?')} missing landmarks: {', '.join(missing)}")
    for name in REQUIRED:
        point = landmarks[name]
        if (
            not isinstance(point, dict)
            or not is_finite_number(point.get("x"))
            or not is_finite_number(point.get("y"))
        ):
            raise ValueError(f"{sample.get('id', '?')} has invalid coordinates for {name}")
    face_height = landmarks["chin"]["y"] - landmarks["top"]["y"]
    if not math.isfinite(face_height) or face_height <= 0:
        raise ValueError(f"{sample.get('id', '?')} has invalid face height")
    values = {
        "craniumWidth": span(landmarks["templeLeft"], landmarks["templeRight"]) / face_height,
        "cheekWidth": span(landmarks["cheekLeft"], landmarks["cheekRight"]) / face_height,
        "jawWidth": span(landmarks["jawLeft"], landmarks["jawRight"]) / face_height,
        "chinWidth": span(landmarks["chinLeft"], landmarks["chinRight"]) / face_height,
        "faceHeight": face_height / 452.0,
        "foreheadHeight": (landmarks["hairlineCenter"]["y"] - landmarks["top"]["y"]) / face_height,
        "eyeSpacing": span(landmarks["eyeLeft"], landmarks["eyeRight"]) / face_height,
        "eyeWidth": mean([
            span(landmarks["eyeLeftOuter"], landmarks["eyeLeftInner"]),
            span(landmarks["eyeRightOuter"], landmarks["eyeRightInner"]),
        ]) / face_height,
        "eyeHeight": mean([
            span(landmarks["eyeLeftTop"], landmarks["eyeLeftBottom"]),
            span(landmarks["eyeRightTop"], landmarks["eyeRightBottom"]),
        ]) / face_height,
        "noseLength": span(landmarks["noseBridge"], landmarks["noseTip"]) / face_height,
        "noseWidth": span(landmarks["noseLeft"], landmarks["noseRight"]) / face_height,
        "mouthWidth": span(landmarks["mouthLeft"], landmarks["mouthRight"]) / face_height,
        "earSpan": span(landmarks["earLeft"], landmarks["earRight"]) / face_height,
        # The unsigned angle is in radians: 0 is horizontal and pi/2 is vertical.
        "templeSlope": mean([
            temple_angle(landmarks["templeLeft"], landmarks["hairlineLeft"]),
            temple_angle(landmarks["templeRight"], landmarks["hairlineRight"]),
        ]),
    }
    validate_feature_values(sample.get("id", "?"), values)
    return values


def kmeans(rows: list[list[float]], k: int, seed: int) -> tuple[list[list[float]], list[int]]:
    if k < 1 or k > len(rows):
        raise ValueError("families must be between 1 and sample count")
    rng = random.Random(seed)
    centroids = [rows[index][:] for index in rng.sample(range(len(rows)), k)]
    assignments = [-1] * len(rows)
    for _ in range(100):
        new_assignments = [min(range(k), key=lambda idx: distance(row, centroids[idx])) for row in rows]
        if new_assignments == assignments:
            break
        assignments = new_assignments
        for cluster in range(k):
            members = [rows[index] for index, value in enumerate(assignments) if value == cluster]
            if members:
                centroids[cluster] = [mean(values) for values in zip(*members)]
            else:
                centroids[cluster] = rows[rng.randrange(len(rows))][:]
    return centroids, assignments


def main() -> int:
    args = parse_args()
    document = json.loads(args.input.read_text(encoding="utf-8"))
    samples = document.get("samples", [])
    if len(samples) < args.families:
        raise SystemExit("Not enough samples for the requested family count")
    feature_dicts = [vector(sample) for sample in samples]
    rows = [[features[key] for key in FEATURE_KEYS] for features in feature_dicts]
    centroids, assignments = kmeans(rows, args.families, args.seed)

    order = sorted(range(args.families), key=lambda index: (centroids[index][3], centroids[index][2], centroids[index][0]))
    remap = {old: new for new, old in enumerate(order)}
    names = [
        "compact", "compact-wide", "balanced", "tapered", "angular",
        "broad", "long", "high-forehead",
    ]
    families = []
    for old_index in order:
        new_index = remap[old_index]
        members = [samples[i]["id"] for i, cluster in enumerate(assignments) if cluster == old_index]
        centroid = {key: round(value, 6) for key, value in zip(FEATURE_KEYS, centroids[old_index])}
        validate_feature_values(f"centroid {new_index + 1}", centroid)
        families.append({
            "id": f"gnm-{new_index + 1:02d}-{names[new_index] if new_index < len(names) else 'family'}",
            "label": f"GNM family {new_index + 1}",
            "centroid": centroid,
            "memberCount": len(members),
            "members": members,
        })

    output = {
        "schema": "sports-face-morphology-pack/v1",
        "version": "generated-offline",
        "source": document.get("source", {"kind": "unknown", "gnmDerived": False}),
        "clustering": {
            "algorithm": "deterministic-kmeans",
            "families": args.families,
            "seed": args.seed,
            "features": list(FEATURE_KEYS),
        },
        "families": families,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(families)} morphology families from {len(samples)} samples to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
