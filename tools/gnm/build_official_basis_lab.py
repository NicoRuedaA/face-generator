#!/usr/bin/env python3
"""Build the small, opt-in official GNM Basis Lab payload.

The payload deliberately selects the first four identity and first four
expression directions.  It stores their exact little-endian float32 values at
the optimized render vertices, in render primitive/vertex order, together
with the canonical sourceVertexId for every value.  The canonical GLB is read
only and is never rewritten.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CANONICAL = ROOT / "tools/gnm/work/gnm-official-head.glb"
DEFAULT_METADATA = ROOT / "tools/gnm/work/gnm-official-head.json"
DEFAULT_RENDER = ROOT / "tools/gnm/work/gnm-official-head-render.glb"
DEFAULT_OUTPUT = ROOT / "tools/gnm/work/gnm-official-basis-lab.bin"
DEFAULT_OUTPUT_METADATA = ROOT / "tools/gnm/work/gnm-official-basis-lab.json"

SCHEMA = "sports-face-gnm-official-basis-lab/v1"
CANONICAL_SCHEMA = "sports-face-gnm-official-head/v1"
RENDER_SCHEMA = "sports-face-gnm-official-head-render/v1"
COMPONENTS = ("skin", "left_eye", "right_eye", "upper_teeth_and_gums", "lower_teeth_and_gums", "tongue")
CANONICAL_VERTEX_COUNT = 17821
IDENTITY_COUNT = 253
EXPRESSION_COUNT = 383
SELECTED_COUNT = 4
FLOAT32 = 5126
UINT32 = 5125
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
MAGIC = b"SFBASIS1"
VERSION = 1
HEADER_STRUCT = struct.Struct("<8sIIIIIII")
HEADER_BYTES = HEADER_STRUCT.size


class BasisLabError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise BasisLabError(message)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    require(len(data) >= 20, f"{path.name} is shorter than a GLB header")
    magic, version, length = struct.unpack_from("<4sII", data)
    require(magic == b"glTF" and version == 2 and length == len(data), f"{path.name} GLB header is invalid")
    chunks: list[tuple[int, bytes]] = []
    offset = 12
    while offset < len(data):
        require(offset + 8 <= len(data), f"{path.name} chunk header is truncated")
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        start = offset + 8
        end = start + chunk_length
        require(chunk_length % 4 == 0 and end <= len(data), f"{path.name} chunk range is invalid")
        chunks.append((chunk_type, data[start:end]))
        offset = end
    require(len(chunks) == 2 and chunks[0][0] == JSON_CHUNK and chunks[1][0] == BIN_CHUNK, f"{path.name} must contain JSON then BIN")
    try:
        document = json.loads(chunks[0][1].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BasisLabError(f"{path.name} JSON is invalid: {error}") from error
    return document, chunks[1][1]


def accessor_bytes(document: dict, binary: bytes, index: int) -> tuple[dict, bytes]:
    try:
        accessor = document["accessors"][index]
        view = document["bufferViews"][accessor["bufferView"]]
    except (KeyError, IndexError, TypeError) as error:
        raise BasisLabError(f"accessor {index} is not addressable") from error
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    end = offset + view["byteLength"]
    require(offset % 4 == 0 and end <= len(binary), f"accessor {index} is outside BIN")
    payload = binary[offset:end]
    require(len(payload) == view["byteLength"], f"accessor {index} payload is truncated")
    return accessor, payload


def float_accessor(document: dict, binary: bytes, index: int, count: int, label: str) -> bytes:
    accessor, payload = accessor_bytes(document, binary, index)
    require(accessor.get("componentType") == FLOAT32 and accessor.get("type") == "VEC3", f"{label} must be float32 VEC3")
    require(accessor.get("count") == count and len(payload) == count * 12, f"{label} dimensions are invalid")
    return payload


def source_ids(document: dict, binary: bytes, primitive: dict, label: str) -> tuple[int, ...]:
    accessor, payload = accessor_bytes(document, binary, primitive["extras"]["sourceVertexIndicesAccessor"])
    require(accessor.get("componentType") == UINT32 and accessor.get("type") == "SCALAR", f"{label} sourceVertexId accessor is invalid")
    require(len(payload) == accessor["count"] * 4, f"{label} sourceVertexId payload is invalid")
    values = struct.unpack(f"<{accessor['count']}I", payload)
    require(all(value < CANONICAL_VERTEX_COUNT for value in values), f"{label} sourceVertexId is out of range")
    return values


def canonical_template(document: dict, binary: bytes) -> bytes:
    official = document.get("extras", {}).get("sportsFaceGnmOfficial", {})
    require(document.get("asset", {}).get("version") == "2.0", "canonical GLB is not glTF 2.0")
    require(official.get("schema") == CANONICAL_SCHEMA, "canonical official schema is missing")
    template = bytearray(CANONICAL_VERTEX_COUNT * 12)
    seen: dict[int, bytes] = {}
    primitives = document.get("meshes", [{}])[0].get("primitives", [])
    require(len(primitives) == len(COMPONENTS), "canonical GLB does not contain six components")
    for component, primitive in zip(COMPONENTS, primitives):
        accessor, position = accessor_bytes(document, binary, primitive["attributes"]["POSITION"])
        require(accessor.get("componentType") == FLOAT32 and accessor.get("type") == "VEC3", f"canonical {component} positions are invalid")
        ids = source_ids(document, binary, primitive, f"canonical {component}")
        require(len(ids) == accessor["count"] and len(position) == len(ids) * 12, f"canonical {component} mapping dimensions are invalid")
        for local, source in enumerate(ids):
            value = position[local * 12:local * 12 + 12]
            previous = seen.get(source)
            require(previous is None or previous == value, f"canonical POSITION differs for sourceVertexId {source}")
            seen[source] = value
            template[source * 12:source * 12 + 12] = value
    require(set(seen) == set(range(CANONICAL_VERTEX_COUNT)), "canonical sourceVertexId mappings are not exhaustive")
    return bytes(template)


def selected_basis(document: dict, binary: bytes, metadata: dict, family: str, count: int) -> tuple[list[dict[str, object]], bytes]:
    official = document["extras"]["sportsFaceGnmOfficial"]
    record = official["basis"][family]
    metadata_record = metadata["basis"][family]
    names = metadata_record["names"]
    require(record["count"] == count and record["shape"] == [count, CANONICAL_VERTEX_COUNT, 3], f"{family} canonical dimensions are invalid")
    require(names == record["names"] and len(names) == count, f"{family} basis names are inconsistent")
    payload = float_accessor(document, binary, record["accessor"], count * CANONICAL_VERTEX_COUNT, f"canonical {family} basis")
    selections = []
    for index in range(SELECTED_COUNT):
        selections.append({"family": family, "index": index, "name": names[index]})
    return selections, payload


def build(canonical_path: Path, metadata_path: Path, render_path: Path, output_path: Path, output_metadata_path: Path) -> dict:
    canonical_document, canonical_binary = read_glb(canonical_path)
    render_document, render_binary = read_glb(render_path)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    canonical_hash = sha256(canonical_path)
    render_hash = sha256(render_path)
    require(metadata.get("schema") == CANONICAL_SCHEMA, "canonical metadata schema is invalid")
    require(metadata.get("glb", {}).get("sha256") == canonical_hash, "canonical metadata hash does not match")
    template = canonical_template(canonical_document, canonical_binary)
    identity_selection, identity_payload = selected_basis(canonical_document, canonical_binary, metadata, "identity", IDENTITY_COUNT)
    expression_selection, expression_payload = selected_basis(canonical_document, canonical_binary, metadata, "expression", EXPRESSION_COUNT)

    official = render_document.get("extras", {}).get("sportsFaceGnmOfficial", {})
    require(official.get("schema") == CANONICAL_SCHEMA and official.get("renderOnly") is True and official.get("basisIncluded") is False, "render GLB is not the accepted render-only asset")
    primitives = render_document.get("meshes", [{}])[0].get("primitives", [])
    require(len(primitives) == len(COMPONENTS), "render GLB does not contain six components")
    render_vertex_count = 0
    ids_by_component: list[tuple[str, tuple[int, ...], bytes]] = []
    for component, primitive in zip(COMPONENTS, primitives):
        position_accessor, position = accessor_bytes(render_document, render_binary, primitive["attributes"]["POSITION"])
        require(position_accessor.get("componentType") == FLOAT32 and position_accessor.get("type") == "VEC3", f"render {component} positions are invalid")
        ids = source_ids(render_document, render_binary, primitive, f"render {component}")
        require(len(ids) == position_accessor["count"], f"render {component} source mapping count differs")
        for local, source in enumerate(ids):
            require(position[local * 12:local * 12 + 12] == template[source * 12:source * 12 + 12], f"render {component} position does not match sourceVertexId {source}")
        ids_by_component.append((component, ids, position))
        render_vertex_count += len(ids)

    vector_payload = bytearray()
    source_payload = bytearray()
    component_records = []
    vector_payloads = (identity_payload, expression_payload)
    selections = identity_selection + expression_selection
    render_vertex_offset = 0
    for component, ids, _position in ids_by_component:
        source_offset = len(source_payload) // 4
        source_payload.extend(struct.pack(f"<{len(ids)}I", *ids))
        component_records.append({"name": component, "sourceVertexOffset": source_offset, "renderVertexOffset": render_vertex_offset, "vertexCount": len(ids)})
        render_vertex_offset += len(ids)

    for selected in selections:
        family_payload = vector_payloads[0 if selected["family"] == "identity" else 1]
        basis_offset = (int(selected["index"]) * CANONICAL_VERTEX_COUNT) * 12
        for _component, ids, _position in ids_by_component:
            for source in ids:
                vector_payload.extend(family_payload[basis_offset + source * 12:basis_offset + source * 12 + 12])

    vector_count = len(selections)
    vector_bytes = vector_count * render_vertex_count * 12
    require(len(vector_payload) == vector_bytes, "projected basis payload length is invalid")
    source_offset = HEADER_BYTES
    vector_offset = source_offset + len(source_payload)
    header = HEADER_STRUCT.pack(MAGIC, VERSION, HEADER_BYTES, render_vertex_count, vector_count, source_offset, vector_offset, vector_bytes)
    payload = header + bytes(source_payload) + bytes(vector_payload)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(payload)

    report = {
        "schema": SCHEMA,
        "version": 1,
        "format": {"magic": MAGIC.decode("ascii"), "version": VERSION, "headerBytes": HEADER_BYTES, "endianness": "little", "sourceVertexIdType": "uint32", "basisValueType": "float32"},
        "source": {
            "canonicalGlb": {"path": "gnm-official-head.glb", "sizeBytes": canonical_path.stat().st_size, "sha256": canonical_hash},
            "canonicalMetadata": {"path": "gnm-official-head.json", "sizeBytes": metadata_path.stat().st_size, "sha256": sha256(metadata_path)},
            "renderGlb": {"path": "gnm-official-head-render.glb", "sizeBytes": render_path.stat().st_size, "sha256": render_hash},
        },
        "selection": {"method": "first four canonical basis vectors in each family", "identity": identity_selection, "expression": expression_selection},
        "dimensions": {"canonicalVertexCount": CANONICAL_VERTEX_COUNT, "renderVertexCount": render_vertex_count, "identityBasisCount": SELECTED_COUNT, "expressionBasisCount": SELECTED_COUNT, "vectorCount": vector_count, "shape": [vector_count, render_vertex_count, 3]},
        "components": component_records,
        "payload": {"path": "gnm-official-basis-lab.bin", "sizeBytes": len(payload), "sourceVertexIdsBytes": len(source_payload), "basisValuesBytes": len(vector_payload), "sha256": sha256_bytes(payload)},
        "budget": {"maxBytes": 3 * 1024 * 1024, "withinLimit": len(payload) <= 3 * 1024 * 1024},
        "canonicalHash": canonical_hash,
        "renderHash": render_hash,
        "semanticMapping": "disabled",
        "runtimeBasisLoaded": True,
    }
    output_metadata_path.parent.mkdir(parents=True, exist_ok=True)
    output_metadata_path.write_text(json.dumps(report, ensure_ascii=True, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--canonical", type=Path, default=DEFAULT_CANONICAL)
    parser.add_argument("--metadata", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--render", type=Path, default=DEFAULT_RENDER)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--output-metadata", type=Path, default=DEFAULT_OUTPUT_METADATA)
    args = parser.parse_args(argv)
    try:
        report = build(args.canonical, args.metadata, args.render, args.output, args.output_metadata)
    except (OSError, BasisLabError, KeyError, TypeError, ValueError, struct.error) as error:
        print(f"FAIL official GNM Basis Lab build: {error}", file=sys.stderr)
        return 1
    print(f"PASS {args.output}: {report['payload']['sizeBytes']} bytes, identity indices 0..3, expression indices 0..3, {report['dimensions']['renderVertexCount']} render vertices")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
