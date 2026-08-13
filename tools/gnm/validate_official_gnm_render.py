#!/usr/bin/env python3
"""Stdlib-only validator for the lossless official GNM render package."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys


COMPONENTS = ("skin", "left_eye", "right_eye", "upper_teeth_and_gums", "lower_teeth_and_gums", "tongue")
SCHEMA = "sports-face-gnm-official-head-render/v1"
MANIFEST_SCHEMA = "sports-face-gnm-official-render-bundle/v1"
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


class ValidationError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    require(len(data) >= 20, "GLB is shorter than its header")
    magic, version, length = struct.unpack_from("<4sII", data)
    require(magic == b"glTF" and version == 2 and length == len(data), "GLB header is invalid")
    offset = 12
    chunks = []
    while offset < len(data):
        require(offset + 8 <= len(data), "GLB chunk header is truncated")
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        start = offset + 8
        end = start + chunk_length
        require(chunk_length % 4 == 0 and end <= len(data), "GLB chunk range is invalid")
        chunks.append((chunk_type, data[start:end]))
        offset = end
    require(len(chunks) == 2 and chunks[0][0] == JSON_CHUNK and chunks[1][0] == BIN_CHUNK, "GLB must contain JSON then BIN")
    return json.loads(chunks[0][1].decode("utf-8")), chunks[1][1]


def accessor(document: dict, binary: bytes, index: int) -> tuple[dict, bytes]:
    record = document["accessors"][index]
    view = document["bufferViews"][record["bufferView"]]
    offset = view.get("byteOffset", 0) + record.get("byteOffset", 0)
    payload = binary[offset:offset + view["byteLength"]]
    require(offset % 4 == 0 and len(payload) == view["byteLength"], f"accessor {index} is outside BIN")
    return record, payload


def validate_glb(path: Path, metadata: dict) -> tuple[int, dict[str, int]]:
    document, binary = read_glb(path)
    require(document.get("asset", {}).get("version") == "2.0", "GLB is not glTF 2.0")
    require(document.get("scene") == 0 and len(document.get("scenes", [])) == 1, "GLB scene structure is invalid")
    require(len(document.get("nodes", [])) == 1 and len(document.get("meshes", [])) == 1, "GLB node/mesh structure is invalid")
    require(document["buffers"][0]["byteLength"] == len(binary), "GLB BIN byteLength is invalid")
    official = document.get("extras", {}).get("sportsFaceGnmOfficial", {})
    require(official.get("schema") == "sports-face-gnm-official-head/v1", "official schema is missing")
    require(official.get("renderOnly") is True and official.get("basisIncluded") is False, "render-only flags are invalid")
    require("basis" not in official, "render GLB must not contain basis metadata")
    primitives = document["meshes"][0].get("primitives", [])
    require(len(primitives) == len(COMPONENTS) and len(document.get("materials", [])) == len(COMPONENTS), "GLB must contain six components/materials")
    require(all(accessor.get("componentType") != 5125 for accessor in document.get("accessors", []) if accessor.get("type") == "VEC3"), "render GLB must not carry uint32 position accessors")
    counts: dict[str, int] = {}
    total_vertices = 0
    for index, (primitive, component) in enumerate(zip(primitives, COMPONENTS)):
        require(primitive.get("extras", {}).get("componentName") == component, f"primitive {index} component order is invalid")
        require(primitive.get("mode") == 4 and primitive.get("material") == index, f"primitive {index} mode/material is invalid")
        position, position_payload = accessor(document, binary, primitive["attributes"]["POSITION"])
        uv, uv_payload = accessor(document, binary, primitive["attributes"]["TEXCOORD_0"])
        indices, index_payload = accessor(document, binary, primitive["indices"])
        source, source_payload = accessor(document, binary, primitive["extras"]["sourceVertexIndicesAccessor"])
        require(position.get("componentType") == 5126 and position.get("type") == "VEC3", f"{component} positions are not float32 VEC3")
        require(uv.get("componentType") == 5126 and uv.get("type") == "VEC2", f"{component} UVs are not float32 VEC2")
        require(indices.get("componentType") == 5123 and indices.get("type") == "SCALAR", f"{component} indices are not uint16 SCALAR")
        require(source.get("componentType") == 5125 and source.get("type") == "SCALAR", f"{component} source mapping is not uint32 SCALAR")
        require(position["count"] == uv["count"] == source["count"] and len(position_payload) == position["count"] * 12 and len(uv_payload) == uv["count"] * 8, f"{component} attribute counts are invalid")
        require(len(index_payload) == indices["count"] * 2 and indices["count"] % 3 == 0, f"{component} index payload is invalid")
        values = struct.unpack(f"<{indices['count']}H", index_payload)
        require(max(values, default=0) < position["count"], f"{component} index is out of range")
        require(len(source_payload) == source["count"] * 4, f"{component} source mapping payload is invalid")
        require(document["materials"][index].get("extras", {}).get("materialSource") == "neutral-procedural", f"{component} material is not neutral procedural")
        require(document["materials"][index].get("extras", {}).get("officialTexturesIncluded") is False, f"{component} claims official textures")
        counts[component] = indices["count"] // 3
        total_vertices += position["count"]
    require(metadata.get("schema") == SCHEMA and metadata.get("renderOnly") is True and metadata.get("basisIncluded") is False, "render metadata contract is invalid")
    require(metadata.get("glb", {}).get("sha256") == sha256(path), "metadata GLB hash does not match")
    require(metadata.get("geometry", {}).get("optimizedVertexCount") == total_vertices, "metadata optimized vertex count does not match")
    require(metadata.get("geometry", {}).get("componentTriangleCounts") == counts, "metadata component triangle counts do not match")
    require(metadata.get("lossless", {}).get("lossyConversion") is False and metadata["lossless"].get("quantization") == "none", "lossless metadata is invalid")
    return total_vertices, counts


def validate_manifest(path: Path, glb: Path, metadata_path: Path, license_path: Path) -> None:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    require(manifest.get("schema") == MANIFEST_SCHEMA and manifest.get("status") == "accepted", "render manifest is not accepted")
    require(manifest.get("runtimeAllowed") is True and manifest.get("assetPackage", {}).get("renderOnly") is True, "render manifest runtime contract is invalid")
    require(manifest["permission"]["decisionReference"] == "sports-face-mvp-noncommercial-mvp-authorization", "public MVP authorization is missing")
    require(manifest["assets"]["mesh"]["sha256"] == sha256(glb) and manifest["assets"]["mesh"]["sizeBytes"] == glb.stat().st_size, "render GLB manifest hash/size does not match")
    require(manifest["assets"]["metadata"]["sha256"] == sha256(metadata_path), "render metadata manifest hash does not match")
    require(manifest["license"]["textSha256"] == sha256(license_path), "license manifest hash does not match")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("glb", type=Path)
    parser.add_argument("metadata", type=Path)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--license", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        metadata = json.loads(args.metadata.read_text(encoding="utf-8"))
        vertices, counts = validate_glb(args.glb, metadata)
        validate_manifest(args.manifest, args.glb, args.metadata, args.license)
    except (OSError, KeyError, TypeError, ValueError, struct.error) as error:
        print(f"FAIL {args.glb}: {error}", file=sys.stderr)
        return 1
    print(f"PASS {args.glb}: render-only schema, uint16 indices, {vertices} vertices, {sum(counts.values())} triangles, six components, no basis/quantization")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
