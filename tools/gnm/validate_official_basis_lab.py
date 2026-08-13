#!/usr/bin/env python3
"""Validate the separately delivered official GNM Basis Lab payload."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys

from build_official_basis_lab import HEADER_BYTES, HEADER_STRUCT, MAGIC, VERSION, SCHEMA


MAX_BYTES = 3 * 1024 * 1024


class ValidationError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate(payload_path: Path, metadata_path: Path, canonical_path: Path | None = None, render_path: Path | None = None) -> dict:
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    payload = payload_path.read_bytes()
    require(len(payload) <= MAX_BYTES and len(payload) == metadata["payload"]["sizeBytes"], "payload exceeds the 3 MiB budget or metadata size")
    require(metadata.get("schema") == SCHEMA, "Basis Lab metadata schema is invalid")
    require(metadata.get("semanticMapping") == "disabled" and metadata.get("runtimeBasisLoaded") is True, "Basis Lab runtime metadata flags are invalid")
    require(metadata["budget"] == {"maxBytes": MAX_BYTES, "withinLimit": True}, "Basis Lab budget metadata is invalid")
    require(metadata["payload"]["sha256"] == sha256(payload_path), "Basis Lab payload SHA-256 does not match")
    if canonical_path is not None:
        require(metadata["source"]["canonicalGlb"]["sha256"] == sha256(canonical_path), "canonical GLB SHA-256 does not match")
    if render_path is not None:
        require(metadata["source"]["renderGlb"]["sha256"] == sha256(render_path), "render GLB SHA-256 does not match")
    require(len(payload) >= HEADER_BYTES, "Basis Lab payload header is truncated")
    magic, version, header_bytes, render_vertices, vector_count, source_offset, vector_offset, vector_bytes = HEADER_STRUCT.unpack_from(payload)
    require(magic == MAGIC and version == VERSION and header_bytes == HEADER_BYTES, "Basis Lab binary header is invalid")
    require(vector_count == 8 and render_vertices == metadata["dimensions"]["renderVertexCount"], "Basis Lab dimensions are invalid")
    require(source_offset == HEADER_BYTES and vector_offset == source_offset + render_vertices * 4, "Basis Lab offsets are invalid")
    require(vector_bytes == vector_count * render_vertices * 12 and vector_offset + vector_bytes == len(payload), "Basis Lab binary lengths are invalid")
    ids = struct.unpack_from(f"<{render_vertices}I", payload, source_offset)
    require(all(source < metadata["dimensions"]["canonicalVertexCount"] for source in ids), "Basis Lab sourceVertexId is out of range")
    require(metadata["selection"]["identity"][0]["index"] == 0 and metadata["selection"]["identity"][-1]["index"] == 3, "identity selection is not first four")
    require(metadata["selection"]["expression"][0]["index"] == 0 and metadata["selection"]["expression"][-1]["index"] == 3, "expression selection is not first four")
    require(sum(record["vertexCount"] for record in metadata["components"]) == render_vertices, "component vertex counts do not sum")
    return metadata


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("payload", type=Path)
    parser.add_argument("metadata", type=Path)
    parser.add_argument("--canonical", type=Path)
    parser.add_argument("--render", type=Path)
    args = parser.parse_args(argv)
    try:
        report = validate(args.payload, args.metadata, args.canonical, args.render)
    except (OSError, KeyError, TypeError, ValueError, struct.error) as error:
        print(f"FAIL {args.payload}: {error}", file=sys.stderr)
        return 1
    print(f"PASS {args.payload}: {report['payload']['sizeBytes']} bytes, 4 identity + 4 expression vectors, strict 3 MiB budget")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
