#!/usr/bin/env python3
"""Standard-library tests for the official GNM asset intake gate."""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = ROOT / "tools" / "gnm" / "validate_official_bundle.py"
EXAMPLE = ROOT / "tools" / "gnm" / "work" / "official-bundle.example.json"


def run(manifest: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run((sys.executable, str(VALIDATOR), str(manifest)), cwd=ROOT, text=True, capture_output=True)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_manifest(directory: Path) -> Path:
    license_file = directory / "LICENSE.txt"
    license_file.write_text("Official upstream license text fixture.\n", encoding="utf-8")
    roles = {
        "mesh": {"role": "mesh", "vertexCount": 4, "triangleCount": 2, "topologyConsistent": True},
        "uvs": {"role": "uvs", "vertexCount": 4},
        "materialsTextures": {"role": "materialsTextures", "materials": ["skin"], "textures": ["skin.png"]},
        "eyes": {"role": "eyes", "present": True},
        "teeth": {"role": "teeth", "present": True},
        "tongue": {"role": "tongue", "present": True},
    }
    assets = {}
    for role, document in roles.items():
        asset = directory / f"{role}.json"
        asset.write_text(json.dumps(document), encoding="utf-8")
        assets[role] = {"path": asset.name, "sha256": digest(asset), "sizeBytes": asset.stat().st_size}
    manifest = {
        "schema": "sports-face-gnm-official-bundle/v1",
        "status": "accepted",
        "runtimeAllowed": True,
        "source": {
            "repositoryUrl": "https://github.com/google/GNM",
            "upstreamRevision": "a1b2c3d4e5f6",
            "archiveSha256": "a" * 64,
        },
        "license": {
            "name": "Apache License 2.0",
            "spdxId": "Apache-2.0",
            "textPath": "LICENSE.txt",
            "textSha256": digest(license_file),
        },
        "permission": {
            "decision": "approved",
            "reviewer": "reviewer@example.invalid",
            "decisionDate": "2026-08-12",
            "decisionReference": "LEGAL-1234",
        },
        "geometry": {
            "expectedVertexCount": 4,
            "expectedTriangleCount": 2,
            "identityTemplateTopology": {
                "consistent": True,
                "identityCount": 1,
                "templateVertexCount": 4,
                "templateTriangleCount": 2,
                "identityVertexCount": 4,
                "identityTriangleCount": 2,
            },
        },
        "assets": assets,
    }
    path = directory / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return path


def expect_pass(path: Path) -> None:
    result = run(path)
    if result.returncode:
        raise AssertionError(f"expected PASS:\n{result.stdout}\n{result.stderr}")


def expect_fail(path: Path) -> None:
    if run(path).returncode == 0:
        raise AssertionError("expected validator failure")


def test_proposed_missing_assets() -> None:
    expect_pass(EXAMPLE)


def test_accepted_requires_permission(directory: Path) -> None:
    path = write_manifest(directory)
    document = json.loads(path.read_text(encoding="utf-8"))
    document["permission"] = {"decision": "pending", "reviewer": "UNASSIGNED", "decisionDate": "UNSET", "decisionReference": "UNRECORDED"}
    path.write_text(json.dumps(document), encoding="utf-8")
    expect_fail(path)


def test_accepted_rejects_hash_and_unsafe_paths(directory: Path) -> None:
    original = json.loads(write_manifest(directory).read_text(encoding="utf-8"))
    for mutation in (
        lambda document: document["assets"]["mesh"].update(sha256="b" * 64),
        lambda document: document["assets"]["mesh"].update(path="../mesh.json"),
        lambda document: document["assets"]["mesh"].update(path="/tmp/mesh.json"),
    ):
        case = directory / f"case-{len(list(directory.glob('case-*.json')))}.json"
        document = copy.deepcopy(original)
        mutation(document)
        case.write_text(json.dumps(document), encoding="utf-8")
        expect_fail(case)


def test_accepted_rejects_embedded_credentials(directory: Path) -> None:
    document = json.loads(write_manifest(directory).read_text(encoding="utf-8"))
    document["source"]["repositoryUrl"] = "https://user:password@example.invalid/gnm"
    path = directory / "credentials.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    expect_fail(path)


def test_accepted_complete_files_and_permission(directory: Path) -> None:
    expect_pass(write_manifest(directory))


def main() -> int:
    test_proposed_missing_assets()
    with tempfile.TemporaryDirectory(prefix="gnm-official-bundle-test-") as temporary:
        directory = Path(temporary)
        test_accepted_requires_permission(directory)
        test_accepted_rejects_hash_and_unsafe_paths(directory)
        test_accepted_rejects_embedded_credentials(directory)
        test_accepted_complete_files_and_permission(directory)
    print("PASS official GNM bundle tests: proposed placeholders, permission, hashes/paths, complete intake")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
