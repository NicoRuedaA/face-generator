#!/usr/bin/env python3
"""Deterministic, offline-only Phase 7A calibration dataset tooling.

The dataset stores metadata and human annotations only. It deliberately does
not embed geometry, basis arrays, images, personal data, or runtime mappings.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import re
import sys
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATASET = ROOT / "tools/gnm/work/gnm-calibration-dataset.json"
DEFAULT_CANONICAL = ROOT / "tools/gnm/work/gnm-official-head.glb"
DEFAULT_CANONICAL_METADATA = ROOT / "tools/gnm/work/gnm-official-head.json"
DEFAULT_RENDER = ROOT / "tools/gnm/work/gnm-official-head-render.glb"
DEFAULT_BASIS_PAYLOAD = ROOT / "tools/gnm/work/gnm-official-basis-lab.bin"
DEFAULT_BASIS_METADATA = ROOT / "tools/gnm/work/gnm-official-basis-lab.json"

SCHEMA = "sports-face-gnm-calibration-dataset/v1"
VERSION = 1
EVIDENCE_BASE_REVISION = "465f5cb"
COEFFICIENT_MIN = -0.25
COEFFICIENT_MAX = 0.25
SPLIT_VERSION = "sample-id-sha256-v1"
SPLIT_SEED = "phase-7a-calibration"
SPLIT_TRAIN_THRESHOLD = 8
EXPECTED_ASSETS = (
    ("canonicalGlb", "tools/gnm/work/gnm-official-head.glb"),
    ("canonicalMetadata", "tools/gnm/work/gnm-official-head.json"),
    ("renderGlb", "tools/gnm/work/gnm-official-head-render.glb"),
    ("basisLabPayload", "tools/gnm/work/gnm-official-basis-lab.bin"),
    ("basisLabMetadata", "tools/gnm/work/gnm-official-basis-lab.json"),
)
VECTOR_LABELS = (
    "GNM identity basis 000",
    "GNM identity basis 001",
    "GNM identity basis 002",
    "GNM identity basis 003",
    "GNM expression basis 000",
    "GNM expression basis 001",
    "GNM expression basis 002",
    "GNM expression basis 003",
)
SAMPLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
HEX_RE = re.compile(r"^[0-9a-f]{6}$")
BASE36_RE = re.compile(r"^[0-9a-z]+$", re.IGNORECASE)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
EMAIL_RE = re.compile(r"(?<![\w.+-])[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?![\w.-])")
PHONE_RE = re.compile(r"(?<!\w)\+?[0-9][0-9().\s-]{5,}[0-9](?!\w)")
CREDENTIAL_RE = re.compile(
    r"(?:\b(?:password|passwd|passcode|secret|api[_-]?key|access[_-]?token|auth(?:entication)?[_-]?token|private[_-]?key|client[_-]?secret)\b\s*[:=]"
    r"|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b|\b(?:sk|pk)_[A-Za-z0-9]{16,}\b)",
    re.IGNORECASE,
)
PII_KEYS = {
    "address", "birthdate", "dateofbirth", "dob", "email", "ipaddress",
    "latitude", "longitude", "nameofperson", "patient", "personaldata",
    "phone", "phonenumber", "realname", "subject", "username", "contactemail",
}

SF2_IDENTITY_VARS = ((0, 3, 6), (3, 3, 8), (6, 3, 6), (9, 3, 8), (12, 3, 8), (15, 3, 7), (18, 1, 2), (19, 2, 4), (21, 2, 4), (23, 3, 6), (26, 3, 6))
SF2_APPEARANCE_VARS = ((0, 4, 12), (4, 3, 6), (7, 3, 8), (10, 1, 2), (11, 1, 2), (12, 1, 2))


class CalibrationDatasetError(ValueError):
    """Raised when a dataset or annotation violates the Phase 7A contract."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CalibrationDatasetError(message)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    try:
        return sha256_bytes(path.read_bytes())
    except OSError as error:
        raise CalibrationDatasetError(f"source asset is not readable: {path}") from error


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=True, indent=2, sort_keys=True) + "\n").encode("utf-8")


def content_hash(value: dict[str, Any]) -> str:
    without_hash = {key: item for key, item in value.items() if key != "datasetHashSha256"}
    return sha256_bytes(canonical_json(without_hash))


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical_json(value))


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CalibrationDatasetError(f"cannot read JSON dataset {path}: {error}") from error
    require(isinstance(value, dict), "dataset root must be an object")
    return value


