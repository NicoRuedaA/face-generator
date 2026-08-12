#!/usr/bin/env python3
"""Validate the Phase 2 geometry-only GNM binary glTF artifact."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import struct
import sys


GLB_MAGIC = b"glTF"
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
COMPONENT_BYTES = {5125: 4, 5126: 4}
TYPE_COMPONENTS = {"SCALAR": 1, "VEC3": 3}


class ValidationError(ValueError):
    pass


def fail(message: str) -> None:
    raise ValidationError(message)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    require(len(data) >= 12, "file is shorter than the GLB header")
    magic, version, length = struct.unpack_from("<4sII", data)
    require(magic == GLB_MAGIC, "invalid GLB magic")
    require(version == 2, f"unsupported GLB version {version}")
    require(length == len(data), f"header length {length} does not match file length {len(data)}")
    require(length % 4 == 0, "GLB length is not 4-byte aligned")

    chunks: list[tuple[int, bytes]] = []
    offset = 12
    while offset < length:
        require(offset + 8 <= length, "truncated GLB chunk header")
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        require(chunk_length % 4 == 0, "GLB chunk length is not 4-byte aligned")
        start = offset + 8
        end = start + chunk_length
        require(end <= length, "GLB chunk exceeds declared file length")
        chunks.append((chunk_type, data[start:end]))
        offset = end
    require(offset == length, "GLB chunks do not consume the file")
    require([chunk_type for chunk_type, _ in chunks].count(JSON_CHUNK) == 1, "GLB must contain exactly one JSON chunk")
    require([chunk_type for chunk_type, _ in chunks].count(BIN_CHUNK) == 1, "GLB must contain exactly one BIN chunk")
    require(chunks[0][0] == JSON_CHUNK, "JSON chunk must be first")
    try:
        document = json.loads(chunks[0][1].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"invalid JSON chunk: {error}")
    require(isinstance(document, dict), "JSON chunk must contain an object")
    return document, next(payload for chunk_type, payload in chunks if chunk_type == BIN_CHUNK)


def validate(document: dict, binary: bytes) -> tuple[int, int, int]:
    asset = document.get("asset")
    require(isinstance(asset, dict) and asset.get("version") == "2.0", "missing glTF 2.0 asset metadata")
    scenes = document.get("scenes")
    nodes = document.get("nodes")
    meshes = document.get("meshes")
    accessors = document.get("accessors")
    views = document.get("bufferViews")
    buffers = document.get("buffers")
    require(isinstance(scenes, list) and len(scenes) == 1, "expected exactly one scene")
    require(isinstance(nodes, list) and len(nodes) == 1, "expected exactly one node")
    require(isinstance(meshes, list) and len(meshes) == 1, "expected exactly one mesh")
    require(isinstance(accessors, list) and len(accessors) in (2, 18), "expected position/index or position/index/morph accessors")
    require(isinstance(views, list) and len(views) in (2, 18), "expected position/index or position/index/morph bufferViews")
    require(isinstance(buffers, list) and len(buffers) == 1, "expected exactly one buffer")
    require(document.get("scene") == 0, "default scene must be scene 0")
    require(scenes[0].get("nodes") == [0], "scene must reference node 0")
    require(nodes[0].get("mesh") == 0, "node must reference mesh 0")

    buffer_length = buffers[0].get("byteLength")
    require(isinstance(buffer_length, int) and buffer_length == len(binary), "buffer byteLength does not match BIN chunk")
    for index, view in enumerate(views):
        require(view.get("buffer") == 0, f"bufferView {index} must reference buffer 0")
        offset = view.get("byteOffset", 0)
        byte_length = view.get("byteLength")
        require(isinstance(offset, int) and offset >= 0 and offset % 4 == 0, f"bufferView {index} has invalid offset")
        require(isinstance(byte_length, int) and byte_length >= 0, f"bufferView {index} has invalid length")
        require(offset + byte_length <= len(binary), f"bufferView {index} exceeds BIN bounds")

    expected = ((5126, "VEC3", 0, 34962), (5125, "SCALAR", 1, 34963))
    counts: list[int] = []
    for index, (component_type, accessor_type, view_index, target) in enumerate(expected):
        accessor = accessors[index]
        view = views[view_index]
        require(accessor.get("bufferView") == view_index, f"accessor {index} has the wrong bufferView")
        require(accessor.get("componentType") == component_type, f"accessor {index} has the wrong componentType")
        require(accessor.get("type") == accessor_type, f"accessor {index} has the wrong type")
        count = accessor.get("count")
        require(isinstance(count, int) and count > 0, f"accessor {index} has an invalid count")
        component_count = TYPE_COMPONENTS[accessor_type]
        byte_size = COMPONENT_BYTES[component_type] * component_count
        require(view.get("byteLength") == count * byte_size, f"bufferView {view_index} length does not match accessor {index}")
        require(view.get("target") == target, f"bufferView {view_index} has the wrong target")
        require(view.get("byteOffset", 0) % byte_size == 0, f"bufferView {view_index} is not aligned for its accessor")
        counts.append(count)

    position = accessors[0]
    require(indices := counts[1], "index accessor must not be empty")
    require(indices % 3 == 0, "index count must describe complete triangles")
    require(document["meshes"][0]["primitives"] and len(document["meshes"][0]["primitives"]) == 1, "mesh must contain one primitive")
    primitive = document["meshes"][0]["primitives"][0]
    require(primitive.get("attributes") == {"POSITION": 0}, "primitive must expose POSITION accessor 0")
    require(primitive.get("indices") == 1 and primitive.get("mode") == 4, "primitive must use indexed triangles")
    if len(accessors) == 18:
        targets = primitive.get("targets")
        names = document["meshes"][0].get("extras", {}).get("targetNames")
        require(isinstance(targets, list) and len(targets) == 16, "morph primitive must contain 16 targets")
        require(names == [f"gnm-pca-{index + 1:02d}" for index in range(16)], "morph target names must be neutral and ordered")
        for index, target in enumerate(targets):
            require(target == {"POSITION": index + 2}, f"morph target {index} must reference its POSITION accessor")
            accessor = accessors[index + 2]
            view = views[index + 2]
            require(accessor.get("bufferView") == index + 2, f"morph accessor {index} has the wrong bufferView")
            require(accessor.get("componentType") == 5126 and accessor.get("type") == "VEC3", f"morph accessor {index} must be float32 VEC3")
            require(accessor.get("count") == counts[0], f"morph accessor {index} has the wrong count")
            require(view.get("byteLength") == counts[0] * 12, f"morph bufferView {index} length is invalid")
            require(view.get("target") == 34962, f"morph bufferView {index} has the wrong target")
            require(view.get("byteOffset", 0) % 12 == 0, f"morph bufferView {index} is not VEC3 aligned")
    require(len(position.get("min", [])) == 3 and len(position.get("max", [])) == 3, "position bounds must contain three values")
    bounds = position["min"] + position["max"]
    require(all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in bounds), "position bounds must be finite")
    require(all(lower <= upper for lower, upper in zip(position["min"], position["max"])), "position bounds are inverted")
    require(isinstance(document.get("materials"), list) and len(document["materials"]) == 1, "expected one neutral material")
    require(primitive.get("material") == 0, "primitive must reference material 0")
    return counts[0], counts[1], len(binary)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    args = parser.parse_args(argv)
    try:
        document, binary = read_glb(args.path)
        vertices, indices, binary_length = validate(document, binary)
    except (OSError, ValidationError, KeyError, TypeError, IndexError, struct.error) as error:
        print(f"FAIL {args.path}: {error}", file=sys.stderr)
        return 1
    print(f"PASS {args.path}: glTF 2.0, 1 scene, 1 node, 1 mesh, {vertices} vertices, {indices} indices, BIN {binary_length} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
