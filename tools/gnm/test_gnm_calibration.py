#!/usr/bin/env python3
"""Deterministic tests for Phase 7B offline calibration validation."""

from __future__ import annotations

import hashlib
import contextlib
import io
import json
import math
from pathlib import Path
import sys
import tempfile

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parents[1]
sys.path.insert(0, str(TOOLS))

import calibration_dataset
import validate_gnm_calibration as validator


FACE_CODE = "SF2~sports/default-v2~m0uth~1ai~epw9f3~m~n~b91c1c~f8fafc~1uf7aoh"
COEFFICIENTS = ["-0.25", "-0.1", "0", "0.1", "0.25", "0.2", "-0.2", "0.05"]
PROTECTED_FILES = (
    "src/face-model.js", "src/app.js", "src/webgl-renderer.js", "src/render-router.js", "src/app.bundle.js",
    "tools/gnm/work/gnm-official-head.glb", "tools/gnm/work/gnm-official-head.json",
    "tools/gnm/work/gnm-official-head-render.glb", "tools/gnm/work/gnm-official-basis-lab.bin",
    "tools/gnm/work/gnm-official-basis-lab.json", "tools/gnm/work/gnm-calibration-dataset.json",
)


def protected_hashes() -> dict[str, str]:
    return {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in PROTECTED_FILES}


def assert_failure(action) -> None:
    try:
        action()
    except (calibration_dataset.CalibrationDatasetError, validator.CalibrationValidationError):
        return
    raise AssertionError("invalid calibration fixture unexpectedly passed")


def face_code(seed: int) -> str:
    parts = FACE_CODE.split("~")
    parts[4] = calibration_dataset.base36(seed)
    return "~".join(parts[:9]) + "~" + calibration_dataset.sf2_checksum("~".join(parts[:9]))


def varying_coefficients(index: int) -> list[float]:
    return [((index + vector) % 11 - 5) / 20 for vector in range(8)]


def build_fixture(path: Path, sample_count: int = 1, *, diverse: bool = True) -> dict:
    calibration_dataset.init_dataset(path)
    for index in range(sample_count):
        sample_id = f"fixture-{index:03d}"
        calibration_dataset.add_sample(
            path,
            sample_id,
            face_code(index + 1 if diverse else 1),
            varying_coefficients(index),
            f"label-{index % 3}",
            status="reviewed",
            human_approved=True,
        )
    return calibration_dataset.validate(path)


