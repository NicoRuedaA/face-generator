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
MORPH_METADATA = ROOT / "tools" / "gnm" / "work" / "gnm-morph-targets.json"


def run(*command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=ROOT, text=True, capture_output=True)


def expect_success(result: subprocess.CompletedProcess[str]) -> None:
    if result.returncode:
        raise AssertionError(f"command failed:\n{result.stdout}\n{result.stderr}")


def require_numpy_and_source() -> bool:
    if not INPUT.is_file() or not MORPH_METADATA.is_file():
        print("SKIP GNM GLB tests: canonical source unavailable")
        return False
    result = run(sys.executable, "-c", "import numpy")
    if result.returncode:
        print("SKIP GNM GLB tests: NumPy unavailable")
        return False
    return True


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


def test_morph_export_structure_and_mean_base(directory: Path) -> None:
    output = directory / "head-morph.glb"
    expect_success(run(sys.executable, str(EXPORTER), "--input", str(INPUT), "--output", str(output), "--morph-metadata", str(MORPH_METADATA)))
    expect_success(run(sys.executable, str(VALIDATOR), str(output)))
    document = read_json_chunk(output.read_bytes())
    assert len(document["accessors"]) == 18
    assert document["meshes"][0]["extras"]["targetNames"] == [f"gnm-pca-{index + 1:02d}" for index in range(16)]
    assert document["meshes"][0]["primitives"][0]["targets"] == [{"POSITION": index + 2} for index in range(16)]
    metadata = json.loads(MORPH_METADATA.read_text(encoding="utf-8"))
    payload = (MORPH_METADATA.parent / metadata["binary"]["path"]).read_bytes()
    vertex_bytes = metadata["vertexCount"] * 3 * 4
    template = np_from_bytes(payload[:vertex_bytes])
    mean_delta = np_from_bytes(payload[vertex_bytes:2 * vertex_bytes])
    position_length = document["accessors"][0]["count"] * 12
    raw = output.read_bytes()
    json_length = struct.unpack_from("<I", raw, 12)[0]
    bin_start = 20 + json_length + 8
    base = np_from_bytes(raw[bin_start:bin_start + position_length])
    expected = [[f32(template[row][axis] + mean_delta[row][axis]) for axis in range(3)] for row in range(len(template))]
    assert base == expected
    assert document["accessors"][0]["min"] == [min(row[axis] for row in base) for axis in range(3)]


def test_morph_malformed_metadata_and_payload(directory: Path) -> None:
    malformed_metadata = directory / "bad-morph.json"
    document = json.loads(MORPH_METADATA.read_text(encoding="utf-8"))
    document["vertexCount"] += 1
    malformed_metadata.write_text(json.dumps(document), encoding="utf-8")
    result = run(sys.executable, str(EXPORTER), "--input", str(INPUT), "--output", str(directory / "bad.glb"), "--morph-metadata", str(malformed_metadata))
    assert result.returncode != 0

    payload_copy = directory / "payload"
    payload_copy.mkdir()
    copied_metadata = payload_copy / MORPH_METADATA.name
    copied_metadata.write_bytes(MORPH_METADATA.read_bytes())
    copied_binary = payload_copy / "gnm-morph-targets.bin"
    copied_binary.write_bytes((MORPH_METADATA.parent / "gnm-morph-targets.bin").read_bytes()[:-4])
    result = run(sys.executable, str(EXPORTER), "--input", str(INPUT), "--output", str(directory / "bad-payload.glb"), "--morph-metadata", str(copied_metadata))
    assert result.returncode != 0


def test_morph_repeated_output_is_byte_stable(directory: Path) -> None:
    first = directory / "morph-first.glb"
    second = directory / "morph-second.glb"
    for output in (first, second):
        expect_success(run(sys.executable, str(EXPORTER), "--input", str(INPUT), "--output", str(output), "--morph-metadata", str(MORPH_METADATA)))
    assert first.read_bytes() == second.read_bytes()


def f32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


def np_from_bytes(data: bytes) -> list[list[float]]:
    import struct as _struct
    values = [_struct.unpack_from("<f", data, offset)[0] for offset in range(0, len(data), 4)]
    return [values[index:index + 3] for index in range(0, len(values), 3)]


def main() -> int:
    if not require_numpy_and_source():
        return 0
    with tempfile.TemporaryDirectory(prefix="gnm-glb-test-") as temporary:
        directory = Path(temporary)
        test_export_and_validation(directory)
        test_malformed_magic_and_length(directory)
        test_repeated_output_is_byte_stable(directory)
        test_morph_export_structure_and_mean_base(directory)
        test_morph_malformed_metadata_and_payload(directory)
        test_morph_repeated_output_is_byte_stable(directory)
    print("PASS GNM GLB tests: structure/validation, malformed headers, byte stability")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
