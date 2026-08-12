#!/usr/bin/env python3
"""Validate the accepted official GNM-derived GLB, metadata, and manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys


COMPONENTS = ("skin", "left_eye", "right_eye", "upper_teeth_and_gums", "lower_teeth_and_gums", "tongue")
SCHEMA = "sports-face-gnm-official-head/v1"
MANIFEST_SCHEMA = "sports-face-gnm-official-bundle/v1"
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
    try:
        document = json.loads(chunks[0][1].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValidationError(f"GLB JSON is invalid: {error}") from error
    return document, chunks[1][1]


def validate_glb(path: Path, metadata: dict) -> None:
    document, binary = read_glb(path)
    require(document.get("asset", {}).get("version") == "2.0", "GLB is not glTF 2.0")
    require(document.get("scene") == 0 and len(document.get("scenes", [])) == 1, "GLB scene structure is invalid")
    require(len(document.get("nodes", [])) == 1 and len(document.get("meshes", [])) == 1, "GLB must contain one node and one mesh")
    require(document["buffers"][0]["byteLength"] == len(binary), "GLB BIN byteLength is invalid")
    extras = document.get("extras", {}).get("sportsFaceGnmOfficial")
    require(extras.get("schema") == SCHEMA, "GLB official schema is missing")
    mesh = document["meshes"][0]
    primitives = mesh.get("primitives", [])
    require(len(primitives) == len(COMPONENTS), "GLB must contain six component primitives")
    require(len(document.get("materials", [])) == len(COMPONENTS), "GLB must contain six neutral materials")
    accessors = document.get("accessors", [])
    views = document.get("bufferViews", [])
    seen = []
    for index, primitive in enumerate(primitives):
        component = primitive.get("extras", {}).get("componentName")
        require(component == COMPONENTS[index], f"primitive {index} component order is invalid")
        seen.append(component)
        require(primitive.get("mode") == 4 and primitive.get("material") == index, f"primitive {index} mode/material is invalid")
        attributes = primitive.get("attributes", {})
        require(set(attributes) == {"POSITION", "TEXCOORD_0"}, f"primitive {index} must expose positions and UVs")
        position = accessors[attributes["POSITION"]]
        uv = accessors[attributes["TEXCOORD_0"]]
        indices = accessors[primitive["indices"]]
        require(position.get("componentType") == 5126 and position.get("type") == "VEC3", f"primitive {index} positions are invalid")
        require(uv.get("componentType") == 5126 and uv.get("type") == "VEC2", f"primitive {index} UVs are invalid")
        require(indices.get("componentType") == 5125 and indices.get("type") == "SCALAR", f"primitive {index} indices are invalid")
        require(position.get("count") == uv.get("count") == indices.get("count"), f"primitive {index} attribute/index counts differ")
        for accessor_index in (attributes["POSITION"], attributes["TEXCOORD_0"], primitive["indices"]):
            view = views[accessors[accessor_index]["bufferView"]]
            require(view["byteOffset"] % 4 == 0 and view["byteOffset"] + view["byteLength"] <= len(binary), f"primitive {index} buffer range is invalid")
        material = document["materials"][index]
        require(material.get("extras", {}).get("materialSource") == "neutral-procedural", f"primitive {index} material is not explicitly procedural")
        require(material["extras"].get("officialTexturesIncluded") is False, f"primitive {index} claims official textures")
    require(seen == list(COMPONENTS), "GLB components are incomplete")
    basis = extras.get("basis", {})
    for name, count in (("identity", 253), ("expression", 383)):
        record = basis.get(name, {})
        require(record.get("count") == count and record.get("dtype") == "float32-le", f"{name} basis metadata is invalid")
        require(record.get("semanticMapping") == "unsafe-neutral-only", f"{name} basis mapping must remain neutral")
        accessor = accessors[record["accessor"]]
        require(accessor.get("componentType") == 5126 and accessor.get("type") == "VEC3", f"{name} basis accessor is invalid")
    require(extras.get("materials", {}).get("officialTexturesIncluded") is False, "GLB material metadata claims textures")
    require(metadata.get("glb", {}).get("sha256") == sha256(path), "metadata GLB hash does not match")


def validate(manifest_path: Path) -> None:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    require(manifest.get("schema") == MANIFEST_SCHEMA and manifest.get("status") == "accepted", "manifest is not accepted official GNM schema")
    require(manifest.get("runtimeAllowed") is True, "accepted official manifest must allow the opt-in runtime")
    require(manifest["source"]["upstreamRevision"] == "8ea2906a31aab7f8b550e33968f3c0a86051a92d", "manifest revision is invalid")
    require(manifest["source"]["archiveSha256"] == "2aabb75107ed5a3c7be45ba93700fbfa7e1333c646054ff9dc9d267dd02b730d", "manifest archive hash is invalid")
    require(manifest["license"]["spdxId"] == "Apache-2.0" and manifest["license"]["textSha256"] == "58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd", "manifest license evidence is invalid")
    permission = manifest["permission"]
    require(permission == {**permission, "reviewer": "project-owner", "decisionDate": "2026-08-12", "decisionReference": "sports-face-mvp-noncommercial-mvp-authorization"}, "manifest permission record is invalid")
    require(manifest["assetPackage"]["components"] == list(COMPONENTS) and manifest["assetPackage"]["officialTexturesIncluded"] is False, "manifest package metadata is invalid")
    directory = manifest_path.parent
    license_path = directory / manifest["license"]["textPath"]
    glb_path = directory / manifest["assets"]["mesh"]["path"]
    metadata_path = directory / manifest["assetPackage"]["metadataPath"]
    require(sha256(license_path) == manifest["license"]["textSha256"], "license hash does not match")
    require(sha256(glb_path) == manifest["assets"]["mesh"]["sha256"], "GLB manifest hash does not match")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    require(metadata.get("schema") == SCHEMA and "neutral procedural" in metadata["notes"].lower(), "metadata contract is invalid")
    validate_glb(glb_path, metadata)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args(argv)
    try:
        validate(args.manifest)
    except (OSError, KeyError, TypeError, ValueError, struct.error) as error:
        print(f"FAIL {args.manifest}: {error}", file=sys.stderr)
        return 1
    print(f"PASS {args.manifest}: official GNM GLB, six components, exact UVs, basis metadata, accepted manifest")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
