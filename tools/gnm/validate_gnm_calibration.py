#!/usr/bin/env python3
"""Offline statistical validation for the Phase 7A GNM calibration dataset.

This tool validates the Phase 7A contract before calculating descriptive
statistics. It never writes the dataset, loads runtime assets, or activates a
semantic mapping.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATASET = ROOT / "tools/gnm/work/gnm-calibration-dataset.json"
DEFAULT_OUTPUT = ROOT / "tools/gnm/work/gnm-calibration-validation.json"
REPORT_SCHEMA = "sports-face-gnm-calibration-validation/v1"
REPORT_VERSION = 1

MIN_TRAIN = 40
MIN_VALIDATION = 10
MIN_APPROVED_REVIEWED = 20
MIN_DISTINCT_SEEDS = 5
MIN_DISTINCT_FACE_CODES = 5
HELD_OUT_R2_THRESHOLD = 0.80


class CalibrationValidationError(ValueError):
    """Raised when the source dataset cannot be validated."""


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=True, indent=2, sort_keys=True) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def report_hash(report: dict[str, Any]) -> str:
    unsigned = {key: value for key, value in report.items() if key != "reportHashSha256"}
    return sha256_bytes(canonical_json(unsigned))


def verify_report_hash(report: dict[str, Any]) -> bool:
    declared = report.get("reportHashSha256")
    if not isinstance(declared, str) or declared != report_hash(report):
        raise CalibrationValidationError("reportHashSha256 does not match deterministic report content")
    return True


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CalibrationValidationError(f"cannot read calibration dataset: {error}") from error
    if not isinstance(value, dict):
        raise CalibrationValidationError("calibration dataset root must be an object")
    return value


def load_dataset_module():
    tools_dir = str(Path(__file__).resolve().parent)
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    import calibration_dataset

    return calibration_dataset


def validate_source(dataset_path: Path) -> dict[str, Any]:
    calibration_dataset = load_dataset_module()
    try:
        data = calibration_dataset.validate(dataset_path, ROOT)
    except (calibration_dataset.CalibrationDatasetError, OSError, TypeError, ValueError) as error:
        raise CalibrationValidationError(f"Phase 7A contract validation failed: {error}") from error
    return data


def count_values(samples: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "total": len(samples),
        "train": sum(sample["split"] == "train" for sample in samples),
        "validation": sum(sample["split"] == "validation" for sample in samples),
        "approved": sum(sample["humanApproved"] is True for sample in samples),
        "reviewed": sum(sample["status"] == "reviewed" for sample in samples),
        "unreviewed": sum(sample["status"] == "unreviewed" for sample in samples),
        "uncertain": sum(sample["status"] == "uncertain" for sample in samples),
        "rejected": sum(sample["status"] == "rejected" for sample in samples),
        "approvedReviewed": sum(sample["humanApproved"] is True and sample["status"] == "reviewed" for sample in samples),
        "distinctFaceCodes": len({sample["faceDNA"]["code"] for sample in samples}),
        "distinctSeeds": len({sample["faceDNA"]["seed"] for sample in samples}),
        "distinctLabels": len({sample["label"] for sample in samples}),
    }


def coefficient_stats(samples: list[dict[str, Any]], vectors: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    if not samples:
        return {}
    result: dict[str, dict[str, Any]] = {}
    for index, vector in enumerate(vectors):
        values = [float(sample["basisCoefficients"][index]) for sample in samples]
        count = len(values)
        mean = math.fsum(values) / count
        variance = math.fsum((value - mean) ** 2 for value in values) / count
        result[vector["name"]] = {
            "count": count,
            "min": min(values),
            "max": max(values),
            "mean": mean,
            "variance": variance,
            "std": math.sqrt(variance),
            "trainCount": sum(sample["split"] == "train" for sample in samples),
            "validationCount": sum(sample["split"] == "validation" for sample in samples),
        }
    return result


def gate(status: str, passed: bool, reason: str, observed: Any = None, required: Any = None) -> dict[str, Any]:
    result: dict[str, Any] = {"status": status, "passed": passed, "reason": reason}
    if observed is not None:
        result["observed"] = observed
    if required is not None:
        result["required"] = required
    return result


def build_missing_evidence(counts: dict[str, int], data: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    if counts["total"] == 0:
        missing.append("real human-reviewed calibration samples")
    if counts["train"] < MIN_TRAIN:
        missing.append(f"at least {MIN_TRAIN} train samples")
    if counts["validation"] < MIN_VALIDATION:
        missing.append(f"at least {MIN_VALIDATION} validation samples")
    if counts["approvedReviewed"] < MIN_APPROVED_REVIEWED:
        missing.append(f"at least {MIN_APPROVED_REVIEWED} human-approved reviewed samples")
    if counts["distinctSeeds"] < MIN_DISTINCT_SEEDS:
        missing.append(f"at least {MIN_DISTINCT_SEEDS} distinct seeds")
    if counts["distinctFaceCodes"] < MIN_DISTINCT_FACE_CODES:
        missing.append(f"at least {MIN_DISTINCT_FACE_CODES} distinct face codes")
    missing.extend((
        "paired target outcomes, if R²/correlation analysis is intended",
        "held-out R² >= 0.80 when target outcomes exist",
        "cross-validation evidence",
        "bilateral consistency evidence",
        "causal one-hot test evidence",
        "negative-control evidence",
        "explicit human approval for any future mapping",
        "versioned mapping metadata and provenance",
    ))
    if data.get("humanApproved") is not True:
        missing.append("dataset-level human approval remains false by the Phase 7A safety contract")
    return missing


def build_report(data: dict[str, Any]) -> dict[str, Any]:
    samples = data["samples"]
    vectors = data["vectorSelection"]["vectors"]
    counts = count_values(samples)
    enough_data = (
        counts["train"] >= MIN_TRAIN
        and counts["validation"] >= MIN_VALIDATION
        and counts["approvedReviewed"] >= MIN_APPROVED_REVIEWED
        and counts["distinctSeeds"] >= MIN_DISTINCT_SEEDS
        and counts["distinctFaceCodes"] >= MIN_DISTINCT_FACE_CODES
    )
    split_integrity = counts["train"] + counts["validation"] == counts["total"]
    coefficient_bounds = all(
        -0.25 <= float(value) <= 0.25
        for sample in samples
        for value in sample["basisCoefficients"]
    )
    if not enough_data:
        status = "insufficient_data"
    elif not split_integrity or not coefficient_bounds:
        status = "not_ready"
    else:
        status = "ready_for_human_review"

    source_assets = [
        {"name": asset["name"], "path": asset["path"], "sha256": asset["sha256"]}
        for asset in data["sourceAssets"]
    ]
    report: dict[str, Any] = {
        "schema": REPORT_SCHEMA,
        "version": REPORT_VERSION,
        "status": status,
        "source": {
            "datasetHashSha256": data["datasetHashSha256"],
            "evidenceBaseRevision": data["evidenceBaseRevision"],
            "basisSelectionHash": data["vectorSelection"]["basisSelectionHash"],
            "sourceAssets": source_assets,
        },
        "mappingSafety": {
            "semanticMapping": "unestablished",
            "runtimeBasisLoaded": False,
            "mappingActivation": False,
        },
        "counts": counts,
        "metrics": {
            "coefficientStats": coefficient_stats(samples, vectors),
            "predictiveMetrics": {
                "available": False,
                "reason": "Phase 7A contains no target outcomes; no R² or correlation is fabricated.",
            },
        },
        "checks": {
            "splitIntegrity": gate("passed" if split_integrity else "failed", split_integrity, "validated Phase 7A split policy"),
            "coefficientBounds": gate("passed" if coefficient_bounds else "failed", coefficient_bounds, "all coefficients are within [-0.25, 0.25]"),
            "sampleApproval": gate(
                "passed" if counts["approvedReviewed"] >= MIN_APPROVED_REVIEWED else "insufficient_data",
                counts["approvedReviewed"] >= MIN_APPROVED_REVIEWED,
                "human-approved reviewed samples are required before statistical readiness",
                counts["approvedReviewed"],
                MIN_APPROVED_REVIEWED,
            ),
            "datasetApproval": gate(
                "pending",
                False,
                "dataset humanApproved must remain false; mapping approval is never inferred",
                data["humanApproved"],
                True,
            ),
            "minimumSampleCounts": gate(
                "passed" if enough_data else "insufficient_data",
                enough_data,
                "conservative minimum sample and diversity thresholds",
                {
                    "train": counts["train"],
                    "validation": counts["validation"],
                    "approvedReviewed": counts["approvedReviewed"],
                    "distinctSeeds": counts["distinctSeeds"],
                    "distinctFaceCodes": counts["distinctFaceCodes"],
                },
                {
                    "train": MIN_TRAIN,
                    "validation": MIN_VALIDATION,
                    "approvedReviewed": MIN_APPROVED_REVIEWED,
                    "distinctSeeds": MIN_DISTINCT_SEEDS,
                    "distinctFaceCodes": MIN_DISTINCT_FACE_CODES,
                },
            ),
        },
        "futureMappingCriteria": {
            "minimumSampleCounts": {
                "train": MIN_TRAIN,
                "validation": MIN_VALIDATION,
                "humanApprovedReviewed": MIN_APPROVED_REVIEWED,
                "distinctSeeds": MIN_DISTINCT_SEEDS,
                "distinctFaceCodes": MIN_DISTINCT_FACE_CODES,
            },
            "heldOutR2": {"threshold": HELD_OUT_R2_THRESHOLD, "condition": "only when target outcomes exist", "status": "not_available"},
            "crossValidation": {"status": "missing"},
            "bilateralConsistency": {"status": "missing"},
            "causalOneHotTests": {"status": "missing"},
            "negativeControls": {"status": "missing"},
            "humanApproval": {"status": "pending", "mappingActivation": False},
            "versionedMappingMetadata": {"status": "missing"},
        },
        "missingEvidence": build_missing_evidence(counts, data),
    }
    report["reportHashSha256"] = report_hash(report)
    return report


def write_report(output: Path, report: dict[str, Any]) -> None:
    verify_report_hash(report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(canonical_json(report))


def ensure_distinct_paths(dataset: Path, output: Path) -> None:
    if dataset.resolve() == output.resolve():
        raise CalibrationValidationError("report output must not overwrite the dataset input")


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description=__doc__)
    subparsers = command.add_subparsers(dest="command", required=True)
    validate = subparsers.add_parser("validate", help="validate Phase 7A and write a deterministic statistical report")
    validate.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    validate.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return command


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        ensure_distinct_paths(args.dataset, args.output)
        data = validate_source(args.dataset)
        report = build_report(data)
        write_report(args.output, report)
        print(f"PASS GNM calibration validation: {report['status']} ({report['counts']['total']} samples)")
        return 0
    except (CalibrationValidationError, OSError, TypeError, ValueError) as error:
        print(f"FAIL GNM calibration validation: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
