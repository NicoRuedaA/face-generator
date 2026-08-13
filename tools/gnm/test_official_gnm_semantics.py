#!/usr/bin/env python3
"""Focused deterministic tests for the official GNM semantic evidence report."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
ANALYZER = ROOT / "tools/gnm/analyze_official_gnm_semantics.py"
REPORT = ROOT / "tools/gnm/work/gnm-official-semantic-evidence.json"
FORBIDDEN_FILES = (
    "src/app.js", "src/webgl-renderer.js", "src/render-router.js", "src/face-model.js", "src/morphology.js", "src/app.bundle.js",
    "tools/gnm/work/gnm-official-head.glb", "tools/gnm/work/gnm-official-head-render.glb",
    "tools/gnm/work/gnm-official-basis-lab.bin", "tools/gnm/work/gnm-official-basis-lab.json",
    "tools/gnm/work/gnm-morphology-pack.json", "tools/gnm/work/gnm-vertex-map.json",
)


def run(output: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run((sys.executable, str(ANALYZER), "--output", str(output)), cwd=ROOT, env=env, text=True, capture_output=True)


def run_with_args(output: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run((sys.executable, str(ANALYZER), *args, "--output", str(output)), cwd=ROOT, text=True, capture_output=True)


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


def report_hash(report: dict) -> str:
    payload = json.dumps({key: value for key, value in report.items() if key != "reportHashSha256"}, ensure_ascii=True, indent=2, sort_keys=True) + "\n"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def mutate_accessor_byte_length(directory: Path) -> Path:
    source = ROOT / "tools/gnm/work/gnm-official-head.glb"
    raw = bytearray(source.read_bytes())
    json_length = struct.unpack_from("<I", raw, 12)[0]
    payload = raw[20:20 + json_length]
    original = b'"byteLength":54104556'
    mutated = b'"byteLength":54104552'
    assert payload.count(original) == 1, "fixture accessor metadata was not found"
    raw[20:20 + json_length] = payload.replace(original, mutated)
    output = directory / "malformed-accessor.glb"
    output.write_bytes(raw)
    return output


def main() -> int:
    before = {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in FORBIDDEN_FILES}
    with tempfile.TemporaryDirectory(prefix="gnm-semantic-evidence-", dir=ROOT) as temporary:
        first = Path(temporary) / "first.json"
        second = Path(temporary) / "second.json"
        simulated_git = Path(temporary) / "git"
        simulated_git.write_text("#!/bin/sh\nprintf '%s\\n' ffffffffffffffffffffffffffffffffffffffff\n", encoding="utf-8")
        simulated_git.chmod(0o755)
        simulated_head_env = {**os.environ, "PATH": f"{temporary}{os.pathsep}{os.environ['PATH']}"}
        for output in (first, second):
            result = run(output)
            assert result.returncode == 0, f"analysis failed:\n{result.stdout}\n{result.stderr}"
        assert first.read_bytes() == second.read_bytes(), "semantic evidence is not deterministic"
        simulated = Path(temporary) / "simulated-post-commit.json"
        result = run(simulated, simulated_head_env)
        assert result.returncode == 0, f"simulated post-commit analysis failed:\n{result.stdout}\n{result.stderr}"
        assert simulated.read_bytes() == first.read_bytes(), "report changed when simulated live HEAD changed"
        generated = json.loads(first.read_text(encoding="utf-8"))
        malformed_glb = mutate_accessor_byte_length(Path(temporary))
        malformed_report = Path(temporary) / "malformed.json"
        result = run_with_args(malformed_report, "--canonical", str(malformed_glb))
        assert result.returncode != 0, "malformed accessor metadata unexpectedly passed"
    committed = json.loads(REPORT.read_text(encoding="utf-8"))
    assert generated == committed, "committed semantic evidence report is stale"
    assert generated["schema"] == "sports-face-gnm-semantic-evidence/v1"
    assert generated["semanticMapping"] == "unestablished"
    assert generated["runtimeBasisLoaded"] is False
    assert generated["dimensions"] == {"vertexCount": 17821, "identityCount": 253, "expressionCount": 383}
    assert generated["source"]["upstreamRevision"] == "8ea2906a31aab7f8b550e33968f3c0a86051a92d"
    assert generated["source"]["evidenceBaseRevision"] == "da9982f"
    assert "workingTreeHead" not in generated["source"]
    assert generated["source"]["files"]["diagnostic"]["sha256"] == hashlib.sha256((ROOT / "tools/gnm/work/gnm-official-basis-diagnostic.json").read_bytes()).hexdigest()
    assert generated["source"]["files"]["render_metadata"]["sha256"] == hashlib.sha256((ROOT / "tools/gnm/work/gnm-official-head-render.json").read_bytes()).hexdigest()
    assert generated["reportHashSha256"] == report_hash(generated)
    assert len(REPORT.read_bytes()) <= 600_000
    assert generated["precisionPolicy"]["rawBasisArraysIncluded"] is False
    assert generated["precisionPolicy"]["reportSizeBudgetBytes"] == 600_000
    assert len(generated["basis"]["identity"]["basis"]) == 253
    assert len(generated["basis"]["expression"]["basis"]) == 383
    assert generated["basis"]["identity"]["totalEnergy"] > 0 and generated["basis"]["expression"]["totalEnergy"] > 0
    assert generated["basis"]["identity"]["groups"] | generated["basis"]["expression"]["groups"]
    assert {key: value["count"] for key, value in generated["basis"]["identity"]["groups"].items()} == {"head": 170, "eyes": 3, "teeth": 80}
    assert {key: value["count"] for key, value in generated["basis"]["expression"]["groups"].items()} == {"left_eye_region": 100, "right_eye_region": 100, "lower_face_region": 150, "tongue": 32, "pupils": 1}
    for family in ("identity", "expression"):
        record = generated["basis"][family]
        assert all(value >= 0 and value < float("inf") for item in record["basis"] for value in (item["energy"], item["l2Norm"], item["maxAbsDisplacement"]))
        assert abs(sum(item["energy"] for item in record["basis"]) - record["totalEnergy"]) < 1e-12
        assert abs(sum(item["share"] for item in record["basis"]) - 1.0) < 1e-12
        assert all(abs(item["energy"] - sum(item["componentEnergy"].values())) < 1e-12 for item in record["basis"])
    assert generated["technicalGrouping"]["descriptiveOnly"] is True
    assert generated["technicalGrouping"]["semanticClaim"] is False
    assert generated["landmarkRegionEnergy"]["status"] == "provisional-descriptive-only"
    assert generated["landmarkRegionEnergy"]["anatomicalCorrectness"] == "not_proven"
    landmark_report = generated["landmarkRegionEnergy"]
    assert landmark_report["declaredIdValidation"]["status"] == "passed"
    assert landmark_report["assignmentCount"] == 827
    assert landmark_report["uniqueVertexCount"] == 811
    assert landmark_report["overlapAssignmentCount"] == 16
    assert landmark_report["maxRegionsPerVertex"] == 2
    assert landmark_report["regionsAreNonExclusive"] is True
    assert "must not be summed" in landmark_report["sumWarning"]
    assert generated["faceDna"]["variableCount"] == 17
    assert [item["key"] for item in generated["faceDna"]["variables"]] == ["head", "skin", "eyes", "brows", "nose", "mouth", "freckles", "eyeColor", "earShape", "jaw", "faceProportion", "hair", "beard", "hairColor", "hairVisible", "glasses", "scar"]
    assert all(len(item["values"]) == item["validValues"] for item in generated["faceDna"]["variables"])
    assert {item["key"]: item["reservedStatus"] for item in generated["faceDna"]["variables"] if item["reserved"]} == {"earShape": "reserved-renderer", "jaw": "reserved-renderer", "faceProportion": "reserved-renderer"}
    assert {item["key"] for item in generated["faceDna"]["variables"] if item["reserved"]} == {"earShape", "jaw", "faceProportion"}
    assert generated["morphology"]["featureCount"] == 14
    assert generated["morphology"]["familySelection"]["ruleCount"] == 8
    assert any("No paired FaceDNA" in item for item in generated["missingEvidence"])
    assert len(generated["futureAcceptanceCriteria"]) == 8
    assert_no_absolute_paths(generated)
    after = {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in FORBIDDEN_FILES}
    assert before == after, "analysis changed forbidden runtime/asset files"
    print("PASS official GNM semantic evidence: deterministic report, malformed accessor rejection, overlap/ID validation, precision/size policy, catalog/status coverage, forbidden-file hashes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
