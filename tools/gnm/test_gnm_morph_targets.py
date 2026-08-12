#!/usr/bin/env python3
"""Focused tests for deterministic offline GNM PCA morph targets."""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
BUILDER = ROOT / "tools" / "gnm" / "build_gnm_morph_targets.py"
VALIDATOR = ROOT / "tools" / "gnm" / "validate_gnm_morph_targets.py"
INPUT = ROOT / "tools" / "gnm" / "work" / "gnm-heads-200.npz"


def run(*command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=ROOT, text=True, capture_output=True)


def expect_success(result: subprocess.CompletedProcess[str]) -> None:
    if result.returncode:
        raise AssertionError(f"command failed:\n{result.stdout}\n{result.stderr}")


def require_numpy_and_source() -> bool:
    if not INPUT.is_file():
        print("SKIP GNM morph-target tests: source NPZ unavailable")
        return False
    result = run(sys.executable, "-c", "import numpy")
    if result.returncode:
        print("SKIP GNM morph-target tests: NumPy unavailable")
        return False
    return True


def build(directory: Path, name: str = "targets.json", target_count: int = 16) -> tuple[Path, Path]:
    output = directory / name
    expect_success(run(sys.executable, str(BUILDER), "--input", str(INPUT), "--output", str(output), "--target-count", str(target_count)))
    return output, output.with_suffix(".bin")


def test_generation_and_validation(directory: Path) -> None:
    output, binary = build(directory)
    result = run(sys.executable, str(VALIDATOR), str(output))
    expect_success(result)
    document = json.loads(output.read_text(encoding="utf-8"))
    assert document["schema"] == "sports-face-gnm-morph-targets/v1"
    assert document["vertexCount"] == 17821
    assert document["targetCount"] == 16
    assert len(document["targets"]) == 16
    assert binary.stat().st_size == document["binary"]["byteLength"]
    assert document["source"]["meshArray"] == "vertices"
    assert document["source"]["identitiesInterpretation"] == "parameter vectors, not mesh data"


def test_repeated_output_is_byte_stable(directory: Path) -> None:
    first_directory = directory / "first"
    second_directory = directory / "second"
    first_directory.mkdir()
    second_directory.mkdir()
    first, first_binary = build(first_directory)
    second, second_binary = build(second_directory)
    assert first.read_bytes() == second.read_bytes()
    assert first_binary.read_bytes() == second_binary.read_bytes()


def test_malformed_metadata_and_payload(directory: Path) -> None:
    output, binary = build(directory)
    document = json.loads(output.read_text(encoding="utf-8"))
    document["targets"][0]["id"] = document["targets"][1]["id"]
    malformed_metadata = directory / "metadata.json"
    malformed_metadata.write_text(json.dumps(document), encoding="utf-8")
    assert run(sys.executable, str(VALIDATOR), str(malformed_metadata)).returncode != 0

    payload_directory = directory / "payload"
    payload_directory.mkdir()
    malformed_output = payload_directory / output.name
    shutil.copyfile(output, malformed_output)
    malformed_binary = payload_directory / binary.name
    shutil.copyfile(binary, malformed_binary)
    malformed_binary.write_bytes(malformed_binary.read_bytes()[:-4])
    assert run(sys.executable, str(VALIDATOR), str(malformed_output)).returncode != 0


def test_target_count_rejection(directory: Path) -> None:
    for target_count in (11, 21):
        result = run(sys.executable, str(BUILDER), "--input", str(INPUT), "--output", str(directory / f"bad-{target_count}.json"), "--target-count", str(target_count))
        assert result.returncode != 0


def main() -> int:
    if not require_numpy_and_source():
        return 0
    with tempfile.TemporaryDirectory(prefix="gnm-morph-target-test-") as temporary:
        directory = Path(temporary)
        test_generation_and_validation(directory)
        test_repeated_output_is_byte_stable(directory)
        test_malformed_metadata_and_payload(directory)
        test_target_count_rejection(directory)
    print("PASS GNM morph-target tests: generation/validation, determinism, malformed inputs, target bounds")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
