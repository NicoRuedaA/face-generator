#!/usr/bin/env python3
"""Focused exact-equality tests for the official GNM render optimization."""

from __future__ import annotations

import json
from pathlib import Path
import struct
import subprocess
import sys

from optimize_official_gnm_glb import COMPONENTS, read_glb, accessor_bytes


ROOT = Path(__file__).resolve().parents[2]
CANONICAL = ROOT / "tools/gnm/work/gnm-official-head.glb"
RENDER = ROOT / "tools/gnm/work/gnm-official-head-render.glb"
METADATA = ROOT / "tools/gnm/work/gnm-official-head-render.json"
MANIFEST = ROOT / "tools/gnm/work/official-render-bundle.json"
LICENSE = ROOT / "tools/gnm/work/LICENSE-GNM.txt"
VALIDATOR = ROOT / "tools/gnm/validate_official_gnm_render.py"


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=ROOT, text=True, capture_output=True)


def decoded(document: dict, binary: bytes, primitive: dict) -> tuple[list[bytes], list[bytes], list[int]]:
    position_accessor, position_payload, _ = accessor_bytes(document, binary, primitive["attributes"]["POSITION"])
    uv_accessor, uv_payload, _ = accessor_bytes(document, binary, primitive["attributes"]["TEXCOORD_0"])
    index_accessor, index_payload, _ = accessor_bytes(document, binary, primitive["indices"])
    positions = [position_payload[offset:offset + 12] for offset in range(0, position_accessor["count"] * 12, 12)]
    uvs = [uv_payload[offset:offset + 8] for offset in range(0, uv_accessor["count"] * 8, 8)]
    component_size = 4 if index_accessor["componentType"] == 5125 else 2
    indices = list(struct.unpack(f"<{index_accessor['count']}{'I' if component_size == 4 else 'H'}", index_payload))
    return positions, uvs, indices


def main() -> int:
    result = run(sys.executable, str(VALIDATOR), str(RENDER), str(METADATA), str(MANIFEST), "--license", str(LICENSE))
    if result.returncode:
        raise AssertionError(f"render validator failed:\n{result.stdout}\n{result.stderr}")
    canonical_document, canonical_binary = read_glb(CANONICAL)
    render_document, render_binary = read_glb(RENDER)
    canonical_primitives = canonical_document["meshes"][0]["primitives"]
    render_primitives = render_document["meshes"][0]["primitives"]
    assert [p["extras"]["componentName"] for p in render_primitives] == list(COMPONENTS)
    metadata = json.loads(METADATA.read_text(encoding="utf-8"))
    assert metadata["lossless"]["lossyConversion"] is False
    assert metadata["lossless"]["quantization"] == "none"
    for component, canonical_primitive, render_primitive in zip(COMPONENTS, canonical_primitives, render_primitives):
        canonical_positions, canonical_uvs, canonical_indices = decoded(canonical_document, canonical_binary, canonical_primitive)
        render_positions, render_uvs, render_indices = decoded(render_document, render_binary, render_primitive)
        reconstructed_positions = [render_positions[index] for index in render_indices]
        reconstructed_uvs = [render_uvs[index] for index in render_indices]
        assert reconstructed_positions == [canonical_positions[index] for index in canonical_indices], component
        assert reconstructed_uvs == [canonical_uvs[index] for index in canonical_indices], component
        assert len(canonical_indices) == len(render_indices)
        assert len(canonical_indices) // 3 == metadata["geometry"]["componentTriangleCounts"][component]
    assert "basis" not in render_document["extras"]["sportsFaceGnmOfficial"]
    print("PASS official GNM render tests: exact decoded POSITION/UV triangle equality, index remap, triangle counts, six components, basis omitted, no quantization")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
