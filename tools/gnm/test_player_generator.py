#!/usr/bin/env python3
"""Focused tests for the GNM 3D player-generator payload and its validator.

The committed payload is always validated (stdlib only) together with
fail-closed mutation cases. When the pinned upstream inputs and NumPy/h5py
are available, the payload is rebuilt twice and must match the committed
artifacts byte for byte; otherwise that part is reported as SKIP.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re
import struct
import tempfile

import build_player_generator as builder
from validate_player_generator import MAX_BYTES, ValidationError, validate


ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "tools/gnm/work"
PAYLOAD = WORK / "gnm-player-generator.bin"
METADATA = WORK / "gnm-player-generator.json"
RENDER = WORK / "gnm-official-head-render.glb"
LICENSE = WORK / "LICENSE-GNM.txt"


def expect_failure(payload: Path, metadata: Path, fragment: str) -> None:
    try:
        validate(payload, metadata, RENDER, LICENSE)
    except (ValidationError, KeyError, ValueError, struct.error) as error:
        assert fragment in str(error), f"unexpected failure for {fragment!r}: {error}"
    else:
        raise AssertionError(f"mutation unexpectedly passed: {fragment}")


def mutate_metadata(directory: Path, name: str, change) -> Path:
    document = json.loads(METADATA.read_text(encoding="utf-8"))
    change(document)
    path = directory / f"{name}.json"
    path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def mutation_tests(directory: Path) -> int:
    flipped = directory / "flipped.bin"
    data = bytearray(PAYLOAD.read_bytes())
    data[len(data) // 2] ^= 0x01
    flipped.write_bytes(bytes(data))
    expect_failure(flipped, METADATA, "SHA-256")
    cases = [
        ("schema", lambda doc: doc.update(schema="sports-face-gnm-player-generator/v0"), "schema"),
        ("mapping", lambda doc: doc.update(semanticMapping="disabled"), "semanticMapping"),
        ("textures", lambda doc: doc.update(officialTexturesIncluded=True), "safety flags"),
        ("budget", lambda doc: doc["budget"].update(maxBytes=MAX_BYTES * 2), "budget"),
        ("npz", lambda doc: doc["source"]["npz"].update(sha256="0" * 64), "npz provenance"),
        ("landmarks", lambda doc: doc["source"]["landmarks"].update(revision="8ea2906a31aab7f8b550e33968f3c0a86051a92d"), "landmarks provenance"),
        ("gradient", lambda doc: doc["features"][0]["normalizedGradient"].pop(), "gradient is invalid"),
        ("normalization", lambda doc: doc["features"][3]["normalizedGradient"].__setitem__(0, 5.0), "not normalized"),
        ("featureOrder", lambda doc: doc["features"].reverse(), "feature keys"),
        ("term", lambda doc: doc["features"][0]["terms"][0].update(landmark=99), "term reference"),
        ("landmarkRows", lambda doc: doc["landmarks"]["definitions"].pop(), "68 rows"),
        ("preset", lambda doc: doc["expressionPresets"][1].update(officialClass="SMILE_WIDE"), "expression presets"),
        ("fieldOrder", lambda doc: doc["fields"].reverse(), "field keys"),
        ("absolute", lambda doc: doc["source"]["npz"].update(path="/home/nico/src/GNM/gnm_head.npz"), "absolute path"),
        ("fixed", lambda doc: doc["fixedVertices"].update(foreheadTop=SOURCE_OUT_OF_RANGE), "fixed vertices"),
    ]
    for name, change, fragment in cases:
        expect_failure(PAYLOAD, mutate_metadata(directory, name, change), fragment)
    return len(cases) + 1


SOURCE_OUT_OF_RANGE = 17821


def rebuild_inputs() -> tuple[Path, Path, Path] | None:
    if importlib.util.find_spec("numpy") is None or importlib.util.find_spec("h5py") is None:
        return None
    inputs = (builder.DEFAULT_NPZ, builder.DEFAULT_LANDMARKS, builder.DEFAULT_DECODER)
    return inputs if all(path.is_file() for path in inputs) else None


def main() -> int:
    metadata = validate(PAYLOAD, METADATA, RENDER, LICENSE)
    runtime = (ROOT / "src/gnm-player-model.js").read_text(encoding="utf-8")
    assert 'GNM_PLAYER_PAYLOAD_URL = "./tools/gnm/work/gnm-player-generator.bin"' in runtime
    assert 'GNM_PLAYER_METADATA_URL = "./tools/gnm/work/gnm-player-generator.json"' in runtime
    budget = re.search(r"GNM_PLAYER_MAX_BYTES = ([\d_]+);", runtime)
    assert budget and int(budget.group(1).replace("_", "")) == MAX_BYTES == builder.MAX_BYTES
    assert metadata["dimensions"]["identityPriorCount"] == builder.IDENTITY_PRIOR_COUNT
    assert [item[0] for item in builder.FEATURES] == [record["key"] for record in metadata["features"]]
    assert [item[0] for item in builder.FIELDS] == [record["key"] for record in metadata["fields"]]
    with tempfile.TemporaryDirectory(prefix="gnm-player-generator-") as temporary:
        directory = Path(temporary)
        mutations = mutation_tests(directory)
        inputs = rebuild_inputs()
        if inputs is None:
            print(f"PASS GNM player generator tests: committed payload validated, {mutations} fail-closed mutations rejected")
            print("SKIP GNM player generator rebuild: pinned upstream NPZ/landmarks/decoder or NumPy/h5py unavailable (set GNM_ROOT or GNM_NPZ/GNM_LANDMARKS/GNM_EXPRESSION_DECODER)")
            return 0
        outputs = []
        for run in ("first", "second"):
            payload = directory / f"{run}.bin"
            report = directory / f"{run}.json"
            builder.build(*inputs, RENDER, LICENSE, payload, report)
            outputs.append((payload.read_bytes(), report.read_bytes()))
        assert outputs[0] == outputs[1], "player generator build is not deterministic"
        assert outputs[0][0] == PAYLOAD.read_bytes(), "committed player generator payload is stale"
        assert outputs[0][1] == METADATA.read_bytes(), "committed player generator metadata is stale"
    print(f"PASS GNM player generator tests: committed payload validated, {mutations} fail-closed mutations rejected, deterministic byte-exact rebuild from pinned upstream inputs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
