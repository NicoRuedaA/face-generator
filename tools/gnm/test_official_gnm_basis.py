#!/usr/bin/env python3
"""Focused deterministic tests for the official GNM basis diagnostic."""

from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
DIAGNOSTIC = ROOT / "tools/gnm/diagnose_official_gnm_basis.py"
REPORT = ROOT / "tools/gnm/work/gnm-official-basis-diagnostic.json"
CANONICAL_HASH = "eb1179cb2724b3034e768c13b807f890fac250a5fb9e236a94d4ac345a9d342d"
RUNTIME_URL = "./tools/gnm/work/gnm-official-head-render.glb"


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=ROOT, text=True, capture_output=True)


def assert_no_absolute_paths(value: object) -> None:
    if isinstance(value, dict):
        for item in value.values():
            assert_no_absolute_paths(item)
    elif isinstance(value, list):
        for item in value:
            assert_no_absolute_paths(item)
    elif isinstance(value, str):
        assert not value.startswith("/"), value
        assert re.match(r"^[A-Za-z]:[\\/]", value) is None, value


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="gnm-basis-diagnostic-") as temporary:
        first = Path(temporary) / "first.json"
        second = Path(temporary) / "second.json"
        for output in (first, second):
            result = run(sys.executable, str(DIAGNOSTIC), "--output", str(output))
            if result.returncode:
                raise AssertionError(f"diagnostic failed:\n{result.stdout}\n{result.stderr}")
        assert first.read_bytes() == second.read_bytes(), "diagnostic output is not deterministic"
        generated = json.loads(first.read_text(encoding="utf-8"))
    committed = json.loads(REPORT.read_text(encoding="utf-8"))
    assert generated == committed, "committed diagnostic report is stale"
    assert generated["schema"] == "sports-face-gnm-official-basis-diagnostic/v1"
    assert generated["dimensions"] == {"vertexCount": 17821, "identityCount": 253, "expressionCount": 383}
    assert len(generated["names"]["identity"]) == 253
    assert len(generated["names"]["expression"]) == 383
    assert all(generated["names"][family] for family in ("identity", "expression"))
    assert generated["source"]["canonicalGlb"]["sha256"] == CANONICAL_HASH
    assert generated["accessors"]["template"]["finite"] is True
    assert generated["accessors"]["template"]["count"] == 17821
    for family, count in (("identity", 253), ("expression", 383)):
        basis = generated["accessors"]["basis"][family]
        assert basis["count"] == count
        assert basis["byteLength"] == count * 17821 * 12
        assert basis["exactPayloadLength"] is True
        assert basis["finite"] is True
        assert generated["reconstruction"][family]["allPassed"] is True
        assert all(sample["zeroMatchesTemplate"] and sample["oneHotMatchesTemplatePlusBasis"] for sample in generated["reconstruction"][family]["samples"])
    assert generated["componentMappings"]["sourceRanges"] == {"disjoint": True, "exhaustive": True, "vertexCount": 17821}
    assert all(record["positionMatchesTemplateBySourceId"] for record in generated["componentMappings"]["canonical"])
    assert generated["componentMappings"]["optimizedRender"]["status"] == "pass"
    assert generated["source"]["renderGlb"]["basisIncluded"] is False
    assert generated["semanticMapping"] == "disabled"
    assert generated["runtimeBasisLoaded"] is False
    assert_no_absolute_paths(generated)

    render_metadata = json.loads((ROOT / "tools/gnm/work/gnm-official-head-render.json").read_text(encoding="utf-8"))
    assert render_metadata["basisIncluded"] is False
    runtime_source = (ROOT / "src/webgl-renderer.js").read_text(encoding="utf-8")
    assert f'WEBGL_OFFICIAL_ASSET_URL = "{RUNTIME_URL}"' in runtime_source
    print("PASS official GNM basis tests: deterministic report, dimensions/names, finite float32 payloads, reconstruction, source mappings, canonical hash, render-only boundary, runtime URL")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
