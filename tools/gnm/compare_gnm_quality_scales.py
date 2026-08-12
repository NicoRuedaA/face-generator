#!/usr/bin/env python3
"""Compare offline GNM morphology quality at different sample scales.

The validator reads landmark JSON and morphology-pack JSON only. It deliberately
does not import NumPy or GNM, and an absent or invalid candidate is reported as
unavailable rather than being replaced with fabricated metrics.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
from statistics import median


FEATURE_KEYS = (
    "craniumWidth", "cheekWidth", "jawWidth", "chinWidth", "faceHeight",
    "foreheadHeight", "eyeSpacing", "eyeWidth", "eyeHeight", "noseLength",
    "noseWidth", "mouthWidth", "earSpan", "templeSlope",
)
LANDMARK_KEYS = (
    "top", "templeLeft", "templeRight", "cheekLeft", "cheekRight",
    "jawLeft", "jawRight", "chin", "chinLeft", "chinRight", "eyeLeft",
    "eyeRight", "eyeLeftOuter", "eyeLeftInner", "eyeLeftTop", "eyeLeftBottom",
    "eyeRightOuter", "eyeRightInner", "eyeRightTop", "eyeRightBottom",
    "noseBridge", "noseTip", "noseLeft", "noseRight", "mouthLeft", "mouthRight",
    "hairlineLeft", "hairlineCenter", "hairlineRight", "earLeft", "earRight",
)
DEFAULT_MIN_NEAREST_NEIGHBOR = 0.20
DEFAULT_MAX_DUPLICATES = 0
DEFAULT_MIN_FAMILY_BALANCE = 0.50
DEFAULT_MAX_CENTROID_DELTA = 0.10
SCHEMA = "sports-face-gnm-quality-scale-comparison/v1"


class ComparisonError(ValueError):
    """Raised when a pack cannot provide trustworthy comparison metrics."""


def finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def rounded(value: float) -> float:
    return round(float(value), 10)


def distance(a: dict, b: dict) -> float:
    return math.dist((a["x"], a["y"]), (b["x"], b["y"]))


def feature_vector(sample: dict) -> tuple[float, ...]:
    landmarks = sample.get("landmarks")
    if not isinstance(landmarks, dict):
        raise ComparisonError(f"{sample.get('id', '?')} has no landmarks object")
    missing = [name for name in LANDMARK_KEYS if name not in landmarks]
    if missing:
        raise ComparisonError(f"{sample.get('id', '?')} is missing landmarks: {', '.join(missing)}")
    for name in LANDMARK_KEYS:
        point = landmarks[name]
        if (
            not isinstance(point, dict)
            or not finite_number(point.get("x"))
            or not finite_number(point.get("y"))
        ):
            raise ComparisonError(f"{sample.get('id', '?')} has invalid coordinates for {name}")

    face_height = landmarks["chin"]["y"] - landmarks["top"]["y"]
    if not finite_number(face_height) or face_height <= 0:
        raise ComparisonError(f"{sample.get('id', '?')} has invalid face height")
    values = (
        distance(landmarks["templeLeft"], landmarks["templeRight"]) / face_height,
        distance(landmarks["cheekLeft"], landmarks["cheekRight"]) / face_height,
        distance(landmarks["jawLeft"], landmarks["jawRight"]) / face_height,
        distance(landmarks["chinLeft"], landmarks["chinRight"]) / face_height,
        face_height / 452.0,
        (landmarks["hairlineCenter"]["y"] - landmarks["top"]["y"]) / face_height,
        distance(landmarks["eyeLeft"], landmarks["eyeRight"]) / face_height,
        (
            distance(landmarks["eyeLeftOuter"], landmarks["eyeLeftInner"])
            + distance(landmarks["eyeRightOuter"], landmarks["eyeRightInner"])
        ) / 2 / face_height,
        (
            distance(landmarks["eyeLeftTop"], landmarks["eyeLeftBottom"])
            + distance(landmarks["eyeRightTop"], landmarks["eyeRightBottom"])
        ) / 2 / face_height,
        distance(landmarks["noseBridge"], landmarks["noseTip"]) / face_height,
        distance(landmarks["noseLeft"], landmarks["noseRight"]) / face_height,
        distance(landmarks["mouthLeft"], landmarks["mouthRight"]) / face_height,
        distance(landmarks["earLeft"], landmarks["earRight"]) / face_height,
        (
            math.atan2(
                abs(landmarks["templeLeft"]["y"] - landmarks["hairlineLeft"]["y"]),
                abs(landmarks["templeLeft"]["x"] - landmarks["hairlineLeft"]["x"]),
            )
            + math.atan2(
                abs(landmarks["templeRight"]["y"] - landmarks["hairlineRight"]["y"]),
                abs(landmarks["templeRight"]["x"] - landmarks["hairlineRight"]["x"]),
            )
        ) / 2,
    )
    if any(not finite_number(value) or value <= 0 for value in values):
        raise ComparisonError(f"{sample.get('id', '?')} has a non-positive or non-finite feature")
    return values


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        raise ComparisonError("percentile requires at least one value")
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * weight


def normalized_nearest_neighbors(rows: list[tuple[float, ...]]) -> list[float]:
    if len(rows) < 2:
        raise ComparisonError("at least two samples are required for nearest-neighbor metrics")
    columns = list(zip(*rows))
    bounds = [(min(column), max(column)) for column in columns]
    normalized = [
        tuple(
            0.0 if high == low else (row[index] - low) / (high - low)
            for index, (low, high) in enumerate(bounds)
        )
        for row in rows
    ]
    return [
        min(math.dist(normalized[index], normalized[other]) for other in range(len(rows)) if other != index)
        for index in range(len(rows))
    ]


def provenance(pack: dict) -> dict:
    source = pack.get("source")
    clustering = pack.get("clustering")
    if not isinstance(source, dict):
        source = {}
    if not isinstance(clustering, dict):
        clustering = {}
    sampling = source.get("sampling")
    if not isinstance(sampling, dict):
        sampling = {}
    return {
        "source": source,
        "seed": clustering.get("seed"),
        "sigma": sampling.get("sigma"),
        "sampling": sampling,
    }


def analyze_pack(pack: dict, landmarks: dict, path: str, expected_count: int | None = None) -> dict:
    if pack.get("schema") != "sports-face-morphology-pack/v1":
        raise ComparisonError(f"{path} has an unexpected morphology-pack schema")
    if landmarks.get("schema") != "sports-face-landmark-samples/v1":
        raise ComparisonError(f"{path} has an unexpected landmark-samples schema")
    samples = landmarks.get("samples")
    families = pack.get("families")
    if not isinstance(samples, list) or not samples:
        raise ComparisonError(f"{path} has no landmark samples")
    if not isinstance(families, list) or not families:
        raise ComparisonError(f"{path} has no morphology families")
    if expected_count is not None and len(samples) != expected_count:
        raise ComparisonError(f"{path} has {len(samples)} samples; expected {expected_count}")

    sample_ids = [sample.get("id") for sample in samples]
    if any(not isinstance(sample_id, str) or not sample_id for sample_id in sample_ids):
        raise ComparisonError(f"{path} has an invalid sample ID")
    if len(sample_ids) != len(set(sample_ids)):
        raise ComparisonError(f"{path} has duplicate sample IDs")
    rows = [feature_vector(sample) for sample in samples]
    row_by_id = dict(zip(sample_ids, rows))

    family_counts: dict[str, int] = {}
    family_members: list[str] = []
    centroids: dict[str, dict] = {}
    reasons: list[str] = []
    for family in families:
        family_id = family.get("id") if isinstance(family, dict) else None
        members = family.get("members") if isinstance(family, dict) else None
        centroid = family.get("centroid") if isinstance(family, dict) else None
        if not isinstance(family_id, str) or not family_id or not isinstance(members, list):
            raise ComparisonError(f"{path} has an invalid family entry")
        family_counts[family_id] = len(members)
        family_members.extend(members)
        if isinstance(centroid, dict):
            if any(not finite_number(centroid.get(key)) for key in FEATURE_KEYS):
                raise ComparisonError(f"{path} has an invalid centroid for {family_id}")
            centroids[family_id] = centroid
        else:
            raise ComparisonError(f"{path} has no centroid for {family_id}")
    if len(family_members) != len(set(family_members)) or set(family_members) != set(sample_ids):
        reasons.append("family members do not cover each sample ID exactly once")

    duplicate_groups: dict[tuple[float, ...], list[str]] = {}
    for sample_id, row in row_by_id.items():
        duplicate_groups.setdefault(row, []).append(sample_id)
    duplicate_groups = {row: ids for row, ids in duplicate_groups.items() if len(ids) > 1}
    nearest = normalized_nearest_neighbors(rows)
    feature_stats = {}
    for index, key in enumerate(FEATURE_KEYS):
        values = [row[index] for row in rows]
        average = sum(values) / len(values)
        variance = sum((value - average) ** 2 for value in values) / len(values)
        feature_stats[key] = {
            "min": rounded(min(values)),
            "max": rounded(max(values)),
            "range": rounded(max(values) - min(values)),
            "variance": rounded(variance),
            "varianceDefinition": "population",
        }
    minimum = min(family_counts.values())
    maximum = max(family_counts.values())
    return {
        "path": path,
        "status": "warn" if reasons else "pass",
        "reasons": reasons,
        "provenance": provenance(pack),
        "counts": {
            "samples": len(samples),
            "families": len(families),
            "familyMembers": len(family_members),
            "declaredMemberCount": sum(
                family.get("memberCount", 0) for family in families if isinstance(family, dict)
            ),
        },
        "exactDuplicateFeatureVectors": {
            "count": sum(len(ids) - 1 for ids in duplicate_groups.values()),
            "groups": [sorted(ids) for ids in sorted(duplicate_groups.values(), key=lambda ids: sorted(ids))],
        },
        "nearestNeighbor": {
            "normalized": True,
            "minimum": rounded(min(nearest)),
            "median": rounded(median(nearest)),
            "percentiles": {
                "p10": rounded(percentile(nearest, 0.10)),
                "p25": rounded(percentile(nearest, 0.25)),
                "p50": rounded(percentile(nearest, 0.50)),
                "p75": rounded(percentile(nearest, 0.75)),
                "p90": rounded(percentile(nearest, 0.90)),
                "p95": rounded(percentile(nearest, 0.95)),
            },
        },
        "featureStats": feature_stats,
        "familyBalance": {
            "counts": dict(sorted(family_counts.items())),
            "minimum": minimum,
            "maximum": maximum,
            "ratio": rounded(minimum / maximum),
        },
        "_centroids": centroids,
        "_rows": row_by_id,
    }


def public_analysis(analysis: dict) -> dict:
    return {key: value for key, value in analysis.items() if not key.startswith("_")}


def centroid_deltas(candidate: dict, canonical: dict) -> dict:
    candidate_centroids = candidate["_centroids"]
    canonical_centroids = canonical["_centroids"]
    common = sorted(set(candidate_centroids) & set(canonical_centroids))
    per_family = {}
    for family_id in common:
        deltas = {
            key: rounded(abs(candidate_centroids[family_id][key] - canonical_centroids[family_id][key]))
            for key in FEATURE_KEYS
        }
        per_family[family_id] = {
            "perFeatureAbsolute": deltas,
            "maxAbsolute": max(deltas.values()),
            "l2": rounded(math.sqrt(sum(value * value for value in deltas.values()))),
        }
    return {
        "commonFamilyIds": common,
        "aligned": bool(common),
        "perFamily": per_family,
        "maximumAbsolute": max(
            (entry["maxAbsolute"] for entry in per_family.values()),
            default=None,
        ),
    }


def file_identity(path: Path, label: str) -> dict:
    data = path.read_bytes()
    return {"path": label, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def deterministic_identity(candidate_pack: Path, rerun_pack: Path, candidate_landmarks: Path | None, rerun_landmarks: Path | None) -> dict:
    if not candidate_pack.is_file() or not rerun_pack.is_file():
        return {
            "status": "unavailable",
            "reasons": ["candidate or deterministic rerun pack is missing"],
        }
    pack_identity = {
        "candidate": file_identity(candidate_pack, "candidate"),
        "rerun": file_identity(rerun_pack, "rerun"),
        "byteIdentical": candidate_pack.read_bytes() == rerun_pack.read_bytes(),
    }
    result = {
        "status": "pass" if pack_identity["byteIdentical"] else "warn",
        "reasons": [] if pack_identity["byteIdentical"] else ["candidate and rerun pack bytes differ"],
        "pack": pack_identity,
    }
    if candidate_landmarks is None or rerun_landmarks is None:
        result["status"] = "warn"
        result["reasons"].append("landmark rerun paths were not supplied")
        return result
    if not candidate_landmarks.is_file() or not rerun_landmarks.is_file():
        result["status"] = "unavailable"
        result["reasons"].append("candidate or deterministic rerun landmark file is missing")
        return result
    result["landmarks"] = {
        "candidate": file_identity(candidate_landmarks, "candidate"),
        "rerun": file_identity(rerun_landmarks, "rerun"),
        "byteIdentical": candidate_landmarks.read_bytes() == rerun_landmarks.read_bytes(),
    }
    if not result["landmarks"]["byteIdentical"]:
        result["status"] = "warn"
        result["reasons"].append("candidate and rerun landmark bytes differ")
    return result


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ComparisonError(f"{path} must contain a JSON object")
    return value


def infer_landmarks(pack_path: Path) -> Path:
    if pack_path.name == "gnm-morphology-pack.json":
        return pack_path.with_name("gnm-landmarks.json")
    return pack_path.with_name(pack_path.name.replace("gnm-morphology-pack-", "gnm-landmarks-"))


def unavailable(path: str, reason: str) -> dict:
    return {"path": path, "status": "unavailable", "reasons": [reason]}


def compare(
    candidate_pack: Path,
    canonical_pack: Path,
    candidate_landmarks: Path | None = None,
    canonical_landmarks: Path | None = None,
    rerun_pack: Path | None = None,
    rerun_landmarks: Path | None = None,
    expected_count: int | None = None,
    unavailable_reason: str | None = None,
    min_nearest_neighbor: float = DEFAULT_MIN_NEAREST_NEIGHBOR,
    max_duplicates: int = DEFAULT_MAX_DUPLICATES,
    min_family_balance: float = DEFAULT_MIN_FAMILY_BALANCE,
    max_centroid_delta: float = DEFAULT_MAX_CENTROID_DELTA,
) -> dict:
    thresholds = {
        "minNormalizedNearestNeighbor": min_nearest_neighbor,
        "maxExactDuplicateVectors": max_duplicates,
        "minFamilyBalanceRatio": min_family_balance,
        "maxCommonFamilyCentroidDelta": max_centroid_delta,
        "canonicalGateUnchanged": "tools/gnm/test_gnm_quality.py remains the 200-sample acceptance gate",
    }
    try:
        canonical_landmarks = canonical_landmarks or infer_landmarks(canonical_pack)
        canonical = analyze_pack(load_json(canonical_pack), load_json(canonical_landmarks), "canonical")
    except (OSError, json.JSONDecodeError, ComparisonError) as error:
        return {
            "schema": SCHEMA,
            "status": "unavailable",
            "reasons": [f"canonical metrics unavailable: {error}"],
            "thresholds": thresholds,
            "canonical": unavailable("canonical", str(error)),
            "candidates": [],
        }

    candidate_landmarks = candidate_landmarks or infer_landmarks(candidate_pack)
    if unavailable_reason:
        candidate_result = unavailable(str(candidate_pack), unavailable_reason)
    else:
        try:
            candidate_data = analyze_pack(
                load_json(candidate_pack),
                load_json(candidate_landmarks),
                "candidate",
                expected_count,
            )
            candidate_data["centroidDeltasAgainstCanonical"] = centroid_deltas(candidate_data, canonical)
            candidate_result = public_analysis(candidate_data)
        except (OSError, json.JSONDecodeError, ComparisonError) as error:
            candidate_result = unavailable("candidate", f"candidate metrics unavailable: {error}")

    reasons = list(candidate_result.get("reasons", []))
    if candidate_result.get("status") != "unavailable":
        duplicate_count = candidate_result["exactDuplicateFeatureVectors"]["count"]
        nearest_minimum = candidate_result["nearestNeighbor"]["minimum"]
        family_ratio = candidate_result["familyBalance"]["ratio"]
        centroid_delta = candidate_result["centroidDeltasAgainstCanonical"]["maximumAbsolute"]
        if duplicate_count > max_duplicates:
            reasons.append(f"exact duplicate feature vectors={duplicate_count} exceeds {max_duplicates}")
        if nearest_minimum < min_nearest_neighbor:
            reasons.append(f"minimum normalized nearest-neighbor distance={nearest_minimum} is below {min_nearest_neighbor}")
        if family_ratio < min_family_balance:
            reasons.append(f"family balance ratio={family_ratio} is below {min_family_balance}")
        if centroid_delta is not None and centroid_delta > max_centroid_delta:
            reasons.append(f"maximum common-family centroid delta={centroid_delta} exceeds {max_centroid_delta}")
        if any(value["range"] == 0 or value["variance"] == 0 for value in candidate_result["featureStats"].values()):
            reasons.append("at least one feature has zero range or variance")
        candidate_result["reasons"] = sorted(set(reasons))
        candidate_result["status"] = "warn" if candidate_result["reasons"] else "pass"

    deterministic = deterministic_identity(
        candidate_pack,
        rerun_pack,
        candidate_landmarks,
        rerun_landmarks,
    ) if rerun_pack else {
        "status": "unavailable",
        "reasons": ["deterministic rerun pack was not supplied"],
    }
    top_status = "unavailable" if candidate_result["status"] == "unavailable" else (
        "warn" if candidate_result["status"] == "warn" or deterministic["status"] == "warn" else "pass"
    )
    return {
        "schema": SCHEMA,
        "status": top_status,
        "scope": "scale comparison only; no promotion, runtime change, anatomy proof, or human review replacement",
        "requestedCount": expected_count,
        "thresholds": thresholds,
        "canonical": public_analysis(canonical),
        "candidates": [candidate_result],
        "deterministicRerun": deterministic,
        "reasons": sorted(set(reasons + deterministic.get("reasons", []))),
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-pack", type=Path, required=True)
    parser.add_argument("--candidate-landmarks", type=Path)
    parser.add_argument("--rerun-candidate-pack", type=Path)
    parser.add_argument("--rerun-candidate-landmarks", type=Path)
    parser.add_argument("--canonical-pack", type=Path, required=True)
    parser.add_argument("--canonical-landmarks", type=Path)
    parser.add_argument("--count", type=int, help="expected candidate sample count recorded as metadata")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--unavailable-reason")
    parser.add_argument("--min-nearest-neighbor", type=float, default=DEFAULT_MIN_NEAREST_NEIGHBOR)
    parser.add_argument("--max-duplicates", type=int, default=DEFAULT_MAX_DUPLICATES)
    parser.add_argument("--min-family-balance", type=float, default=DEFAULT_MIN_FAMILY_BALANCE)
    parser.add_argument("--max-centroid-delta", type=float, default=DEFAULT_MAX_CENTROID_DELTA)
    parser.add_argument("--strict", action="store_true", help="return nonzero when the report status is warn")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report = compare(
        args.candidate_pack,
        args.canonical_pack,
        args.candidate_landmarks,
        args.canonical_landmarks,
        args.rerun_candidate_pack,
        args.rerun_candidate_landmarks,
        args.count,
        args.unavailable_reason,
        args.min_nearest_neighbor,
        args.max_duplicates,
        args.min_family_balance,
        args.max_centroid_delta,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=True, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"GNM scale comparison: {report['status']} -> {args.output}")
    if report["status"] == "unavailable":
        print("No candidate metrics were invented; see report reasons.")
    return 1 if args.strict and report["status"] == "warn" else 0


if __name__ == "__main__":
    raise SystemExit(main())
