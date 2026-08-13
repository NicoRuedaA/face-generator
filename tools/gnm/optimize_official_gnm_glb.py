#!/usr/bin/env python3
"""Build the bounded, lossless render-only GLB from the canonical official GLB."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
import struct
import sys


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INPUT = ROOT / "tools/gnm/work/gnm-official-head.glb"
DEFAULT_OUTPUT = ROOT / "tools/gnm/work/gnm-official-head-render.glb"
DEFAULT_METADATA = ROOT / "tools/gnm/work/gnm-official-head-render.json"
DEFAULT_MANIFEST = ROOT / "tools/gnm/work/official-render-bundle.json"
DEFAULT_LICENSE = ROOT / "tools/gnm/work/LICENSE-GNM.txt"
COMPONENTS = (
    "skin",
    "left_eye",
    "right_eye",
    "upper_teeth_and_gums",
    "lower_teeth_and_gums",
    "tongue",
)
SCHEMA = "sports-face-gnm-official-head/v1"
RENDER_SCHEMA = "sports-face-gnm-official-head-render/v1"
RENDER_MANIFEST_SCHEMA = "sports-face-gnm-official-render-bundle/v1"
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
GLB_MAGIC = b"glTF"


class OptimizationError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise OptimizationError(message)


def aligned(payload: bytes) -> bytes:
    return payload + b"\0" * ((-len(payload)) % 4)


def aligned_json(payload: bytes) -> bytes:
    return payload + b" " * ((-len(payload)) % 4)


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    require(len(data) >= 20, "canonical GLB is shorter than its header")
    magic, version, length = struct.unpack_from("<4sII", data)
    require(magic == GLB_MAGIC and version == 2 and length == len(data), "canonical GLB header is invalid")
    offset = 12
    chunks: list[tuple[int, bytes]] = []
    while offset < len(data):
        require(offset + 8 <= len(data), "canonical GLB chunk header is truncated")
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        start = offset + 8
        end = start + chunk_length
        require(chunk_length % 4 == 0 and end <= len(data), "canonical GLB chunk range is invalid")
        chunks.append((chunk_type, data[start:end]))
        offset = end
    require(len(chunks) == 2 and chunks[0][0] == JSON_CHUNK and chunks[1][0] == BIN_CHUNK, "canonical GLB must contain JSON then BIN")
    try:
        document = json.loads(chunks[0][1].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise OptimizationError(f"canonical GLB JSON is invalid: {error}") from error
    return document, chunks[1][1]


def accessor_bytes(document: dict, binary: bytes, accessor_index: int) -> tuple[dict, bytes, int]:
    accessor = document["accessors"][accessor_index]
    view = document["bufferViews"][accessor["bufferView"]]
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    end = offset + view["byteLength"]
    require(offset % 4 == 0 and end <= len(binary), f"accessor {accessor_index} is outside the BIN chunk")
    return accessor, binary[offset:end], offset


def unpack_values(payload: bytes, component_type: int, count: int) -> list[int]:
    require(component_type == 5125, "canonical source mapping must use uint32")
    require(len(payload) == count * 4, "canonical source mapping has an invalid byte length")
    return list(struct.unpack(f"<{count}I", payload))


def float_values(payload: bytes, count: int, components: int) -> list[tuple[float, ...]]:
    require(len(payload) == count * components * 4, "canonical attribute has an invalid byte length")
    return list(struct.iter_unpack(f"<{components}f", payload))


def append_view(parts: list[bytes], views: list[dict], payload: bytes, target: int | None = None) -> int:
    offset = sum(len(part) for part in parts)
    padding = (-offset) % 4
    if padding:
        parts.append(b"\0" * padding)
        offset += padding
    payload = aligned(payload)
    parts.append(payload)
    view: dict[str, object] = {"buffer": 0, "byteLength": len(payload), "byteOffset": offset}
    if target is not None:
        view["target"] = target
    views.append(view)
    return len(views) - 1


def append_accessor(accessors: list[dict], view: int, component_type: int, accessor_type: str, count: int, *, minimum: list[float] | None = None, maximum: list[float] | None = None) -> int:
    record: dict[str, object] = {"bufferView": view, "componentType": component_type, "count": count, "type": accessor_type}
    if minimum is not None:
        record["min"] = minimum
    if maximum is not None:
        record["max"] = maximum
    accessors.append(record)
    return len(accessors) - 1


def bounds(values: list[tuple[float, ...]]) -> tuple[list[float], list[float]]:
    minimum = [min(value[axis] for value in values) for axis in range(len(values[0]))]
    maximum = [max(value[axis] for value in values) for axis in range(len(values[0]))]
    return minimum, maximum


def optimize(document: dict, binary: bytes, canonical_path: Path) -> tuple[bytes, dict, dict]:
    official = document.get("extras", {}).get("sportsFaceGnmOfficial", {})
    require(official.get("schema") == SCHEMA, "canonical GLB does not contain the official GNM schema")
    primitives = document.get("meshes", [{}])[0].get("primitives", [])
    require(len(primitives) == len(COMPONENTS), "canonical GLB does not contain six primitives")
    require(len(document.get("materials", [])) == len(COMPONENTS), "canonical GLB does not contain six materials")

    output_document = copy.deepcopy(document)
    output_document["asset"]["generator"] = "sports-face-mvp tools/gnm/optimize_official_gnm_glb.py"
    output_document["buffers"] = [{"byteLength": 0}]
    output_document["bufferViews"] = []
    output_document["accessors"] = []
    parts: list[bytes] = []
    views: list[dict] = output_document["bufferViews"]
    accessors: list[dict] = output_document["accessors"]
    optimized_primitives = []
    component_records = []
    source_mappings = []

    for primitive_index, (primitive, component) in enumerate(zip(primitives, COMPONENTS)):
        require(primitive.get("extras", {}).get("componentName") == component, f"canonical primitive {primitive_index} has the wrong component")
        position_accessor, position_payload, _ = accessor_bytes(document, binary, primitive["attributes"]["POSITION"])
        uv_accessor, uv_payload, _ = accessor_bytes(document, binary, primitive["attributes"]["TEXCOORD_0"])
        index_accessor, index_payload, _ = accessor_bytes(document, binary, primitive["indices"])
        source_accessor, source_payload, _ = accessor_bytes(document, binary, primitive["extras"]["sourceVertexIndicesAccessor"])
        require(position_accessor["componentType"] == 5126 and position_accessor["type"] == "VEC3", f"{component} positions are not float32 VEC3")
        require(uv_accessor["componentType"] == 5126 and uv_accessor["type"] == "VEC2", f"{component} UVs are not float32 VEC2")
        require(index_accessor["componentType"] == 5125 and index_accessor["type"] == "SCALAR", f"{component} indices are not uint32")
        require(source_accessor["componentType"] == 5125 and source_accessor["type"] == "SCALAR", f"{component} source mapping is not uint32")
        positions = float_values(position_payload, position_accessor["count"], 3)
        uvs = float_values(uv_payload, uv_accessor["count"], 2)
        canonical_indices = unpack_values(index_payload, index_accessor["componentType"], index_accessor["count"])
        source_vertices = unpack_values(source_payload, source_accessor["componentType"], source_accessor["count"])
        require(len(positions) == len(uvs) == len(source_vertices), f"{component} canonical attribute counts differ")
        require(len(canonical_indices) % 3 == 0, f"{component} index count is not triangular")

        pair_to_local: dict[bytes, int] = {}
        unique_position_bytes: list[bytes] = []
        unique_uv_bytes: list[bytes] = []
        unique_source_vertices: list[int] = []
        remapped: list[int] = []
        for canonical_index in canonical_indices:
            require(canonical_index < len(positions), f"{component} index is out of range")
            position_bytes = position_payload[canonical_index * 12:(canonical_index + 1) * 12]
            uv_bytes = uv_payload[canonical_index * 8:(canonical_index + 1) * 8]
            key = position_bytes + uv_bytes
            local_index = pair_to_local.get(key)
            if local_index is None:
                local_index = len(unique_position_bytes)
                pair_to_local[key] = local_index
                unique_position_bytes.append(position_bytes)
                unique_uv_bytes.append(uv_bytes)
                unique_source_vertices.append(source_vertices[canonical_index])
            remapped.append(local_index)
        require(len(unique_position_bytes) <= 65535, f"{component} does not fit uint16 indices")

        position_bytes = b"".join(unique_position_bytes)
        uv_bytes = b"".join(unique_uv_bytes)
        index_bytes = struct.pack(f"<{len(remapped)}H", *remapped)
        source_bytes = struct.pack(f"<{len(unique_source_vertices)}I", *unique_source_vertices)
        position_values = float_values(position_bytes, len(unique_position_bytes), 3)
        uv_values = float_values(uv_bytes, len(unique_uv_bytes), 2)
        position_min, position_max = bounds(position_values)
        uv_min, uv_max = bounds(uv_values)
        position_view = append_view(parts, views, position_bytes, target=34962)
        uv_view = append_view(parts, views, uv_bytes, target=34962)
        source_view = append_view(parts, views, source_bytes)
        index_view = append_view(parts, views, index_bytes, target=34963)
        position_index = append_accessor(accessors, position_view, 5126, "VEC3", len(unique_position_bytes), minimum=position_min, maximum=position_max)
        uv_index = append_accessor(accessors, uv_view, 5126, "VEC2", len(unique_uv_bytes), minimum=uv_min, maximum=uv_max)
        source_index = append_accessor(accessors, source_view, 5125, "SCALAR", len(unique_source_vertices))
        indices_index = append_accessor(accessors, index_view, 5123, "SCALAR", len(remapped))
        optimized_primitives.append({
            "attributes": {"POSITION": position_index, "TEXCOORD_0": uv_index},
            "extras": {"componentName": component, "sourceVertexIndicesAccessor": source_index},
            "indices": indices_index,
            "material": primitive["material"],
            "mode": primitive["mode"],
        })
        source_mappings.append({
            "component": component,
            "primitiveIndex": primitive_index,
            "canonicalPrimitiveVertexCount": position_accessor["count"],
            "canonicalSourceVertexIndicesAccessor": primitive["extras"]["sourceVertexIndicesAccessor"],
            "optimizedVertexCount": len(unique_position_bytes),
            "sourceVertexIndicesAccessor": source_index,
            "method": "first-occurrence exact POSITION/TEXCOORD_0 pair",
        })
        original_record = copy.deepcopy(official["components"][primitive_index])
        original_record["optimizedVertexCount"] = len(unique_position_bytes)
        original_record["indexComponentType"] = "UNSIGNED_SHORT"
        component_records.append(original_record)

    output_document["meshes"][0]["primitives"] = optimized_primitives
    output_document["buffers"][0]["byteLength"] = sum(len(part) for part in parts)
    canonical_hash = sha256_bytes(canonical_path.read_bytes())
    render_official = copy.deepcopy(official)
    render_official.pop("basis", None)
    render_official.update({
        "renderOnly": True,
        "basisIncluded": False,
        "canonicalSource": {"path": canonical_path.name, "sizeBytes": canonical_path.stat().st_size, "sha256": canonical_hash},
        "components": component_records,
        "sourceMapping": source_mappings,
        "lossless": {"positions": "exact float32 bytes", "uvs": "exact float32 bytes", "indices": "topology-preserving remap", "quantization": "none"},
    })
    output_document["extras"] = {"sportsFaceGnmOfficial": render_official}
    json_payload = aligned_json(json.dumps(output_document, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    binary_payload = b"".join(parts)
    total_length = 12 + 8 + len(json_payload) + 8 + len(binary_payload)
    glb = b"".join((
        struct.pack("<4sII", GLB_MAGIC, 2, total_length),
        struct.pack("<II", len(json_payload), JSON_CHUNK), json_payload,
        struct.pack("<II", len(binary_payload), BIN_CHUNK), binary_payload,
    ))
    metadata = {
        "schema": RENDER_SCHEMA,
        "version": "render-only-v1",
        "renderOnly": True,
        "basisIncluded": False,
        "source": copy.deepcopy(official.get("source", {})),
        "canonicalSource": {"path": canonical_path.name, "sizeBytes": canonical_path.stat().st_size, "sha256": canonical_hash},
        "geometry": {
            "canonicalVertexCount": official["topology"]["templateVertexCount"],
            "canonicalTriangleCount": official["topology"]["triangleCount"],
            "optimizedVertexCount": sum(item["optimizedVertexCount"] for item in component_records),
            "triangleCount": official["topology"]["triangleCount"],
            "componentTriangleCounts": {item["name"]: item["triangleCount"] for item in component_records},
        },
        "components": component_records,
        "sourceMapping": source_mappings,
        "uvHandling": "Exact float32 POSITION/TEXCOORD_0 pairs are deduplicated by first occurrence; triangle order and UV seams are preserved.",
        "lossless": {"positions": "exact float32 bytes", "uvs": "exact float32 bytes", "indices": "topology-preserving remap", "quantization": "none", "lossyConversion": False},
        "basis": {"included": False, "offlineOptional": True, "identityCount": 253, "expressionCount": 383, "semanticMapping": "disabled"},
        "materials": copy.deepcopy(official["materials"]),
        "mapping": copy.deepcopy(official["mapping"]),
        "glb": {"path": DEFAULT_OUTPUT.name, "sizeBytes": len(glb), "sha256": sha256_bytes(glb)},
        "notes": "Render-only lossless optimization for the explicitly authorized public noncommercial MVP. The canonical archival GLB and basis payload remain unchanged and offline/optional.",
    }
    manifest = {
        "schema": RENDER_MANIFEST_SCHEMA,
        "status": "accepted",
        "runtimeAllowed": True,
        "source": {
            "repositoryUrl": official["source"]["repository"],
            "upstreamRevision": official["source"]["revision"],
            "archiveSha256": official["source"]["npzSha256"],
            "canonicalSource": {"path": canonical_path.name, "sizeBytes": canonical_path.stat().st_size, "sha256": canonical_hash},
        },
        "license": {"name": "Apache License 2.0", "spdxId": "Apache-2.0", "textPath": DEFAULT_LICENSE.name, "textSha256": sha256_bytes(DEFAULT_LICENSE.read_bytes())},
        "permission": {"decision": "approved", "reviewer": "project-owner", "decisionDate": "2026-08-12", "decisionReference": "sports-face-mvp-noncommercial-mvp-authorization", "scope": "Public redistribution for this noncommercial MVP only; replace with custom assets when the MVP result is desirable."},
        "geometry": metadata["geometry"],
        "assets": {"mesh": {"path": DEFAULT_OUTPUT.name, "sha256": sha256_bytes(glb), "sizeBytes": len(glb)}, "metadata": {"path": DEFAULT_METADATA.name, "sha256": sha256_bytes((json.dumps(metadata, ensure_ascii=True, indent=2) + "\n").encode("utf-8"))}},
        "assetPackage": {"renderOnly": True, "basisIncluded": False, "metadataPath": DEFAULT_METADATA.name, "glbPath": DEFAULT_OUTPUT.name, "components": list(COMPONENTS), "officialTexturesIncluded": False, "runtimeMaterials": "neutral-procedural"},
        "notes": "Accepted official GNM-derived render-only package for the explicitly authorized public noncommercial MVP scope. Semantic identity/expression mapping remains disabled; basis payload is offline/optional and is not redistributed in this render asset.",
    }
    return glb, metadata, manifest


def write_json(path: Path, document: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--metadata", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--license", type=Path, default=DEFAULT_LICENSE)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        require(args.input.is_file(), f"canonical GLB does not exist: {args.input}")
        require(args.license.is_file(), f"license does not exist: {args.license}")
        document, binary = read_glb(args.input)
        glb, metadata, manifest = optimize(document, binary, args.input)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(glb)
        write_json(args.metadata, metadata)
        write_json(args.manifest, manifest)
    except (OSError, OptimizationError, KeyError, TypeError, IndexError, struct.error) as error:
        print(f"FAIL official GNM render optimization: {error}", file=sys.stderr)
        return 1
    print(f"PASS official GNM render optimization: {args.input.stat().st_size} -> {len(glb)} bytes, {metadata['geometry']['optimizedVertexCount']} vertices, {metadata['geometry']['triangleCount']} triangles, six components, exact float32 POSITION/UV bytes, no quantization")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
