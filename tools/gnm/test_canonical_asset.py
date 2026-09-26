#!/usr/bin/env python3
"""Focused tests for the canonical GLB Git LFS pointer detector."""

from __future__ import annotations

from pathlib import Path
import tempfile

from canonical_asset import (
    CANONICAL_SHA256,
    CANONICAL_SIZE,
    LFS_POINTER,
    MATERIALIZED,
    CanonicalAssetError,
    canonical_glb_status,
)


def pointer(oid: str = CANONICAL_SHA256, size: int = CANONICAL_SIZE) -> bytes:
    return f"version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize {size}\n".encode("ascii")


def expect_error(path: Path, fragment: str) -> None:
    try:
        canonical_glb_status(path)
    except CanonicalAssetError as error:
        assert fragment in str(error), str(error)
    else:
        raise AssertionError(f"{path.name} unexpectedly passed")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="gnm-canonical-asset-") as temporary:
        directory = Path(temporary)
        valid = directory / "valid.glb"
        valid.write_bytes(pointer())
        assert canonical_glb_status(valid) == LFS_POINTER
        drifted = directory / "drifted.glb"
        drifted.write_bytes(pointer(oid="0" * 64))
        expect_error(drifted, "does not reference the recorded canonical asset")
        resized = directory / "resized.glb"
        resized.write_bytes(pointer(size=CANONICAL_SIZE - 1))
        expect_error(resized, "does not reference the recorded canonical asset")
        malformed = directory / "malformed.glb"
        malformed.write_bytes(b"version https://git-lfs.github.com/spec/v1\nsize 12\n")
        expect_error(malformed, "malformed")
        foreign = directory / "foreign.glb"
        foreign.write_bytes(b"glTF\x02\x00\x00\x00")
        expect_error(foreign, "neither the canonical GLB nor a Git LFS pointer")
        expect_error(directory / "missing.glb", "missing")
        materialized = directory / "materialized.glb"
        materialized.write_bytes(b"glTF" + b"\0" * 2048)
        assert canonical_glb_status(materialized) == MATERIALIZED
    committed = canonical_glb_status()
    assert committed in (LFS_POINTER, MATERIALIZED)
    print(f"PASS canonical GLB detector: verified pointer oid/size, drift/malformed/foreign/missing rejection, materialized passthrough (repository copy: {committed})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