def main() -> int:
    before = protected_hashes()
    with tempfile.TemporaryDirectory(prefix="gnm-calibration-validation-", dir=ROOT) as temporary:
        directory = Path(temporary)
        empty_path = directory / "empty.json"
        empty_output = directory / "empty-report.json"
        calibration_dataset.init_dataset(empty_path)
        empty_data = validator.validate_source(empty_path)
        first = validator.build_report(empty_data)
        second = validator.build_report(empty_data)
        assert first == second, "empty report is not deterministic"
        validator.write_report(empty_output, first)
        assert json.loads(empty_output.read_text(encoding="utf-8")) == first
        assert first["status"] == "insufficient_data"
        assert first["counts"] == {
            "total": 0, "train": 0, "validation": 0, "approved": 0, "reviewed": 0,
            "unreviewed": 0, "uncertain": 0, "rejected": 0, "approvedReviewed": 0,
            "distinctFaceCodes": 0, "distinctSeeds": 0, "distinctLabels": 0,
        }
        assert first["metrics"]["coefficientStats"] == {}
        assert "r2HeldOut" not in first["metrics"]["predictiveMetrics"]
        assert first["mappingSafety"] == {
            "semanticMapping": "unestablished", "runtimeBasisLoaded": False, "mappingActivation": False,
        }
        assert first["missingEvidence"], "empty report must identify missing evidence"
        assert not any(Path(value).is_absolute() for value in json.dumps(first).split('"'))

        small_path = directory / "small.json"
        small = validator.build_report(build_fixture(small_path, 3))
        assert small["status"] == "insufficient_data"
        assert small["counts"]["total"] == 3
        assert small["metrics"]["coefficientStats"]["head_000"]["count"] == 3
        assert small["checks"]["minimumSampleCounts"]["passed"] is False

        sufficient_path = directory / "sufficient.json"
        sufficient_data = build_fixture(sufficient_path, 60)
        sufficient = validator.build_report(sufficient_data)
        assert sufficient["status"] == "ready_for_human_review"
        assert sufficient["counts"]["total"] == 60
        assert sufficient["counts"]["train"] == 43
        assert sufficient["counts"]["validation"] == 17
        assert sufficient["counts"]["approvedReviewed"] == 60
        assert sufficient["counts"]["distinctSeeds"] == 60
        assert sufficient["counts"]["distinctFaceCodes"] == 60
        stats = sufficient["metrics"]["coefficientStats"]["head_000"]
        expected_values = [coefficients[0] for coefficients in (varying_coefficients(index) for index in range(60))]
        expected_mean = math.fsum(expected_values) / len(expected_values)
        expected_variance = math.fsum((value - expected_mean) ** 2 for value in expected_values) / len(expected_values)
        assert stats["count"] == 60 and stats["min"] == -0.25 and stats["max"] == 0.25
        assert stats["mean"] == expected_mean
        assert stats["variance"] == expected_variance and stats["std"] == math.sqrt(expected_variance)
        assert stats["variance"] > 0 and stats["std"] > 0
        assert sufficient["checks"]["splitIntegrity"]["passed"] is True
        assert sufficient["checks"]["coefficientBounds"]["passed"] is True
        assert sufficient["checks"]["sampleApproval"]["passed"] is True
        assert sufficient["checks"]["datasetApproval"]["passed"] is False
        assert sufficient["mappingSafety"] == {
            "semanticMapping": "unestablished", "runtimeBasisLoaded": False, "mappingActivation": False,
        }
        assert sufficient["futureMappingCriteria"]["heldOutR2"]["status"] == "not_available"

        report_path = directory / "report.json"
        validator.write_report(report_path, sufficient)
        persisted = json.loads(report_path.read_text(encoding="utf-8"))
        assert validator.verify_report_hash(persisted)
        assert persisted["reportHashSha256"] == validator.report_hash(persisted)
        tampered = json.loads(report_path.read_text(encoding="utf-8"))
        tampered["counts"]["total"] += 1
        assert_failure(lambda: validator.verify_report_hash(tampered))

        source_before_collision = sufficient_path.read_bytes()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            collision_result = validator.main(["validate", "--dataset", str(sufficient_path), "--output", str(sufficient_path)])
        assert collision_result == 1
        assert sufficient_path.read_bytes() == source_before_collision
        assert validator.validate_source(sufficient_path)["datasetHashSha256"] == sufficient_data["datasetHashSha256"]

        diversity_path = directory / "insufficient-diversity.json"
        diversity = validator.build_report(build_fixture(diversity_path, 60, diverse=False))
        assert diversity["status"] == "insufficient_data"
        assert diversity["counts"]["train"] == 43 and diversity["counts"]["validation"] == 17
        assert diversity["counts"]["distinctSeeds"] == 1
        assert diversity["counts"]["distinctFaceCodes"] == 1
        assert diversity["checks"]["minimumSampleCounts"]["passed"] is False

        invalid = json.loads(sufficient_path.read_text(encoding="utf-8"))
        invalid["samples"][0]["basisCoefficients"][0] = 0.26
        invalid["datasetHashSha256"] = calibration_dataset.content_hash(invalid)
        invalid_path = directory / "invalid.json"
        invalid_path.write_bytes(calibration_dataset.canonical_json(invalid))
        assert_failure(lambda: validator.validate_source(invalid_path))

        unapproved = json.loads(sufficient_path.read_text(encoding="utf-8"))
        for sample in unapproved["samples"][:41]:
            sample["humanApproved"] = False
        unapproved["datasetHashSha256"] = calibration_dataset.content_hash(unapproved)
        unapproved_path = directory / "unapproved.json"
        unapproved_path.write_bytes(calibration_dataset.canonical_json(unapproved))
        unapproved_report = validator.build_report(validator.validate_source(unapproved_path))
        assert unapproved_report["status"] == "insufficient_data"
        assert unapproved_report["counts"]["approvedReviewed"] == 19

        assert protected_hashes() == before, "validator/tests changed runtime, assets, or checked-in dataset"
    print("PASS GNM calibration validation: deterministic empty report, stats, gates, hashes, safety boundaries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
