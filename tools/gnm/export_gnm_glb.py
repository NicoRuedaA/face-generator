#!/usr/bin/env python3
"""Export the retained GNM template mesh to a deterministic binary glTF file."""

from __future__ import annotations

import argparse
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


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help=f"source NPZ (default: {DEFAULT_INPUT})")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help=f"output GLB (default: {DEFAULT_OUTPUT})")
    parser.add_argument("--name", default="GNM Head Template", help="mesh and node name")
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


def build_glb(template: np.ndarray, triangles: np.ndarray, name: str) -> bytes:
    positions = template.tobytes(order="C")
    indices = triangles.reshape(-1).tobytes(order="C")
    position_offset = 0
    index_offset = len(aligned_binary(positions))
    binary = aligned_binary(positions) + aligned_binary(indices)
    position_min = template.min(axis=0).tolist()
    position_max = template.max(axis=0).tolist()
    index_count = int(triangles.size)
    vertex_count = int(template.shape[0])

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
        output = build_glb(template, triangles, args.name)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(output)
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(
        f"Wrote {args.output}: {template.shape[0]} vertices, "
        f"{triangles.shape[0]} triangles, {len(output)} bytes."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
