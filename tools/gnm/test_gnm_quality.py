#!/usr/bin/env python3
"""Deterministic quality checks for the canonical GNM morphology pack."""

from __future__ import annotations

import ast
import json
import math
from pathlib import Path
import struct
import zipfile


ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "tools" / "gnm" / "work"
LANDMARKS_PATH = WORK / "gnm-landmarks.json"
PACK_PATH = WORK / "gnm-morphology-pack.json"
VERTEX_MAP_PATH = WORK / "gnm-vertex-map.json"
MESH_PATH = WORK / "gnm-heads-200.npz"
EXPECTED_COUNT = 200
EXPECTED_FAMILY_COUNT = 8
NEAREST_NEIGHBOR_THRESHOLD = 0.20
COORDINATE_TOLERANCE = 1e-5

REQUIRED_LANDMARKS = (
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


def fail(message: str) -> None:
    raise AssertionError(message)


def finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def load_json(path: Path) -> dict:
    document = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        fail(f"{path} must contain a JSON object")
    return document


def distance(a: dict, b: dict) -> float:
    return math.dist((a["x"], a["y"]), (b["x"], b["y"]))


def feature_vector(sample: dict) -> tuple[float, ...]:
    landmarks = sample.get("landmarks")
    if not isinstance(landmarks, dict):
        fail(f"{sample.get('id', '?')} has no landmarks object")
    missing = [name for name in REQUIRED_LANDMARKS if name not in landmarks]
    if missing:
        fail(f"{sample.get('id', '?')} is missing landmarks: {', '.join(missing)}")
    for name in REQUIRED_LANDMARKS:
        point = landmarks[name]
        if (
            not isinstance(point, dict)
            or not finite_number(point.get("x"))
            or not finite_number(point.get("y"))
        ):
            fail(f"{sample.get('id', '?')} has invalid coordinates for {name}")

    face_height = landmarks["chin"]["y"] - landmarks["top"]["y"]
    if not finite_number(face_height) or face_height <= 0:
        fail(f"{sample.get('id', '?')} has invalid face height")
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
    for key, value in zip(FEATURE_KEYS, values):
        if not finite_number(value) or value <= 0:
            fail(f"{sample.get('id', '?')} has invalid {key}: {value!r}")
    return values


def read_npy_header(stream, *, read_payload: bool = False) -> tuple[dict, bytes]:
    if stream.read(6) != b"\x93NUMPY":
        fail("Invalid .npy magic")
    major, minor = stream.read(2)
    if major == 1:
        header_size = struct.unpack("<H", stream.read(2))[0]
    elif major in (2, 3):
        header_size = struct.unpack("<I", stream.read(4))[0]
    else:
        fail(f"Unsupported .npy version {major}.{minor}")
    header = ast.literal_eval(stream.read(header_size).decode("latin1").strip())
    if not isinstance(header, dict):
        fail("Invalid .npy header")
    return header, stream.read() if read_payload else b""


def npy_shape(archive: zipfile.ZipFile, name: str) -> tuple[int, ...]:
    try:
        with archive.open(name) as stream:
            header, _ = read_npy_header(stream)
    except KeyError:
        fail(f"Mesh archive is missing {name}")
    shape = header.get("shape")
    if not isinstance(shape, tuple) or not all(isinstance(value, int) for value in shape):
        fail(f"Invalid shape for {name}: {shape!r}")
    return shape


def read_template(archive: zipfile.ZipFile) -> tuple[tuple[int, ...], list[tuple[float, float, float]]]:
    try:
        with archive.open("template.npy") as stream:
            header, payload = read_npy_header(stream, read_payload=True)
    except KeyError:
        fail("Mesh archive is missing template.npy")
    if header.get("descr") != "<f4" or header.get("fortran_order") is not False:
        fail(f"Unsupported template.npy format: {header!r}")
    shape = header.get("shape")
    if not isinstance(shape, tuple) or len(shape) != 2 or shape[1] != 3:
        fail(f"Invalid template shape: {shape!r}")
    expected_values = shape[0] * shape[1]
    values = struct.unpack(f"<{expected_values}f", payload[: expected_values * 4])
    return shape, [tuple(values[index:index + 3]) for index in range(0, len(values), 3)]


def check_mesh_boundaries(vertex_map: dict) -> None:
    if not MESH_PATH.is_file():
        print(f"SKIPPED mesh-bound check: {MESH_PATH} is absent; JSON consistency checks still ran.")
        return
    with zipfile.ZipFile(MESH_PATH) as archive:
        vertices_shape = npy_shape(archive, "vertices.npy")
        template_shape, template = read_template(archive)
    if len(vertices_shape) != 3 or vertices_shape[0] != EXPECTED_COUNT or vertices_shape[2] != 3:
        fail(f"Expected vertices shape (200, vertex_count, 3), got {vertices_shape!r}")
    if template_shape != (vertices_shape[1], 3):
        fail(f"Template and vertices disagree: {template_shape!r} vs {vertices_shape!r}")

    coordinates = vertex_map["coordinates"]
    for name in REQUIRED_LANDMARKS:
        ids = vertex_map["landmarks"][name]
        for vertex_id in ids:
            if vertex_id < 0 or vertex_id >= vertices_shape[1]:
                fail(f"{name} vertex ID {vertex_id} is outside 0..{vertices_shape[1] - 1}")
        expected = template[ids[0]]
        actual = coordinates[name]
        error = max(abs(left - right) for left, right in zip(expected, actual))
        if error > COORDINATE_TOLERANCE:
            fail(f"{name} coordinate metadata differs from template by {error:g}")
    print(f"Mesh-bound check passed: {EXPECTED_COUNT} samples, {vertices_shape[1]} vertices, 31 mapped IDs.")


def check_canonical(landmarks: dict, pack: dict, vertex_map: dict) -> None:
    if landmarks.get("schema") != "sports-face-landmark-samples/v1":
        fail("Unexpected landmark sample schema")
    if pack.get("schema") != "sports-face-morphology-pack/v1":
        fail("Unexpected morphology pack schema")
    if landmarks.get("source", {}).get("meshFile") != "gnm-heads-200.npz":
        fail("Canonical landmarks do not name gnm-heads-200.npz")
    if pack.get("source", {}).get("meshFile") != landmarks["source"]["meshFile"]:
        fail("Canonical landmarks and pack have different source meshes")

    mapped = vertex_map.get("landmarks")
    coordinates = vertex_map.get("coordinates")
    if set(mapped or {}) != set(REQUIRED_LANDMARKS) or set(coordinates or {}) != set(REQUIRED_LANDMARKS):
        fail("Vertex map must contain exactly the required 31 landmarks and coordinates")
    all_ids = []
    for name in REQUIRED_LANDMARKS:
        ids = mapped[name]
        if not isinstance(ids, list) or not ids or not all(isinstance(value, int) and not isinstance(value, bool) for value in ids):
            fail(f"{name} has an invalid vertex ID list")
        point = coordinates[name]
        if not isinstance(point, list) or len(point) != 3 or not all(finite_number(value) for value in point):
            fail(f"{name} has invalid coordinate metadata")
        all_ids.extend(ids)
    if len(all_ids) != len(set(all_ids)):
        fail("Vertex map contains duplicate landmark vertex IDs")

    samples = landmarks.get("samples")
    if not isinstance(samples, list) or len(samples) != EXPECTED_COUNT:
        fail(f"Expected {EXPECTED_COUNT} canonical landmark samples")
    sample_ids = [sample.get("id") for sample in samples]
    if len(sample_ids) != len(set(sample_ids)):
        fail("Canonical landmark sample IDs are not unique")
    rows = [feature_vector(sample) for sample in samples]
    for index, key in enumerate(FEATURE_KEYS):
        values = [row[index] for row in rows]
        if max(values) - min(values) <= 1e-9:
            fail(f"{key} is not variable across {EXPECTED_COUNT} samples")

    families = pack.get("families")
    clustering = pack.get("clustering", {})
    if clustering.get("families") != EXPECTED_FAMILY_COUNT or len(families or []) != EXPECTED_FAMILY_COUNT:
        fail(f"Expected {EXPECTED_FAMILY_COUNT} morphology families")
    member_ids = []
    family_ids = set()
    for family in families:
        family_id = family.get("id")
        if not family_id or family_id in family_ids:
            fail(f"Invalid or duplicate family ID: {family_id!r}")
        family_ids.add(family_id)
        members = family.get("members")
        if not isinstance(members, list) or not members:
            fail(f"{family_id} is empty")
        if family.get("memberCount") != len(members):
            fail(f"{family_id} memberCount does not match members")
        centroid = family.get("centroid")
        if set(centroid or {}) != set(FEATURE_KEYS):
            fail(f"{family_id} does not contain exactly the 14 features")
        if not all(finite_number(centroid[key]) and centroid[key] > 0 for key in FEATURE_KEYS):
            fail(f"{family_id} has a non-positive or non-finite centroid")
        member_ids.extend(members)
    if len(member_ids) != EXPECTED_COUNT or len(member_ids) != len(set(member_ids)):
        fail("Family member IDs are not unique across the 200-sample pack")
    if set(member_ids) != set(sample_ids):
        fail("Family member IDs are not complete against canonical sample IDs")
    if clustering.get("features") != list(FEATURE_KEYS):
        fail("Pack feature order does not match the 14-feature contract")

    if len(rows) != len(set(rows)):
        fail("Canonical samples contain exact duplicate 14D feature vectors")
    normalized = []
    for index in range(len(FEATURE_KEYS)):
        values = [row[index] for row in rows]
        low, high = min(values), max(values)
        normalized.append([(row[index] - low) / (high - low) for row in rows])
    normalized_rows = list(zip(*normalized))
    nearest = min(
        (math.dist(normalized_rows[left], normalized_rows[right]), left, right)
        for left in range(EXPECTED_COUNT)
        for right in range(left)
    )
    if nearest[0] <= NEAREST_NEIGHBOR_THRESHOLD:
        fail(
            f"Nearest normalized 14D samples {nearest[1]} and {nearest[2]} are "
            f"too close: {nearest[0]:.6f} <= {NEAREST_NEIGHBOR_THRESHOLD:.2f}"
        )
    print(
        f"JSON quality checks passed: {EXPECTED_COUNT} samples, 31 landmarks, "
        f"14 variable features, 8 non-empty families; nearest normalized distance={nearest[0]:.6f}."
    )


def compare_retained_artifacts() -> None:
    comparisons = (
        (LANDMARKS_PATH, WORK / "gnm-landmarks-200.json"),
        (PACK_PATH, WORK / "gnm-morphology-pack-200.json"),
    )
    for canonical, retained in comparisons:
        if not retained.is_file():
            print(f"SKIPPED deterministic rerun comparison: {retained} is absent.")
            continue
        if canonical.read_bytes() != retained.read_bytes():
            fail(f"Canonical artifact differs from retained deterministic artifact: {retained}")
        print(f"Deterministic rerun comparison passed: {canonical.name} == {retained.name}.")


def main() -> int:
    landmarks = load_json(LANDMARKS_PATH)
    pack = load_json(PACK_PATH)
    vertex_map = load_json(VERTEX_MAP_PATH)
    check_canonical(landmarks, pack, vertex_map)
    check_mesh_boundaries(vertex_map)
    compare_retained_artifacts()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
