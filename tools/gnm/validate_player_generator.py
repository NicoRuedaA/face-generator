#!/usr/bin/env python3
"""Standard-library validator for the GNM 3D player-generator payload.

Checks the binary layout, hashes, provenance, budget, feature/landmark/field
metadata and (optionally) the render GLB and license it depends on. It never
needs NumPy or GNM, so it runs in CI on the committed artifacts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import sys


SCHEMA = "sports-face-gnm-player-generator/v1"
MAGIC = b"SFGNMPL1"
HEADER_STRUCT = struct.Struct("<8sIIIIIIIIIIIIII")
MAX_BYTES = 6_815_744
SOURCE_VERTEX_COUNT = 17821
RENDER_VERTEX_COUNT = 18437
HEAD_IDENTITY_COUNT = 170
IDENTITY_PRIOR_COUNT = 32
EXPRESSION_COUNT = 383
OFFICIAL_CORNEA_VERTEX_COUNT = 772
EXPECTED_SOURCE = {
    "npz": ("8ea2906a31aab7f8b550e33968f3c0a86051a92d", "03649b09d1f756c94e8b3db709edcfa07ac367de0ba35e2d04c985ebcadbaf14"),
    "landmarks": ("0ae8cc7aa2ef3c08dbc7fd35d6772869380e7f96", "d8b6066a87ca37c48bcf4d0834542db841709b65cb983e873fa1e441a22219d0"),
    "expressionDecoder": ("8ea2906a31aab7f8b550e33968f3c0a86051a92d", "5eba165f8a414f73b24be96963d0a17e708c0856739ed85a19031f318dfb51e6"),
}
RENDER_SHA256 = "081ddb9b1f6b26a76255fb1710b763bcb105941139cba1490a501b99c568e23f"
LICENSE_SHA256 = "58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd"
FEATURE_KEYS = (
    "faceWidth", "jawWidth", "chinWidth", "faceHeight", "foreheadHeight", "noseLength", "noseWidth", "noseProjection",
    "bridgeHeight", "mouthWidth", "lipThickness", "mouthCornerLift", "eyeWidth", "eyeOpening", "canthalTilt", "eyeDepth",
    "browHeight", "earHeight", "earProjection",
)
FIELD_KEYS = (
    "lip", "mouthSock", "teeth", "cornea", "irisAngle", "freckleZone", "ear", "eyeSocket", "scalpHeight", "scalpFront",
    "neckHeight", "scarDist", "browT", "browD", "blushZone", "faceMask", "beardUpper", "beardLower", "mouthDX", "mouthDY",
)
EXPRESSION_PRESETS = (("surprise", "SURPRISE", 0), ("happy", "HAPPY", 5), ("squint", "SQUINT", 6))
FIXED_VERTICES = ("foreheadTop", "leftEarBottom", "leftEarOuter", "leftEarTop", "rightEarBottom", "rightEarOuter", "rightEarTop")


class ValidationError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def finite(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def no_absolute_paths(value: object) -> None:
    if isinstance(value, dict):
        for item in value.values():
            no_absolute_paths(item)
    elif isinstance(value, list):
        for item in value:
            no_absolute_paths(item)
    elif isinstance(value, str):
        require(not value.startswith("/") and not (len(value) > 2 and value[1] == ":" and value[2] in "\\/"), f"metadata contains an absolute path: {value}")


def check_render(render_path: Path, metadata: dict) -> None:
    require(sha256(render_path) == RENDER_SHA256 == metadata["source"]["renderGlb"]["sha256"], "render GLB SHA-256 does not match")
    data = render_path.read_bytes()
    json_length = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20:20 + json_length].decode("utf-8").rstrip(" \0"))
    binary_offset = 20 + json_length + 8
    total = 0
    seen = set()
    for primitive, record in zip(document["meshes"][0]["primitives"], metadata["components"]):
        require(primitive["extras"]["componentName"] == record["name"], "render component order differs from metadata")
        accessor = document["accessors"][primitive["extras"]["sourceVertexIndicesAccessor"]]
        view = document["bufferViews"][accessor["bufferView"]]
        offset = binary_offset + view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        ids = struct.unpack_from(f"<{accessor['count']}I", data, offset)
        require(len(ids) == record["renderVertexCount"] and record["renderVertexOffset"] == total, "render component vertex counts differ from metadata")
        require(min(ids) == record["sourceVertexMin"] and max(ids) == record["sourceVertexMax"], "render component source id range differs from metadata")
        total += len(ids)
        seen.update(ids)
    require(total == RENDER_VERTEX_COUNT and seen == set(range(SOURCE_VERTEX_COUNT)), "render sourceVertexIds must cover every official vertex")


def validate(payload_path: Path, metadata_path: Path, render_path: Path | None = None, license_path: Path | None = None) -> dict:
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    payload = payload_path.read_bytes()
    no_absolute_paths(metadata)
    require(metadata.get("schema") == SCHEMA and metadata.get("version") == 1, "player-generator metadata schema is invalid")
    require(metadata.get("semanticMapping") == "measured-landmark-features-v1", "semanticMapping must be measured-landmark-features-v1")
    require(metadata.get("runtimeBasisLoaded") is True and metadata.get("officialTexturesIncluded") is False, "runtime/texture safety flags are invalid")
    require(metadata.get("budget") == {"maxBytes": MAX_BYTES, "withinLimit": True}, "budget metadata is invalid")
    require(len(payload) <= MAX_BYTES and len(payload) == metadata["payload"]["sizeBytes"], "payload exceeds the budget or metadata size")
    require(hashlib.sha256(payload).hexdigest() == metadata["payload"]["sha256"], "payload SHA-256 does not match metadata")
    require(metadata["payload"]["path"] == "gnm-player-generator.bin", "payload path is unexpected")
    source = metadata["source"]
    for key, (revision, digest) in EXPECTED_SOURCE.items():
        require(source[key]["revision"] == revision and source[key]["sha256"] == digest, f"{key} provenance is not the reviewed upstream file")
    require(source["repository"] == "https://github.com/google/GNM", "upstream repository is unexpected")
    require(source["renderGlb"]["sha256"] == RENDER_SHA256 and source["license"]["sha256"] == LICENSE_SHA256 and source["license"]["spdxId"] == "Apache-2.0", "render/license provenance is invalid")
    require(metadata["authorization"]["decisionReference"] == "sports-face-mvp-noncommercial-mvp-authorization", "authorization reference is missing")

    dims = metadata["dimensions"]
    feature_count = len(FEATURE_KEYS)
    vector_count = IDENTITY_PRIOR_COUNT + feature_count + len(EXPRESSION_PRESETS)
    require(dims == {"sourceVertexCount": SOURCE_VERTEX_COUNT, "renderVertexCount": RENDER_VERTEX_COUNT, "headIdentityCount": HEAD_IDENTITY_COUNT, "identityPriorCount": IDENTITY_PRIOR_COUNT, "featureCount": feature_count, "expressionPresetCount": len(EXPRESSION_PRESETS), "fieldCount": len(FIELD_KEYS), "vectorCount": vector_count}, "dimensions are invalid")
    require(len(payload) >= HEADER_STRUCT.size, "payload header is truncated")
    magic, version, header_bytes, vertices, prior, features, presets, fields, scale_offset, vector_offset, vector_bytes, field_offset, field_bytes, total, reserved = HEADER_STRUCT.unpack_from(payload)
    require(magic == MAGIC and version == 1 and header_bytes == HEADER_STRUCT.size and reserved == 0, "payload header is invalid")
    require((vertices, prior, features, presets, fields) == (SOURCE_VERTEX_COUNT, IDENTITY_PRIOR_COUNT, feature_count, len(EXPRESSION_PRESETS), len(FIELD_KEYS)), "payload header dimensions are invalid")
    require(scale_offset == header_bytes and vector_offset == scale_offset + 4 * vector_count, "payload scale/vector offsets are invalid")
    require(vector_bytes == vector_count * vertices * 6 and field_offset == vector_offset + vector_bytes, "payload vector block is invalid")
    require(field_bytes == fields * vertices and field_offset + field_bytes == total == len(payload), "payload field block is invalid")
    scales = struct.unpack_from(f"<{vector_count}f", payload, scale_offset)
    require(all(math.isfinite(value) and value > 0 for value in scales), "vector scales must be finite and positive")
    require(0 < metadata["quantization"]["maxAbsErrorMeters"] < 1e-6, "quantization error is out of bounds")

    components = metadata["identity"]["priorComponents"]
    require([(item["index"], item["name"], item["vectorIndex"]) for item in components] == [(index, f"head_{index:03d}", index) for index in range(IDENTITY_PRIOR_COUNT)], "identity prior components are invalid")
    fixed = metadata["fixedVertices"]
    require(tuple(sorted(fixed)) == FIXED_VERTICES and all(isinstance(value, int) and 0 <= value < SOURCE_VERTEX_COUNT for value in fixed.values()), "fixed vertices are invalid")
    definitions = metadata["landmarks"]["definitions"]
    require(metadata["landmarks"]["count"] == 68 and len(definitions) == 68, "landmark definitions must contain 68 rows")
    for row in definitions:
        require(len(row) == 6 and all(isinstance(row[index], int) and 0 <= row[index] < SOURCE_VERTEX_COUNT for index in (0, 2, 4)), "landmark vertex index is invalid")
        require(abs(row[1] + row[3] + row[5] - 1.0) < 0.01, "landmark barycentric weights must sum to one")

    records = metadata["features"]
    require([record["key"] for record in records] == list(FEATURE_KEYS), "feature keys or order are invalid")
    for index, record in enumerate(records):
        gradient = record["normalizedGradient"]
        require(len(gradient) == HEAD_IDENTITY_COUNT and all(finite(value) for value in gradient), f"{record['key']} gradient is invalid")
        norm = math.sqrt(sum(value * value for value in gradient))
        require(abs(norm - 1.0) < 1e-4, f"{record['key']} gradient is not normalized")
        share = sum(value * value for value in gradient[:IDENTITY_PRIOR_COUNT])
        require(abs(share - record["priorVarianceShare"]) < 1e-5 and 0.0 < share < 1.0, f"{record['key']} prior variance share is inconsistent")
        require(record["tailVectorIndex"] == IDENTITY_PRIOR_COUNT + index, f"{record['key']} tail vector index is invalid")
        require(finite(record["templateValueMm"]) and finite(record["stdDevMm"]) and record["stdDevMm"] > 0.1, f"{record['key']} statistics are invalid")
        require(record["terms"] and all(term["axis"] in ("x", "y", "z") and finite(term["weight"]) for term in record["terms"]), f"{record['key']} terms are invalid")
        for term in record["terms"]:
            require(("landmark" in term and isinstance(term["landmark"], int) and 0 <= term["landmark"] < 68) or term.get("vertex") in fixed, f"{record['key']} term reference is invalid")
    correlation = metadata["featureCorrelation"]
    require(len(correlation) == feature_count and all(len(row) == feature_count for row in correlation), "feature correlation shape is invalid")
    for row in range(feature_count):
        require(abs(correlation[row][row] - 1.0) < 1e-4, "feature correlation diagonal must be one")
        for column in range(feature_count):
            require(abs(correlation[row][column] - correlation[column][row]) < 1e-6 and abs(correlation[row][column]) <= 1.0 + 1e-6, "feature correlation must be symmetric and bounded")

    expression_records = metadata["expressionPresets"]
    require([(item["key"], item["officialClass"], item["classIndex"]) for item in expression_records] == list(EXPRESSION_PRESETS), "expression presets are invalid")
    for index, item in enumerate(expression_records):
        require(item["vectorIndex"] == IDENTITY_PRIOR_COUNT + feature_count + index and item["latent"] == "zero (latent mean)", "expression preset vector index/latent is invalid")
        require(len(item["coefficients"]) == EXPRESSION_COUNT and all(finite(value) for value in item["coefficients"]), "expression preset coefficients are invalid")
        require(0.5 < item["maxDisplacementMm"] < 40.0, "expression preset displacement is implausible")

    field_records = metadata["fields"]
    require([(item["key"], item["index"]) for item in field_records] == [(key, index) for index, key in enumerate(FIELD_KEYS)], "field keys or order are invalid")
    require(all(finite(item["min"]) and finite(item["max"]) and item["min"] < item["max"] and item["derivation"] for item in field_records), "field ranges are invalid")
    cornea = payload[field_offset + FIELD_KEYS.index("cornea") * vertices:field_offset + (FIELD_KEYS.index("cornea") + 1) * vertices]
    require(sum(1 for value in cornea if value >= 128) == OFFICIAL_CORNEA_VERTEX_COUNT, "cornea field does not match the official eye_exteriors group")
    eyes = metadata["fieldAnchors"]["eyes"]
    require(all(0 < eyes[side]["pupilMaxDeg"] < eyes[side]["irisMaxDeg"] < eyes[side]["scleraMinDeg"] < 40 for side in ("left_eye", "right_eye")), "iris/pupil angle anchors are invalid")
    require([item["name"] for item in metadata["components"]] == ["skin", "left_eye", "right_eye", "upper_teeth_and_gums", "lower_teeth_and_gums", "tongue"], "render components are invalid")
    if render_path is not None:
        check_render(render_path, metadata)
    if license_path is not None:
        require(sha256(license_path) == LICENSE_SHA256, "GNM license text does not match")
    return metadata


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("payload", type=Path)
    parser.add_argument("metadata", type=Path)
    parser.add_argument("--render", type=Path)
    parser.add_argument("--license", type=Path)
    args = parser.parse_args(argv)
    try:
        metadata = validate(args.payload, args.metadata, args.render, args.license)
    except (ValidationError, OSError, KeyError, TypeError, ValueError, struct.error) as error:
        print(f"FAIL GNM player generator validation: {error}", file=sys.stderr)
        return 1
    print(f"PASS GNM player generator validation: {metadata['payload']['sizeBytes']} bytes, {metadata['dimensions']['vectorCount']} vectors, {metadata['dimensions']['fieldCount']} fields, hashes/provenance/layout/features/landmarks verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
