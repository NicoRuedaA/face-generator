#!/usr/bin/env python3
"""Validate the portable offline GNM PCA morph-target package."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import sys


SCHEMA = "sports-face-gnm-morph-targets/v1"
MIN_TARGET_COUNT = 12
MAX_TARGET_COUNT = 20
FLOAT_BYTES = 4


class ValidationError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_block(block: object, name: str, vertex_count: int, expected_offset: int) -> int:
    require(isinstance(block, dict), f"{name} must be an object")
    require(block.get("dtype") == "float32", f"{name} must use float32")
    require(block.get("shape") == [vertex_count, 3], f"{name} has the wrong shape")
    offset = block.get("byteOffset")
    length = block.get("byteLength")
    expected_length = vertex_count * 3 * FLOAT_BYTES
    require(isinstance(offset, int) and offset == expected_offset and offset >= 0 and offset % FLOAT_BYTES == 0, f"{name} has an invalid byteOffset")
    require(isinstance(length, int) and length == expected_length, f"{name} has an invalid byteLength")
    return offset + length


def validate_document(document: object) -> tuple[str, int, int]:
    require(isinstance(document, dict), "metadata must contain an object")
    require(document.get("schema") == SCHEMA, "unexpected morph-target schema")
    vertex_count = document.get("vertexCount")
    target_count = document.get("targetCount")
    require(isinstance(vertex_count, int) and not isinstance(vertex_count, bool) and vertex_count > 0, "vertexCount must be a positive integer")
    require(isinstance(target_count, int) and MIN_TARGET_COUNT <= target_count <= MAX_TARGET_COUNT, f"targetCount must be between {MIN_TARGET_COUNT} and {MAX_TARGET_COUNT}")
    binary = document.get("binary")
    require(isinstance(binary, dict), "binary metadata is missing")
    binary_path = binary.get("path")
    require(isinstance(binary_path, str) and binary_path and Path(binary_path).name == binary_path and binary_path not in {".", ".."}, "binary path must be a relative file name")
    require(binary.get("byteOrder") == "little-endian" and binary.get("dtype") == "float32", "binary must be little-endian float32")
    binary_length = binary.get("byteLength")
    expected_length = (2 + target_count) * vertex_count * 3 * FLOAT_BYTES
    require(isinstance(binary_length, int) and binary_length == expected_length, "binary byteLength is not exact")
    digest = binary.get("sha256")
    require(isinstance(digest, str) and len(digest) == 64 and all(character in "0123456789abcdef" for character in digest), "binary sha256 is invalid")

    reference = document.get("reference")
    require(isinstance(reference, dict) and reference.get("kind") == "template", "template reference is missing")
    offset = validate_block(reference.get("template"), "reference.template", vertex_count, 0)
    offset = validate_block(reference.get("meanDelta"), "reference.meanDelta", vertex_count, offset)

    targets = document.get("targets")
    require(isinstance(targets, list) and len(targets) == target_count, "targets length does not match targetCount")
    ids: set[str] = set()
    block_length = vertex_count * 3 * FLOAT_BYTES
    for index, target in enumerate(targets):
        require(isinstance(target, dict), f"target {index} must be an object")
        target_id = target.get("id")
        require(isinstance(target_id, str) and target_id and target_id not in ids, f"target {index} has an invalid or duplicate id")
        ids.add(target_id)
        require(target.get("label") == target_id, f"target {index} label must remain neutral and match id")
        require(target.get("index") == index, f"target {index} has an unstable index")
        weight_range = target.get("weightRange")
        require(isinstance(weight_range, list) and len(weight_range) == 2 and all(finite_number(value) for value in weight_range), f"target {index} has invalid weightRange")
        require(weight_range[0] <= weight_range[1], f"target {index} has inverted weightRange")
        explained = target.get("explainedVariance")
        require(finite_number(explained) and 0 <= explained <= 1, f"target {index} has invalid explainedVariance")
        offset = validate_block(target.get("delta"), f"target {index}.delta", vertex_count, offset)
    require(offset == expected_length, "target payload blocks do not fill the binary exactly")

    metrics = document.get("metrics")
    require(isinstance(metrics, dict), "metrics metadata is missing")
    for name in ("templateRmse", "meanReferenceRmse", "residualRmse", "residualMaxAbs", "retainedVariance", "residualVariance"):
        require(finite_number(metrics.get(name)) and metrics[name] >= 0, f"metric {name} is invalid")
    require(metrics["retainedVariance"] <= 1 and metrics["residualVariance"] <= 1, "variance metrics are out of bounds")
    return binary_path, vertex_count, target_count


def validate(path: Path) -> tuple[int, int, int]:
    document = json.loads(path.read_text(encoding="utf-8"))
    binary_name, vertex_count, target_count = validate_document(document)
    binary_path = path.parent / binary_name
    require(binary_path.is_file(), f"binary payload does not exist: {binary_path}")
    binary = binary_path.read_bytes()
    require(len(binary) == document["binary"]["byteLength"], "binary payload length does not match metadata")
    require(hashlib.sha256(binary).hexdigest() == document["binary"]["sha256"], "binary payload sha256 does not match metadata")
    require(len(binary) % FLOAT_BYTES == 0, "binary payload is not float32 aligned")
    try:
        values = struct.iter_unpack("<f", binary)
        require(all(math.isfinite(value[0]) for value in values), "binary payload contains non-finite values")
    except struct.error as error:
        raise ValidationError(f"binary payload is not little-endian float32 data: {error}") from error
    return vertex_count, target_count, len(binary)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    args = parser.parse_args(argv)
    try:
        vertex_count, target_count, binary_length = validate(args.path)
    except (OSError, UnicodeError, json.JSONDecodeError, ValidationError, TypeError, KeyError) as error:
        print(f"FAIL {args.path}: {error}", file=sys.stderr)
        return 1
    print(f"PASS {args.path}: schema {SCHEMA}, {vertex_count} vertices, {target_count} targets, BIN {binary_length} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
