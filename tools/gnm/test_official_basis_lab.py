#!/usr/bin/env python3
"""Focused deterministic tests for the official GNM Basis Lab payload."""

from __future__ import annotations

import json
from pathlib import Path
import tempfile

from build_official_basis_lab import ROOT, build
from validate_official_basis_lab import validate


def main() -> int:
    canonical = ROOT / "tools/gnm/work/gnm-official-head.glb"
    metadata = ROOT / "tools/gnm/work/gnm-official-head.json"
    render = ROOT / "tools/gnm/work/gnm-official-head-render.glb"
    committed_payload = ROOT / "tools/gnm/work/gnm-official-basis-lab.bin"
    committed_metadata = ROOT / "tools/gnm/work/gnm-official-basis-lab.json"
    with tempfile.TemporaryDirectory(prefix="gnm-basis-lab-") as temporary:
        first_payload = Path(temporary) / "first.bin"
        first_metadata = Path(temporary) / "first.json"
        second_payload = Path(temporary) / "second.bin"
        second_metadata = Path(temporary) / "second.json"
        build(canonical, metadata, render, first_payload, first_metadata)
        build(canonical, metadata, render, second_payload, second_metadata)
        assert first_payload.read_bytes() == second_payload.read_bytes(), "payload is not deterministic"
        assert first_metadata.read_bytes() == second_metadata.read_bytes(), "metadata is not deterministic"
        generated = json.loads(first_metadata.read_text(encoding="utf-8"))
        validate(first_payload, first_metadata, canonical, render)
        first_payload_bytes = first_payload.read_bytes()
        first_metadata_bytes = first_metadata.read_bytes()
    assert committed_payload.read_bytes() == first_payload_bytes, "committed Basis Lab payload is stale"
    assert committed_metadata.read_bytes() == first_metadata_bytes, "committed Basis Lab metadata is stale"
    assert generated["selection"]["identity"] == [{"family": "identity", "index": index, "name": f"head_{index:03d}"} for index in range(4)]
    assert generated["selection"]["expression"] == [{"family": "expression", "index": index, "name": f"left_eye_region_{index:03d}"} for index in range(4)]
    assert generated["dimensions"]["vectorCount"] == 8
    assert generated["payload"]["sizeBytes"] < 3 * 1024 * 1024
    runtime = (ROOT / "src/webgl-renderer.js").read_text(encoding="utf-8")
    assert "WEBGL_OFFICIAL_BASIS_LAB_STYLE" in runtime
    assert "semanticMapping" in runtime and "runtimeBasisLoaded" in runtime
    print("PASS official GNM Basis Lab tests: deterministic binary/metadata, first-four selection, exact budget, metadata hash, runtime boundary")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
