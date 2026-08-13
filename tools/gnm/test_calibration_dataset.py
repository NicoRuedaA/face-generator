#!/usr/bin/env python3
"""Focused deterministic tests for the Phase 7A calibration dataset contract."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import tempfile

from calibration_dataset import (
    DEFAULT_DATASET,
    DEFAULT_BASIS_METADATA,
    ROOT,
    CalibrationDatasetError,
    add_sample,
    basis_selection_hash,
    init_dataset,
    parse_sf2,
    split_dataset,
    validate,
)


FACE_CODE = "SF2~sports/default-v2~m0uth~1ai~epw9f3~m~n~b91c1c~f8fafc~1uf7aoh"
COEFFICIENTS = ["-0.25", "-0.1", "0", "0.1", "0.25", "0.2", "-0.2", "0.05"]
PROTECTED_FILES = (
    "src/face-model.js", "src/app.js", "src/webgl-renderer.js", "src/render-router.js", "src/app.bundle.js",
    "tools/gnm/work/gnm-official-head.glb", "tools/gnm/work/gnm-official-head.json",
    "tools/gnm/work/gnm-official-head-render.glb", "tools/gnm/work/gnm-official-basis-lab.bin",
    "tools/gnm/work/gnm-official-basis-lab.json",
)


def hashes() -> dict[str, str]:
    return {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in PROTECTED_FILES}


def expect_failure(action) -> None:
    try:
        action()
    except CalibrationDatasetError:
        return
    raise AssertionError("invalid calibration data unexpectedly passed")


def checksum_valid_variant(*parts: str) -> str:
    from calibration_dataset import sf2_checksum
    payload = "~".join(parts)
    return f"{payload}~{sf2_checksum(payload)}"


def main() -> int:
    before = hashes()
    with tempfile.TemporaryDirectory(prefix="gnm-calibration-", dir=ROOT) as temporary:
        directory = Path(temporary)
        first = directory / "first.json"
        second = directory / "second.json"
        init_dataset(first)
        init_dataset(second)
        assert first.read_bytes() == second.read_bytes(), "init output is not deterministic"
        empty = validate(first)
        assert empty["samples"] == []
        assert empty["humanApproved"] is False
        assert empty["semanticMapping"] == "unestablished"
        assert empty["runtimeBasisLoaded"] is False
        assert len(empty["vectorSelection"]["vectors"]) == 8
        assert empty["vectorSelection"]["basisSelectionHash"] == basis_selection_hash(empty["vectorSelection"]["vectors"])
        assert re.fullmatch(r"[0-9a-f]{64}", empty["datasetHashSha256"])
        variant = checksum_valid_variant("SF2", "sports/default-v2", "00M0UTH", "001AI", "0EPW9F3", "0M", "n", "B91C1C", "F8FAFC")
        assert parse_sf2(variant)["code"] == FACE_CODE, "valid noncanonical SF2 must normalize"

        add_sample(first, "sample-002", FACE_CODE, COEFFICIENTS, "review-needed", "Technical review only", "technical")
        add_sample(second, "sample-002", FACE_CODE, COEFFICIENTS, "review-needed", "Technical review only", "technical")
        add_sample(first, "sample-variant", variant, COEFFICIENTS, "normalized review")
        add_sample(second, "sample-variant", variant, COEFFICIENTS, "normalized review")
        assert first.read_bytes() == second.read_bytes(), "add output is not deterministic"
        sample = json.loads(first.read_text(encoding="utf-8"))["samples"][0]
        assert sample["humanApproved"] is False
        assert sample["basisVectorNames"] == [item["name"] for item in empty["vectorSelection"]["vectors"]]
        assert sample["split"] in ("train", "validation")
        assert json.loads(first.read_text(encoding="utf-8"))["samples"][1]["faceDNA"]["code"] == FACE_CODE.replace("~n~", "~n~")
        expect_failure(lambda: add_sample(first, "sample-002", FACE_CODE, COEFFICIENTS, "duplicate"))
        expect_failure(lambda: add_sample(first, "sample-bad", FACE_CODE[:-1] + "x", COEFFICIENTS, "invalid"))
        expect_failure(lambda: add_sample(first, "sample-range", FACE_CODE, ["0.26"] + COEFFICIENTS[1:], "range"))
        expect_failure(lambda: add_sample(first, "sample-string-approval", FACE_CODE, COEFFICIENTS, "safe", human_approved="false"))
        expect_failure(lambda: add_sample(first, "sample-int-approval", FACE_CODE, COEFFICIENTS, "safe", human_approved=1))
        add_sample(first, "sample-approved", FACE_CODE, ["0.3"] * 8, "approved technical label", human_approved=True, clamp=True, status="reviewed")
        approved = next(sample for sample in json.loads(first.read_text(encoding="utf-8"))["samples"] if sample["sampleId"] == "sample-approved")
        assert approved["humanApproved"] is True
        assert approved["basisCoefficients"] == [0.25] * 8

        original = first.read_bytes()
        train = directory / "train.json"
        validation = directory / "validation.json"
        split_dataset(first, train, validation)
        assert first.read_bytes() == original, "split modified the source dataset"
        train_again = directory / "train-again.json"
        validation_again = directory / "validation-again.json"
        split_dataset(first, train_again, validation_again)
        assert train.read_bytes() == train_again.read_bytes()
        assert validation.read_bytes() == validation_again.read_bytes()
        assert validate(train)["projection"]["split"] == "train"
        assert validate(validation)["projection"]["split"] == "validation"
        expect_failure(lambda: split_dataset(first, first, validation))
        expect_failure(lambda: split_dataset(first, train, train))
        expect_failure(lambda: split_dataset(first, directory / "alias" / ".." / "first.json", validation))

        unsafe = json.loads(first.read_text(encoding="utf-8"))
        unsafe["sourceAssets"][0]["path"] = "/tmp/secret.glb"
        expect_failure(lambda: validate_data_fixture(unsafe))
        unsafe = json.loads(first.read_text(encoding="utf-8"))
        unsafe["samples"][0]["email"] = "not-stored@example.invalid"
        expect_failure(lambda: validate_data_fixture(unsafe))
        unsafe = json.loads(first.read_text(encoding="utf-8"))
        unsafe["samples"][0]["metadata"] = {"review": {"contactEmail": "person@example.invalid"}}
        expect_failure(lambda: validate_data_fixture(unsafe))
        unsafe = json.loads(first.read_text(encoding="utf-8"))
        unsafe["samples"][0]["notes"] = "Call +1 (555) 123-4567"
        expect_failure(lambda: validate_data_fixture(unsafe))
        unsafe = json.loads(first.read_text(encoding="utf-8"))
        unsafe["samples"][0]["label"] = "../private"
        expect_failure(lambda: validate_data_fixture(unsafe))
        unsafe = json.loads(first.read_text(encoding="utf-8"))
        unsafe["samples"][0]["annotatorRole"] = "api_key=do-not-store"
        expect_failure(lambda: validate_data_fixture(unsafe))
    assert hashes() == before, "calibration tooling changed runtime or source assets"
    assert DEFAULT_DATASET.exists() and DEFAULT_BASIS_METADATA.exists()
    print("PASS calibration dataset: deterministic init/add/split, schema/hash/SF2/bounds/split/PII guards, approval defaults, protected-file hashes")
    return 0


def validate_data_fixture(value: dict) -> None:
    from calibration_dataset import validate_data
    validate_data(value)


if __name__ == "__main__":
    raise SystemExit(main())
