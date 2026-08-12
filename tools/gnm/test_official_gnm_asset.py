#!/usr/bin/env python3
"""Focused tests for the official GNM importer and package validator."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
IMPORTER = ROOT / "tools/gnm/import_official_gnm_npz.py"
VALIDATOR = ROOT / "tools/gnm/validate_official_gnm_asset.py"
SOURCE = Path("/home/nico/src/GNM/gnm/shape/data/versions/v3_0/gnm_head.npz")


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=ROOT, text=True, capture_output=True)


def main() -> int:
    if not SOURCE.is_file():
        print("SKIP official GNM asset tests: external NPZ unavailable")
        return 0
    with tempfile.TemporaryDirectory(prefix="gnm-official-asset-test-") as temporary:
        directory = Path(temporary)
        glb = directory / "gnm-official-head.glb"
        metadata = directory / "gnm-official-head.json"
        manifest = directory / "manifest.json"
        license_path = directory / "LICENSE.txt"
        importer_python = "/home/nico/src/GNM/gnm/shape/.venv/bin/python"
        result = run(importer_python, str(IMPORTER), "--output", str(glb), "--metadata", str(metadata), "--manifest", str(manifest), "--license-output", str(license_path))
        if result.returncode:
            raise AssertionError(f"import failed:\n{result.stdout}\n{result.stderr}")
        # The validator is intentionally tested against a package-local manifest.
        result = run(sys.executable, str(VALIDATOR), str(manifest))
        if result.returncode:
            raise AssertionError(f"validation failed:\n{result.stdout}\n{result.stderr}")
        document = json.loads(metadata.read_text(encoding="utf-8"))
        assert document["geometry"] == {"vertexCount": 17821, "triangleCount": 35324, "quadCount": 17662, "identityCount": 253, "expressionCount": 383, "componentTriangleCounts": {"skin": 24820, "left_eye": 1512, "right_eye": 1512, "upper_teeth_and_gums": 2828, "lower_teeth_and_gums": 2828, "tongue": 1824}}
        assert [component["name"] for component in document["components"]] == ["skin", "left_eye", "right_eye", "upper_teeth_and_gums", "lower_teeth_and_gums", "tongue"]
        assert all(component["uvSeams"] == "preserved-by-corner-split" for component in document["components"])
        assert document["mapping"]["identity"]["applied"] is False
        assert document["mapping"]["expression"]["applied"] is False
        assert document["mapping"]["identityOnlyInvariant"] is True
        first = directory / "first.glb"
        second = directory / "second.glb"
        for output in (first, second):
            result = run(importer_python, str(IMPORTER), "--output", str(output), "--metadata", str(directory / f"{output.stem}.json"), "--manifest", str(directory / f"{output.stem}.manifest.json"), "--license-output", str(directory / f"{output.stem}.LICENSE"))
            if result.returncode:
                raise AssertionError(result.stderr)
        assert first.read_bytes() == second.read_bytes(), "official GLB export is not byte-stable"
    print("PASS official GNM asset tests: import, package validation, dimensions, components, UV seam policy, neutral mapping, determinism")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
