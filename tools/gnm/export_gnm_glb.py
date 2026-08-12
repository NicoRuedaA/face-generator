#!/usr/bin/env python3
"""Export the retained GNM template mesh to a deterministic binary glTF file."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys

import numpy as np


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INPUT = ROOT / "tools" / "gnm" / "work" / "gnm-heads-200.npz"
DEFAULT_OUTPUT = ROOT / "tools" / "gnm" / "work" / "head.glb"
GLB_MAGIC = b"glTF"
GLB_VERSION = 2
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
MORPH_TARGET_COUNT = 16


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help=f"source NPZ (default: {DEFAULT_INPUT})")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help=f"output GLB (default: {DEFAULT_OUTPUT})")
    parser.add_argument("--name", default="GNM Head Template", help="mesh and node name")
    parser.add_argument("--morph-metadata", type=Path, help="validated PCA morph metadata JSON; appends morph targets to the GLB")
    return parser.parse_args(argv)


def aligned_binary(data: bytes) -> bytes:
    return data + b"\0" * ((-len(data)) % 4)


def aligned_json(data: bytes) -> bytes:
    return data + b" " * ((-len(data)) % 4)


def load_mesh(path: Path) -> tuple[np.ndarray, np.ndarray]:
    try:
        archive = np.load(path, allow_pickle=False)
    except (OSError, ValueError) as error:
        raise ValueError(f"could not read NPZ {path}: {error}") from error
    with archive:
        missing = [name for name in ("template", "triangles") if name not in archive]
        if missing:
            raise ValueError(f"NPZ is missing required array(s): {', '.join(missing)}")
        template = np.asarray(archive["template"])
        triangles = np.asarray(archive["triangles"])

    if template.ndim != 2 or template.shape[1] != 3:
        raise ValueError(f"template must have shape (vertex_count, 3), got {template.shape}")
    if template.dtype.kind != "f" or template.dtype.itemsize != 4:
        raise ValueError(f"template must use float32 coordinates, got {template.dtype}")
    if not np.isfinite(template).all():
        raise ValueError("template contains non-finite coordinates")
    if triangles.ndim != 2 or triangles.shape[1] != 3:
        raise ValueError(f"triangles must have shape (face_count, 3), got {triangles.shape}")
    if triangles.dtype.kind not in "iu":
        raise ValueError(f"triangles must use an integer dtype, got {triangles.dtype}")
    triangles64 = triangles.astype(np.int64, copy=False)
    if triangles64.size == 0:
        raise ValueError("triangles must not be empty")
    if triangles64.min() < 0 or triangles64.max() >= template.shape[0]:
        raise ValueError("triangles contain an out-of-range vertex index")
    if triangles64.max() > 0xFFFFFFFF:
        raise ValueError("triangles contain an index outside uint32 range")
    return template.astype("<f4", copy=False), triangles64.astype("<u4", copy=False)


def load_morph_metadata(path: Path, template: np.ndarray) -> tuple[np.ndarray, list[np.ndarray], list[str]]:
    """Validate and load the adjacent metadata/payload without trusting offsets."""
    try:
        from validate_gnm_morph_targets import ValidationError, validate_document
    except ImportError as error:  # pragma: no cover - direct script has this module beside it
        raise ValueError(f"could not load morph metadata validator: {error}") from error
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"could not read morph metadata {path}: {error}") from error
    try:
        binary_name, metadata_vertex_count, target_count = validate_document(document)
    except (ValidationError, TypeError, KeyError) as error:
        raise ValueError(f"invalid morph metadata {path}: {error}") from error
    vertex_count = int(template.shape[0])
    if metadata_vertex_count != vertex_count:
        raise ValueError(f"morph metadata vertex count {metadata_vertex_count} does not match mesh vertex count {vertex_count}")
    if target_count != MORPH_TARGET_COUNT:
        raise ValueError(f"morph metadata must contain exactly {MORPH_TARGET_COUNT} targets, got {target_count}")

    binary_path = path.parent / binary_name
    try:
        binary = binary_path.read_bytes()
    except OSError as error:
        raise ValueError(f"could not read morph payload {binary_path}: {error}") from error
    expected_length = document["binary"]["byteLength"]
    if len(binary) != expected_length:
        raise ValueError(f"morph payload length {len(binary)} does not match metadata {expected_length}")
    if hashlib.sha256(binary).hexdigest() != document["binary"]["sha256"]:
        raise ValueError("morph payload sha256 does not match metadata")
    values = np.frombuffer(binary, dtype="<f4")
    if not np.isfinite(values).all():
        raise ValueError("morph payload contains non-finite values")

    vertex_values = vertex_count * 3

    def block(name: str, metadata: dict, expected_offset: int) -> np.ndarray:
        if metadata["byteOffset"] != expected_offset or metadata["byteLength"] != vertex_values * 4:
            raise ValueError(f"{name} has an unexpected byte range")
        start = metadata["byteOffset"] // 4
        end = start + metadata["byteLength"] // 4
        return np.array(values[start:end], dtype="<f4", copy=True).reshape(vertex_count, 3)

    reference = document["reference"]
    template_payload = block("reference.template", reference["template"], 0)
    mean_delta = block("reference.meanDelta", reference["meanDelta"], vertex_values * 4)
    if not np.array_equal(template_payload, template):
        raise ValueError("morph metadata template does not match the NPZ template")
    base = np.ascontiguousarray(template + mean_delta, dtype="<f4")
    if not np.isfinite(base).all():
        raise ValueError("morph base contains non-finite coordinates")

    targets: list[np.ndarray] = []
    names: list[str] = []
    expected_offset = (2 * vertex_values) * 4
    for index, target in enumerate(document["targets"]):
        target_id = target["id"]
        if target_id != f"gnm-pca-{index + 1:02d}" or target["label"] != target_id or target["index"] != index:
            raise ValueError("morph target names/indexes must remain neutral and ordered")
        target_delta = block(f"target {index}.delta", target["delta"], expected_offset)
        targets.append(target_delta)
        names.append(target_id)
        expected_offset += vertex_values * 4
    if expected_offset != len(binary):
        raise ValueError("morph payload blocks do not fill the binary exactly")
    return base, targets, names


def build_glb(
    template: np.ndarray,
    triangles: np.ndarray,
    name: str,
    morph: tuple[np.ndarray, list[np.ndarray], list[str]] | None = None,
) -> bytes:
    base = template if morph is None else morph[0]
    target_deltas = [] if morph is None else morph[1]
    target_names = [] if morph is None else morph[2]
    positions = np.ascontiguousarray(base, dtype="<f4").tobytes(order="C")
    indices = triangles.reshape(-1).tobytes(order="C")
    position_offset = 0
    index_offset = len(aligned_binary(positions))
    binary_parts = [aligned_binary(positions), aligned_binary(indices)]
    position_min = base.min(axis=0).tolist()
    position_max = base.max(axis=0).tolist()
    index_count = int(triangles.size)
    vertex_count = int(base.shape[0])
    target_accessors: list[int] = []
    target_views: list[dict] = []
    for target in target_deltas:
        target_bytes = np.ascontiguousarray(target, dtype="<f4").tobytes(order="C")
        target_accessors.append(2 + len(target_accessors))
        target_views.append({
            "buffer": 0,
            "byteLength": len(target_bytes),
            "byteOffset": sum(len(part) for part in binary_parts),
            "target": 34962,
        })
        binary_parts.append(aligned_binary(target_bytes))
    binary = b"".join(binary_parts)

    document = {
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": vertex_count,
                "max": position_max,
                "min": position_min,
                "type": "VEC3",
            },
            {
                "bufferView": 1,
                "componentType": 5125,
                "count": index_count,
                "type": "SCALAR",
            },
        ],
        "asset": {
            "copyright": "GNM template mesh retained for offline Sports Face MVP tooling",
            "generator": "sports-face-mvp tools/gnm/export_gnm_glb.py",
            "version": "2.0",
        },
        "bufferViews": [
            {
                "buffer": 0,
                "byteLength": len(positions),
                "byteOffset": position_offset,
                "target": 34962,
            },
            {
                "buffer": 0,
                "byteLength": len(indices),
                "byteOffset": index_offset,
                "target": 34963,
            },
        ],
        "buffers": [{"byteLength": len(binary)}],
        "materials": [
            {
                "name": "Neutral GNM Template",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [0.72, 0.72, 0.72, 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.9,
                },
            }
        ],
        "meshes": [
            {
                "name": name,
                "primitives": [
                    {
                        "attributes": {"POSITION": 0},
                        "indices": 1,
                        "material": 0,
                        "mode": 4,
                    }
                ],
            }
        ],
        "nodes": [{"mesh": 0, "name": name}],
        "scene": 0,
        "scenes": [{"name": "GNM Template Scene", "nodes": [0]}],
    }
    if morph is not None:
        document["meshes"][0]["extras"] = {"targetNames": target_names}
        document["meshes"][0]["primitives"][0]["targets"] = [{"POSITION": accessor} for accessor in target_accessors]
        document["accessors"].extend(
            {
                "bufferView": index,
                "componentType": 5126,
                "count": vertex_count,
                "type": "VEC3",
            }
            for index in target_accessors
        )
        document["bufferViews"].extend(target_views)
    json_data = aligned_json(json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    total_length = 12 + 8 + len(json_data) + 8 + len(binary)
    return b"".join(
        (
            struct.pack("<4sII", GLB_MAGIC, GLB_VERSION, total_length),
            struct.pack("<II", len(json_data), JSON_CHUNK),
            json_data,
            struct.pack("<II", len(binary), BIN_CHUNK),
            binary,
        )
    )


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        template, triangles = load_mesh(args.input)
        morph = load_morph_metadata(args.morph_metadata, template) if args.morph_metadata else None
        output = build_glb(template, triangles, args.name, morph)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(output)
    except (OSError, ValueError, TypeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    label = " with 16 morph targets" if morph else ""
    print(f"Wrote {args.output}: {template.shape[0]} vertices, {triangles.shape[0]} triangles{label}, {len(output)} bytes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
