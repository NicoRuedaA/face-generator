#!/usr/bin/env python3
"""Deterministic tests for the offline GNM GLB exporter and validator."""

from __future__ import annotations

import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
EXPORTER = ROOT / "tools" / "gnm" / "export_gnm_glb.py"
VALIDATOR = ROOT / "tools" / "gnm" / "validate_gnm_glb.py"
INPUT = ROOT / "tools" / "gnm" / "work" / "gnm-heads-200.npz"


def run(*command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=ROOT, text=True, capture_output=True)


def expect_success(result: subprocess.CompletedProcess[str]) -> None:
    if result.returncode:
        raise AssertionError(f"command failed:\n{result.stdout}\n{result.stderr}")


def read_json_chunk(data: bytes) -> dict:
    length, chunk_type = struct.unpack_from("<II", data, 12)
    if chunk_type != 0x4E4F534A:
        raise AssertionError("first GLB chunk is not JSON")
    return json.loads(data[20:20 + length])


def test_export_and_validation(directory: Path) -> None:
    output = directory / "head.glb"
    expect_success(run(sys.executable, str(EXPORTER), "--input", str(INPUT), "--output", str(output), "--name", "Test GNM Head"))
    result = run(sys.executable, str(VALIDATOR), str(output))
    expect_success(result)
    document = read_json_chunk(output.read_bytes())
    assert document["asset"]["version"] == "2.0"
    assert document["scenes"] == [{"name": "GNM Template Scene", "nodes": [0]}]
    assert document["accessors"][0]["count"] == 17821
    assert document["accessors"][1]["count"] == 105972
    assert document["meshes"][0]["name"] == "Test GNM Head"


def test_malformed_magic_and_length(directory: Path) -> None:
    source = directory / "source.glb"
    expect_success(run(sys.executable, str(EXPORTER), "--input", str(INPUT), "--output", str(source)))
    original = bytearray(source.read_bytes())
    bad_magic = directory / "bad-magic.glb"
    bad_magic.write_bytes(b"BAD!" + original[4:])
    assert run(sys.executable, str(VALIDATOR), str(bad_magic)).returncode != 0
    bad_length = directory / "bad-length.glb"
    bad_length.write_bytes(original[:8] + struct.pack("<I", len(original) + 4) + original[12:])
    assert run(sys.executable, str(VALIDATOR), str(bad_length)).returncode != 0


def test_repeated_output_is_byte_stable(directory: Path) -> None:
    first = directory / "first.glb"
    second = directory / "second.glb"
    for output in (first, second):
        expect_success(run(sys.executable, str(EXPORTER), "--input", str(INPUT), "--output", str(output)))
    if first.read_bytes() != second.read_bytes():
        raise AssertionError("repeated exporter output differs byte-for-byte")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="gnm-glb-test-") as temporary:
        directory = Path(temporary)
        test_export_and_validation(directory)
        test_malformed_magic_and_length(directory)
        test_repeated_output_is_byte_stable(directory)
    print("PASS GNM GLB tests: structure/validation, malformed headers, byte stability")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
