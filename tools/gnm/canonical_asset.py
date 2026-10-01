#!/usr/bin/env python3
"""Detect whether the archived canonical official GNM GLB is materialized.

The canonical `gnm-official-head.glb` (138,998,408 bytes) is tracked with Git
LFS. A checkout without LFS objects only contains the small pointer file.
Tests that regenerate evidence from the canonical asset use this helper to
distinguish three cases explicitly instead of crashing on a bad GLB header:

* ``materialized``: the real GLB is present; callers run their full checks,
  which verify its SHA-256 themselves.
* ``lfs-pointer``: a Git LFS pointer whose ``oid``/``size`` match the recorded
  canonical asset exactly; callers skip only the canonical-dependent checks and
  still validate committed artifacts.
* anything else fails closed (missing file, or a pointer that drifted from the
  recorded hash/size).
"""

from __future__ import annotations

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
CANONICAL_GLB = ROOT / "tools/gnm/work/gnm-official-head.glb"
CANONICAL_SHA256 = "eb1179cb2724b3034e768c13b807f890fac250a5fb9e236a94d4ac345a9d342d"
CANONICAL_SIZE = 138998408
LFS_POINTER_HEADER = b"version https://git-lfs.github.com/spec/v1\n"
LFS_POINTER_MAX_BYTES = 1024
MATERIALIZED = "materialized"
LFS_POINTER = "lfs-pointer"
SKIP_HINT = "run `git lfs pull` to materialize tools/gnm/work/gnm-official-head.glb for the full checks"


class CanonicalAssetError(AssertionError):
    pass


def canonical_glb_status(path: Path = CANONICAL_GLB) -> str:
    """Return MATERIALIZED or LFS_POINTER; raise CanonicalAssetError otherwise."""
    if not path.is_file():
        raise CanonicalAssetError(f"canonical GLB is missing: {path.name}")
    size = path.stat().st_size
    if size > LFS_POINTER_MAX_BYTES:
        return MATERIALIZED
    data = path.read_bytes()
    if not data.startswith(LFS_POINTER_HEADER):
        raise CanonicalAssetError(f"{path.name} is neither the canonical GLB nor a Git LFS pointer")
    text = data.decode("ascii", errors="strict")
    oid = re.search(r"^oid sha256:([0-9a-f]{64})$", text, re.MULTILINE)
    pointer_size = re.search(r"^size (\d+)$", text, re.MULTILINE)
    if not oid or not pointer_size:
        raise CanonicalAssetError(f"{path.name} Git LFS pointer is malformed")
    if oid.group(1) != CANONICAL_SHA256 or int(pointer_size.group(1)) != CANONICAL_SIZE:
        raise CanonicalAssetError(f"{path.name} Git LFS pointer does not reference the recorded canonical asset")
    return LFS_POINTER


def skip_message(test_name: str, checked: str) -> str:
    return (
        f"SKIP {test_name} canonical regeneration: canonical GLB is a verified Git LFS pointer "
        f"(oid sha256:{CANONICAL_SHA256}, size {CANONICAL_SIZE}); {SKIP_HINT}. Still checked: {checked}"
    )