def base36(value: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    if value == 0:
        return "0"
    result = ""
    while value:
        value, remainder = divmod(value, 36)
        result = digits[remainder] + result
    return result


def parse_base36(value: str, label: str) -> int:
    require(bool(BASE36_RE.fullmatch(value)), f"{label} is invalid base36")
    parsed = int(value, 36)
    require(0 <= parsed <= 0xFFFFFFFF, f"{label} is outside uint32 range")
    return parsed


def fnv1a_utf16(text: str) -> int:
    # SF2 currently contains ASCII-only structural fields. This mirrors the
    # JavaScript hashSeed implementation for every UTF-16 code unit.
    encoded = text.encode("utf-16-le")
    value = 0x811C9DC5
    for offset in range(0, len(encoded), 2):
        code_unit = int.from_bytes(encoded[offset:offset + 2], "little")
        value ^= code_unit
        value = (value * 0x01000193) & 0xFFFFFFFF
    return value


def sf2_checksum(payload: str) -> str:
    return base36(fnv1a_utf16(payload)).rjust(7, "0")[-7:]


def sf2_set_bits(bits: int, offset: int, length: int, value: int) -> int:
    mask = (0xFFFFFFFF if length == 32 else (2**length - 1)) << offset
    return ((bits & ~mask) | ((value & (mask >> offset)) << offset)) & 0xFFFFFFFF


def sf2_get_bits(bits: int, offset: int, length: int) -> int:
    return (bits >> offset) & (0xFFFFFFFF if length == 32 else 2**length - 1)


def sf2_scale_bits(raw: int, length: int, valid_values: int) -> int:
    return (raw * valid_values) // (2**length)


def canonicalize_sf2_bits(identity_bits: int, appearance_bits: int, age: int) -> tuple[int, int]:
    identity_bits &= 0xFFFFFFFF
    appearance_bits &= 0xFFFFFFFF
    for offset, length, valid_values in SF2_IDENTITY_VARS:
        raw = sf2_get_bits(identity_bits, offset, length)
        if raw >= valid_values:
            identity_bits = sf2_set_bits(identity_bits, offset, length, sf2_scale_bits(raw, length, valid_values))
    for offset, length, valid_values in SF2_APPEARANCE_VARS:
        raw = sf2_get_bits(appearance_bits, offset, length)
        if raw >= valid_values:
            appearance_bits = sf2_set_bits(appearance_bits, offset, length, sf2_scale_bits(raw, length, valid_values))

    hair_visible = sf2_get_bits(appearance_bits, 10, 1)
    if hair_visible == 0 and sf2_get_bits(appearance_bits, 0, 4) != 0:
        appearance_bits = sf2_set_bits(appearance_bits, 0, 4, 0)
    if age < 18 and sf2_get_bits(appearance_bits, 4, 3) > 2:
        appearance_bits = sf2_set_bits(appearance_bits, 4, 3, 2)
    if hair_visible == 0 and sf2_get_bits(appearance_bits, 4, 3) == 0:
        appearance_bits = sf2_set_bits(appearance_bits, 7, 3, 0)
    return identity_bits, appearance_bits


def parse_sf2(code: str) -> dict[str, Any]:
    require(isinstance(code, str), "faceCode must be a string")
    parts = code.strip().split("~")
    require(len(parts) == 10 and parts[0] == "SF2", "faceCode must be an SF2 code")
    payload = "~".join(parts[:9])
    require(sf2_checksum(payload) == parts[9], "faceCode checksum is invalid")
    require(parts[1] == "sports/default-v2", "faceCode style is not the supported SF2 profile")
    identity_bits = parse_base36(parts[2], "identityBits")
    appearance_bits = parse_base36(parts[3], "appearanceBits")
    seed = parse_base36(parts[4], "seed")
    age = parse_base36(parts[5], "age")
    require(16 <= age <= 60, "faceCode age is outside 16..60")
    presentation = {"m": "masculine", "f": "feminine", "n": "neutral"}.get(parts[6])
    require(presentation is not None, "faceCode presentation is invalid")
    require(bool(re.fullmatch(r"#?[0-9a-f]{6}", parts[7], re.IGNORECASE)) and bool(re.fullmatch(r"#?[0-9a-f]{6}", parts[8], re.IGNORECASE)), "faceCode kit colors are invalid")
    identity_bits, appearance_bits = canonicalize_sf2_bits(identity_bits, appearance_bits, age)
    primary = parts[7].lower()
    secondary = parts[8].lower()
    canonical_payload = "~".join((
        "SF2", parts[1], base36(identity_bits), base36(appearance_bits), base36(seed),
        base36(age), parts[6], primary, secondary,
    ))
    canonical = f"{canonical_payload}~{sf2_checksum(canonical_payload)}"
    return {
        "code": canonical,
        "profileVersion": 2,
        "style": parts[1],
        "seed": seed,
        "age": age,
        "presentation": presentation,
        "identityBits": identity_bits,
        "appearanceBits": appearance_bits,
        "kitPrimary": f"#{primary}",
        "kitSecondary": f"#{secondary}",
    }


def expected_vectors(basis_metadata_path: Path) -> list[dict[str, Any]]:
    metadata = load_json(basis_metadata_path)
    selection = metadata.get("selection")
    require(isinstance(selection, dict), "Basis Lab selection is missing")
    vectors: list[dict[str, Any]] = []
    for family in ("identity", "expression"):
        values = selection.get(family)
        require(isinstance(values, list) and len(values) == 4, f"Basis Lab {family} selection must contain four vectors")
        for index, item in enumerate(values):
            require(isinstance(item, dict), "Basis Lab vector selection entry must be an object")
            require(item.get("family") == family and item.get("index") == index, "Basis Lab vector order is invalid")
            name = item.get("name")
            require(isinstance(name, str) and name, "Basis Lab vector name is invalid")
            vectors.append({"order": len(vectors), "family": family, "index": index, "name": name, "label": VECTOR_LABELS[len(vectors)]})
    return vectors


def basis_selection_hash(vectors: list[dict[str, Any]]) -> str:
    return sha256_bytes(json.dumps(vectors, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("utf-8"))


def source_records(root: Path, paths: tuple[Path, ...] | None = None) -> list[dict[str, str]]:
    actual = paths or (DEFAULT_CANONICAL, DEFAULT_CANONICAL_METADATA, DEFAULT_RENDER, DEFAULT_BASIS_PAYLOAD, DEFAULT_BASIS_METADATA)
    records = []
    for (name, relative), path in zip(EXPECTED_ASSETS, actual):
        require(path.resolve().is_relative_to(root.resolve()), f"source asset must be inside the repository: {path}")
        records.append({"name": name, "path": relative, "sha256": sha256_file(path)})
    return records


def split_for_sample(sample_id: str) -> str:
    digest = hashlib.sha256(f"{SPLIT_SEED}\0{sample_id}".encode("utf-8")).digest()
    bucket = int.from_bytes(digest[:4], "big") % 10
    return "train" if bucket < SPLIT_TRAIN_THRESHOLD else "validation"


def new_dataset(root: Path = ROOT, evidence_base_revision: str = EVIDENCE_BASE_REVISION) -> dict[str, Any]:
    vectors = expected_vectors(DEFAULT_BASIS_METADATA)
    data: dict[str, Any] = {
        "schema": SCHEMA,
        "version": VERSION,
        "datasetType": "offline-human-calibration-annotations",
        "semanticMapping": "unestablished",
        "runtimeBasisLoaded": False,
        "humanApproved": False,
        "evidenceBaseRevision": evidence_base_revision,
        "coefficientBounds": {"min": COEFFICIENT_MIN, "max": COEFFICIENT_MAX},
        "vectorSelection": {"vectors": vectors, "basisSelectionHash": basis_selection_hash(vectors)},
        "sourceAssets": source_records(root),
        "splitPolicy": {
            "version": SPLIT_VERSION,
            "seed": SPLIT_SEED,
            "algorithm": "SHA-256(UTF-8(seed + NUL + sampleId)); first four digest bytes as big-endian uint32; uint32 modulo 10 < 8 is train, otherwise validation",
            "trainPercent": 80,
            "validationPercent": 20,
        },
        "samples": [],
    }
    data["datasetHashSha256"] = content_hash(data)
    return data


def init_dataset(output: Path = DEFAULT_DATASET, root: Path = ROOT, evidence_base_revision: str = EVIDENCE_BASE_REVISION) -> dict[str, Any]:
    data = new_dataset(root, evidence_base_revision)
    write_json(output, data)
    return data


def key_token(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower())


def assert_safe_metadata(value: Any, path: str = "dataset") -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            require(key_token(str(key)) not in PII_KEYS, f"PII-like field is not allowed: {path}.{key}")
            assert_safe_metadata(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            assert_safe_metadata(item, f"{path}[{index}]")
    elif isinstance(value, str):
        require("\x00" not in value, f"NUL is not allowed: {path}")
        require(not value.startswith(("/", "\\", "~/")), f"absolute path is not allowed: {path}")
        require(re.match(r"^[A-Za-z]:[\\/]", value) is None, f"absolute path is not allowed: {path}")
        require(".." not in re.split(r"[/\\]", value), f"path traversal is not allowed: {path}")
        if not any(token in path.lower() for token in ("sha256", "hash")):
            require(EMAIL_RE.search(value) is None, f"email-like data is not allowed: {path}")
            require(PHONE_RE.search(value) is None, f"phone-like data is not allowed: {path}")
            require(CREDENTIAL_RE.search(value) is None, f"credential-like data is not allowed: {path}")


def validate(data_path: Path, root: Path = ROOT) -> dict[str, Any]:
    data = load_json(data_path)
    validate_data(data, root)
    return data


def validate_data(data: dict[str, Any], root: Path = ROOT) -> None:
    assert_safe_metadata(data)
    allowed = {"schema", "version", "datasetType", "semanticMapping", "runtimeBasisLoaded", "humanApproved", "evidenceBaseRevision", "coefficientBounds", "vectorSelection", "sourceAssets", "splitPolicy", "samples", "datasetHashSha256", "projection"}
    require(set(data) <= allowed, f"unknown dataset fields: {sorted(set(data) - allowed)}")
    require(data.get("schema") == SCHEMA and data.get("version") == VERSION, "dataset schema/version is invalid")
    require(data.get("datasetType") == "offline-human-calibration-annotations", "datasetType is invalid")
    require(data.get("semanticMapping") == "unestablished", "semanticMapping must remain unestablished")
    require(data.get("runtimeBasisLoaded") is False, "runtimeBasisLoaded must remain false")
    require(data.get("humanApproved") is False, "dataset humanApproved must default to false")
    require(isinstance(data.get("evidenceBaseRevision"), str) and data["evidenceBaseRevision"], "evidenceBaseRevision is required")
    require(data.get("coefficientBounds") == {"min": COEFFICIENT_MIN, "max": COEFFICIENT_MAX}, "coefficient bounds are invalid")

    vectors = data.get("vectorSelection", {}).get("vectors")
    require(isinstance(vectors, list) and len(vectors) == 8, "vector selection must contain eight vectors")
    require([item.get("label") for item in vectors] == list(VECTOR_LABELS), "vector labels/order are invalid")
    require(basis_selection_hash(vectors) == data.get("vectorSelection", {}).get("basisSelectionHash"), "basisSelectionHash does not match vector selection")
    current_vectors = expected_vectors(DEFAULT_BASIS_METADATA)
    require(vectors == current_vectors, "vector selection differs from the checked-in Basis Lab metadata")

    assets = data.get("sourceAssets")
    require(isinstance(assets, list) and len(assets) == len(EXPECTED_ASSETS), "sourceAssets must contain all five source assets")
    for record, (name, relative) in zip(assets, EXPECTED_ASSETS):
        require(record.get("name") == name and record.get("path") == relative, f"source asset record is invalid: {name}")
        require(SHA256_RE.fullmatch(str(record.get("sha256"))) is not None, f"source hash is invalid: {name}")
        require(record["sha256"] == sha256_file(root / relative), f"source hash does not match: {name}")

    policy = data.get("splitPolicy")
    require(policy == {
        "version": SPLIT_VERSION,
        "seed": SPLIT_SEED,
        "algorithm": "SHA-256(UTF-8(seed + NUL + sampleId)); first four digest bytes as big-endian uint32; uint32 modulo 10 < 8 is train, otherwise validation",
        "trainPercent": 80,
        "validationPercent": 20,
    }, "split policy is invalid")

    samples = data.get("samples")
    require(isinstance(samples, list), "samples must be a list")
    ids: list[str] = []
    for sample in samples:
        validate_sample(sample, vectors)
        sample_id = sample["sampleId"]
        require(sample_id not in ids, f"duplicate sampleId: {sample_id}")
        ids.append(sample_id)
    require(ids == sorted(ids), "samples must be sorted by sampleId")
    if "projection" in data:
        projection = data["projection"]
        require(isinstance(projection, dict) and set(projection) == {"split", "sourceDatasetHashSha256"}, "projection metadata is invalid")
        require(projection["split"] in ("train", "validation"), "projection split is invalid")
        require(SHA256_RE.fullmatch(str(projection["sourceDatasetHashSha256"])) is not None, "projection source hash is invalid")
        require(all(sample["split"] == projection["split"] for sample in samples), "projection contains another split")
    require(SHA256_RE.fullmatch(str(data.get("datasetHashSha256"))) is not None, "datasetHashSha256 is required")
    require(data["datasetHashSha256"] == content_hash(data), "datasetHashSha256 does not match deterministic content")


def validate_sample(sample: Any, vectors: list[dict[str, Any]]) -> None:
    require(isinstance(sample, dict), "sample must be an object")
    allowed = {"sampleId", "split", "faceDNA", "basisVectorNames", "basisCoefficients", "label", "status", "notes", "annotatorRole", "humanApproved"}
    require(set(sample) <= allowed, f"unknown sample fields: {sorted(set(sample) - allowed)}")
    sample_id = sample.get("sampleId")
    require(isinstance(sample_id, str) and SAMPLE_ID_RE.fullmatch(sample_id) is not None, "sampleId is invalid")
    require(sample.get("split") == split_for_sample(sample_id), "sample split is inconsistent with split policy")
    face_dna = sample.get("faceDNA")
    require(isinstance(face_dna, dict), "faceDNA metadata is required")
    require(set(face_dna) == {"code", "profileVersion", "style", "seed", "age", "presentation", "identityBits", "appearanceBits", "kitPrimary", "kitSecondary"}, "faceDNA metadata fields are invalid")
    parsed = parse_sf2(face_dna["code"])
    require(face_dna == parsed, "faceDNA metadata does not match canonical SF2 code")
    require(sample.get("basisVectorNames") == [item["name"] for item in vectors], "sample basis vector names/order are invalid")
    coefficients = sample.get("basisCoefficients")
    require(isinstance(coefficients, list) and len(coefficients) == 8, "sample must contain exactly eight basis coefficients")
    for coefficient in coefficients:
        require(isinstance(coefficient, (int, float)) and not isinstance(coefficient, bool) and math.isfinite(float(coefficient)), "basis coefficient must be finite")
        require(COEFFICIENT_MIN <= float(coefficient) <= COEFFICIENT_MAX, "basis coefficient is outside [-0.25, 0.25]")
    require(isinstance(sample.get("label"), str) and 0 < len(sample["label"]) <= 200, "human label is required")
    require(isinstance(sample.get("status"), str) and sample["status"] in {"unreviewed", "reviewed", "uncertain", "rejected"}, "sample status is invalid")
    require(sample.get("humanApproved") is False or sample.get("humanApproved") is True, "sample humanApproved must be boolean")
    for optional in ("notes", "annotatorRole"):
        if optional in sample:
            require(isinstance(sample[optional], str) and len(sample[optional]) <= (1000 if optional == "notes" else 100), f"{optional} is invalid")


def add_sample(dataset_path: Path, sample_id: str, face_code: str, coefficients: list[str | float], label: str, notes: str | None = None, annotator_role: str | None = None, human_approved: bool = False, clamp: bool = False, status: str = "unreviewed") -> dict[str, Any]:
    data = validate(dataset_path)
    require("projection" not in data, "samples can only be added to the source dataset, not a split projection")
    require(isinstance(human_approved, bool), "human_approved must be a bool")
    require(isinstance(sample_id, str) and SAMPLE_ID_RE.fullmatch(sample_id) is not None, "sampleId is invalid")
    require(not any(sample["sampleId"] == sample_id for sample in data["samples"]), f"duplicate sampleId: {sample_id}")
    parsed_face = parse_sf2(face_code)
    require(len(coefficients) == 8, "exactly eight coefficients are required")
    parsed_coefficients = []
    for value in coefficients:
        try:
            coefficient = float(value)
        except (TypeError, ValueError) as error:
            raise CalibrationDatasetError(f"coefficient is not numeric: {value}") from error
        require(math.isfinite(coefficient), "coefficient must be finite")
        if not COEFFICIENT_MIN <= coefficient <= COEFFICIENT_MAX:
            require(clamp, f"coefficient outside [-0.25, 0.25]: {coefficient}")
            coefficient = max(COEFFICIENT_MIN, min(COEFFICIENT_MAX, coefficient))
        parsed_coefficients.append(0.0 if coefficient == 0 else coefficient)
    sample: dict[str, Any] = {
        "sampleId": sample_id,
        "split": split_for_sample(sample_id),
        "faceDNA": parsed_face,
        "basisVectorNames": [item["name"] for item in data["vectorSelection"]["vectors"]],
        "basisCoefficients": parsed_coefficients,
        "label": label,
        "status": status,
        "humanApproved": human_approved,
    }
    if notes is not None:
        sample["notes"] = notes
    if annotator_role is not None:
        sample["annotatorRole"] = annotator_role
    validate_sample(sample, data["vectorSelection"]["vectors"])
    data["samples"].append(sample)
    data["samples"].sort(key=lambda item: item["sampleId"])
    data["datasetHashSha256"] = content_hash(data)
    validate_data(data)
    write_json(dataset_path, data)
    return data


def split_dataset(dataset_path: Path, train_output: Path, validation_output: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    source_resolved = dataset_path.resolve()
    train_resolved = train_output.resolve()
    validation_resolved = validation_output.resolve()
    require(source_resolved not in {train_resolved, validation_resolved}, "split outputs must not overwrite the source dataset")
    require(train_resolved != validation_resolved, "train and validation outputs must be different files")
    source = validate(dataset_path)
    source_hash = source["datasetHashSha256"]
    projections = []
    for split, output in (("train", train_output), ("validation", validation_output)):
        projection = copy.deepcopy(source)
        projection["samples"] = [sample for sample in source["samples"] if sample["split"] == split]
        projection["projection"] = {"split": split, "sourceDatasetHashSha256": source_hash}
        projection["datasetHashSha256"] = content_hash(projection)
        validate_data(projection)
        write_json(output, projection)
        projections.append(projection)
    return projections[0], projections[1]


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description=__doc__)
    subparsers = command.add_subparsers(dest="command", required=True)
    init = subparsers.add_parser("init", help="write a deterministic empty dataset")
    init.add_argument("--output", type=Path, default=DEFAULT_DATASET)
    init.add_argument("--evidence-base-revision", default=EVIDENCE_BASE_REVISION)
    add = subparsers.add_parser("add", help="append one human annotation")
    add.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    add.add_argument("--sample-id", required=True)
    add.add_argument("--face-code", required=True)
    add.add_argument("--coefficients", nargs=8, required=True, metavar="COEFFICIENT")
    add.add_argument("--label", required=True)
    add.add_argument("--status", default="unreviewed", choices=("unreviewed", "reviewed", "uncertain", "rejected"))
    add.add_argument("--notes")
    add.add_argument("--annotator-role")
    add.add_argument("--human-approved", action="store_true")
    add.add_argument("--clamp", action="store_true", help="clamp rather than reject out-of-range coefficients")
    validate_command = subparsers.add_parser("validate", help="validate a dataset or split projection")
    validate_command.add_argument("dataset", nargs="?", type=Path, default=DEFAULT_DATASET)
    split = subparsers.add_parser("split", help="write deterministic train/validation projections")
    split.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    split.add_argument("--output-dir", type=Path)
    split.add_argument("--train-output", type=Path)
    split.add_argument("--validation-output", type=Path)
    return command


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "init":
            init_dataset(args.output, ROOT, args.evidence_base_revision)
            print(f"PASS calibration dataset initialized: {args.output}")
        elif args.command == "add":
            add_sample(args.dataset, args.sample_id, args.face_code, args.coefficients, args.label, args.notes, args.annotator_role, args.human_approved, args.clamp, args.status)
            print(f"PASS calibration sample added: {args.sample_id}")
        elif args.command == "validate":
            data = validate(args.dataset)
            print(f"PASS calibration dataset valid: {args.dataset} ({len(data['samples'])} samples)")
        elif args.command == "split":
            output_dir = args.output_dir
            train_output = args.train_output or (output_dir / "gnm-calibration-dataset-train.json" if output_dir else None)
            validation_output = args.validation_output or (output_dir / "gnm-calibration-dataset-validation.json" if output_dir else None)
            require(train_output is not None and validation_output is not None, "split requires --output-dir or both projection output paths")
            split_dataset(args.dataset, train_output, validation_output)
            print(f"PASS calibration dataset split: {train_output}, {validation_output}")
        return 0
    except (CalibrationDatasetError, OSError, TypeError, ValueError) as error:
        print(f"FAIL calibration dataset: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
