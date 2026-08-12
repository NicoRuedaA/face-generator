#!/usr/bin/env python3
"""Audit the canonical provisional GNM landmark map and projection."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "tools" / "gnm" / "work"
DEFAULT_MAP = WORK / "gnm-vertex-map.json"
DEFAULT_LANDMARKS = WORK / "gnm-landmarks.json"
DEFAULT_RETAINED = WORK / "gnm-landmarks-200.json"
DEFAULT_MESH = WORK / "gnm-heads-200.npz"

EXPECTED_LANDMARKS = (
    "top", "templeLeft", "templeRight", "cheekLeft", "cheekRight",
    "jawLeft", "jawRight", "chin", "chinLeft", "chinRight", "eyeLeft",
    "eyeRight", "eyeLeftOuter", "eyeLeftInner", "eyeLeftTop", "eyeLeftBottom",
    "eyeRightOuter", "eyeRightInner", "eyeRightTop", "eyeRightBottom",
    "noseBridge", "noseTip", "noseLeft", "noseRight", "mouthLeft", "mouthRight",
    "hairlineLeft", "hairlineCenter", "hairlineRight", "earLeft", "earRight",
)
BILATERAL_PAIRS = (
    ("templeLeft", "templeRight"),
    ("cheekLeft", "cheekRight"),
    ("jawLeft", "jawRight"),
    ("chinLeft", "chinRight"),
    ("eyeLeft", "eyeRight"),
    ("eyeLeftOuter", "eyeRightOuter"),
    ("eyeLeftInner", "eyeRightInner"),
    ("eyeLeftTop", "eyeRightTop"),
    ("eyeLeftBottom", "eyeRightBottom"),
    ("noseLeft", "noseRight"),
    ("mouthLeft", "mouthRight"),
    ("hairlineLeft", "hairlineRight"),
    ("earLeft", "earRight"),
)
COORDINATE_TOLERANCE = 1e-5
DEFAULT_MAX_VERTEX_ID = 17820
FRAME = {"left": 160.0, "right": 608.0, "top": 96.0, "bottom": 656.0}


class Audit:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.warnings: list[str] = []
        self.checks: dict[str, dict[str, object]] = {}

    def check(self, name: str, passed: bool, details: object, *, warning: bool = False) -> None:
        if passed:
            status = "PASS"
        elif warning:
            status = "WARN"
            self.warnings.append(name)
        else:
            status = "FAIL"
            self.failures.append(name)
        self.checks[name] = {"status": status, "details": details}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vertex-map", type=Path, default=DEFAULT_MAP)
    parser.add_argument("--landmarks", type=Path, default=DEFAULT_LANDMARKS)
    parser.add_argument("--retained-landmarks", type=Path, default=DEFAULT_RETAINED)
    parser.add_argument("--mesh", type=Path, default=DEFAULT_MESH)
    return parser.parse_args()


def load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def rounded(value: float) -> float:
    return round(value, 10)


def point(landmarks: dict, name: str) -> dict:
    value = landmarks[name]
    if not isinstance(value, dict) or not finite_number(value.get("x")) or not finite_number(value.get("y")):
        raise ValueError(f"invalid point {name}")
    return value


def audit_json(audit: Audit, vertex_map: object, landmarks: object) -> tuple[list[dict], list[int], int]:
    if not isinstance(vertex_map, dict):
        raise ValueError("vertex map must be a JSON object")
    if not isinstance(landmarks, dict):
        raise ValueError("landmarks must be a JSON object")

    mapped = vertex_map.get("landmarks")
    coordinates = vertex_map.get("coordinates")
    audit.check(
        "landmark_names",
        isinstance(mapped, dict) and set(mapped) == set(EXPECTED_LANDMARKS) and
        isinstance(coordinates, dict) and set(coordinates) == set(EXPECTED_LANDMARKS),
        {"expected": len(EXPECTED_LANDMARKS), "actual": len(mapped or {})},
    )

    all_ids: list[int] = []
    invalid_entries = []
    for name in EXPECTED_LANDMARKS:
        ids = mapped.get(name) if isinstance(mapped, dict) else None
        coordinate = coordinates.get(name) if isinstance(coordinates, dict) else None
        if not isinstance(ids, list) or not ids or not all(isinstance(value, int) and not isinstance(value, bool) for value in ids):
            invalid_entries.append(name)
        else:
            all_ids.extend(ids)
        if not isinstance(coordinate, list) or len(coordinate) != 3 or not all(finite_number(value) for value in coordinate):
            invalid_entries.append(f"{name}:coordinate")
    audit.check("map_entry_types", not invalid_entries, {"invalid": invalid_entries})

    samples = landmarks.get("samples")
    valid_samples = isinstance(samples, list) and all(isinstance(sample, dict) for sample in samples)
    audit.check("sample_count", valid_samples and len(samples) == 200, {"expected": 200, "actual": len(samples) if isinstance(samples, list) else None})
    sample_ids = [sample.get("id") for sample in samples] if valid_samples else []
    audit.check("sample_id_uniqueness", len(sample_ids) == len(set(sample_ids)), {"count": len(sample_ids), "unique": len(set(sample_ids))})

    return (samples if valid_samples else [], all_ids, len(all_ids))


def audit_map_integrity(audit: Audit, all_ids: list[int], id_count: int) -> None:
    audit.check("id_uniqueness", id_count == len(set(all_ids)), {"count": id_count, "unique": len(set(all_ids))})
    out_of_range = [value for value in all_ids if value < 0 or value > DEFAULT_MAX_VERTEX_ID]
    audit.check(
        "id_range",
        not out_of_range,
        {"min": min(all_ids) if all_ids else None, "max": max(all_ids) if all_ids else None, "maxAllowed": DEFAULT_MAX_VERTEX_ID, "outOfRange": out_of_range},
    )


def audit_projection(audit: Audit, samples: list[dict]) -> None:
    out_of_bounds = []
    landmark_counts = {name: 0 for name in EXPECTED_LANDMARKS}
    asymmetry: dict[str, float] = {}
    asymmetry_samples: dict[str, str] = {}
    orientation_failures = []

    for sample in samples:
        sample_id = sample.get("id", "?")
        sample_landmarks = sample.get("landmarks")
        if not isinstance(sample_landmarks, dict):
            audit.failures.append(f"sample_landmarks:{sample_id}")
            continue
        try:
            for name in EXPECTED_LANDMARKS:
                current = point(sample_landmarks, name)
                if not (FRAME["left"] <= current["x"] <= FRAME["right"] and FRAME["top"] <= current["y"] <= FRAME["bottom"]):
                    landmark_counts[name] += 1
                    out_of_bounds.append({"sample": sample_id, "landmark": name})
            for left, right in BILATERAL_PAIRS:
                left_point = point(sample_landmarks, left)
                right_point = point(sample_landmarks, right)
                if left_point["x"] <= right_point["x"]:
                    orientation_failures.append({"sample": sample_id, "pair": [left, right]})
                value = abs(left_point["y"] - right_point["y"])
                if value > asymmetry.get(left, -1.0):
                    asymmetry[left] = value
                    asymmetry_samples[left] = sample_id
        except (KeyError, ValueError):
            audit.failures.append(f"sample_landmarks:{sample_id}")

    audit.check("projection_bilateral_orientation", not orientation_failures, {"pairs": len(BILATERAL_PAIRS), "violations": orientation_failures})
    audit.check(
        "projection_bounds",
        not out_of_bounds,
        {"frame": FRAME, "samplesWithWarnings": len({item["sample"] for item in out_of_bounds}), "landmarkCounts": landmark_counts, "excursions": len(out_of_bounds)},
        warning=True,
    )
    maxima = {
        left: {"maxVerticalPx": rounded(asymmetry.get(left, 0.0)), "sample": asymmetry_samples.get(left)}
        for left, _ in BILATERAL_PAIRS
    }
    audit.check("vertical_bilateral_asymmetry", True, {"maxima": maxima})


def audit_retained(audit: Audit, canonical_path: Path, retained_path: Path, samples: list[dict]) -> None:
    if not retained_path.is_file():
        audit.check("retained_artifact", False, {"path": str(retained_path), "reason": "absent"}, warning=True)
        return
    retained = load_json(retained_path)
    retained_samples = retained.get("samples") if isinstance(retained, dict) else None
    same_bytes = canonical_path.read_bytes() == retained_path.read_bytes()
    same_count = isinstance(retained_samples, list) and len(retained_samples) == len(samples) == 200
    audit.check(
        "retained_artifact",
        same_bytes and same_count,
        {"canonical": str(canonical_path), "retained": str(retained_path), "byteIdentical": same_bytes, "sampleCount": len(retained_samples) if isinstance(retained_samples, list) else None},
    )


def audit_mesh(audit: Audit, mesh_path: Path, vertex_map: dict, samples: list[dict]) -> None:
    if not mesh_path.is_file():
        audit.check("mesh_checks", False, {"path": str(mesh_path), "reason": "absent"}, warning=True)
        return
    try:
        import numpy as np
    except ImportError:
        audit.check("mesh_checks", False, {"path": str(mesh_path), "reason": "numpy unavailable"}, warning=True)
        return

    try:
        archive = np.load(mesh_path, allow_pickle=False)
        vertices = np.asarray(archive["vertices"])
        template = np.asarray(archive["template"])
        mapped = vertex_map["landmarks"]
        coordinates = vertex_map["coordinates"]
        expected_shape = [200, int(vertices.shape[1]), 3]
        shape_ok = vertices.ndim == 3 and vertices.shape[0] == 200 and vertices.shape[2] == 3 and template.shape == (vertices.shape[1], 3)
        coordinate_errors = {}
        orientation_failures = []
        for name in EXPECTED_LANDMARKS:
            indices = mapped[name]
            expected = template[indices].mean(axis=0)
            coordinate_errors[name] = float(np.max(np.abs(expected - np.asarray(coordinates[name]))))
        for sample_index, mesh in enumerate(vertices):
            for left, right in BILATERAL_PAIRS:
                left_x = float(mesh[mapped[left], 0].mean())
                right_x = float(mesh[mapped[right], 0].mean())
                if left_x <= right_x:
                    orientation_failures.append({"sample": sample_index + 1, "pair": [left, right]})
        max_error = max(coordinate_errors.values(), default=0.0)
        audit.check(
            "mesh_checks",
            shape_ok and len(samples) == vertices.shape[0] and max_error <= COORDINATE_TOLERANCE and not orientation_failures,
            {"shape": list(vertices.shape), "expectedShape": expected_shape, "coordinateMaxError": max_error, "coordinateTolerance": COORDINATE_TOLERANCE, "bilateralPairs": len(BILATERAL_PAIRS), "orientationViolations": orientation_failures},
        )
    except (KeyError, ValueError, TypeError, IndexError) as error:
        audit.check("mesh_checks", False, {"path": str(mesh_path), "reason": str(error)})


def run(args: argparse.Namespace) -> dict[str, object]:
    audit = Audit()
    try:
        vertex_map = load_json(args.vertex_map)
        landmarks = load_json(args.landmarks)
        samples, all_ids, id_count = audit_json(audit, vertex_map, landmarks)
        audit_map_integrity(audit, all_ids, id_count)
        audit_projection(audit, samples)
        audit_retained(audit, args.landmarks, args.retained_landmarks, samples)
        if isinstance(vertex_map, dict):
            audit_mesh(audit, args.mesh, vertex_map, samples)
    except (OSError, json.JSONDecodeError, ValueError, TypeError) as error:
        audit.failures.append(f"load:{error}")

    status = "FAIL" if audit.failures else "PASS with WARN" if audit.warnings else "PASS"
    return {
        "status": status,
        "failures": audit.failures,
        "warnings": audit.warnings,
        "paths": {"vertexMap": str(args.vertex_map), "landmarks": str(args.landmarks), "retainedLandmarks": str(args.retained_landmarks), "mesh": str(args.mesh)},
        "checks": audit.checks,
    }


def print_summary(report: dict[str, object]) -> None:
    print(f"GNM landmark audit: {report['status']}", file=sys.stderr)
    for name, check in report["checks"].items():
        print(f"  {check['status']:<4} {name}", file=sys.stderr)
    for failure in report["failures"]:
        print(f"  FAIL detail: {failure}", file=sys.stderr)


def main() -> int:
    report = run(parse_args())
    print(json.dumps(report, indent=2, sort_keys=True))
    print_summary(report)
    return 1 if report["status"] == "FAIL" else 0


if __name__ == "__main__":
    raise SystemExit(main())
