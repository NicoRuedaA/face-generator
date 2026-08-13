#!/usr/bin/env python3
"""Diagnose the official GNM basis payload without importing or changing assets.

This tool deliberately uses only the Python standard library.  The canonical
GLB does not store a second, monolithic template accessor: its six POSITION
accessors plus sourceVertexIndices form that accessor losslessly.  The report
calls this out as a virtual template accessor rather than changing the GLB.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import sys


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CANONICAL = ROOT / "tools/gnm/work/gnm-official-head.glb"
DEFAULT_METADATA = ROOT / "tools/gnm/work/gnm-official-head.json"
DEFAULT_RENDER = ROOT / "tools/gnm/work/gnm-official-head-render.glb"
DEFAULT_RENDER_METADATA = ROOT / "tools/gnm/work/gnm-official-head-render.json"
DEFAULT_OUTPUT = ROOT / "tools/gnm/work/gnm-official-basis-diagnostic.json"

SCHEMA = "sports-face-gnm-official-head/v1"
COMPONENTS = ("skin", "left_eye", "right_eye", "upper_teeth_and_gums", "lower_teeth_and_gums", "tongue")
VERTEX_COUNT = 17821
IDENTITY_COUNT = 253
EXPRESSION_COUNT = 383
FLOAT32 = 5126
UINT32 = 5125
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


class DiagnosticError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise DiagnosticError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


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
        raise DiagnosticError(f"{path.name} JSON is invalid: {error}") from error
    return document, chunks[1][1]


def accessor_bytes(document: dict, binary: bytes, index: int) -> tuple[dict, bytes]:
    try:
        accessor = document["accessors"][index]
        view = document["bufferViews"][accessor["bufferView"]]
    except (KeyError, IndexError, TypeError) as error:
        raise DiagnosticError(f"accessor {index} is not addressable") from error
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    end = offset + view["byteLength"]
    require(offset % 4 == 0 and end <= len(binary), f"accessor {index} is outside the BIN chunk")
    payload = binary[offset:end]
    require(len(payload) == view["byteLength"], f"accessor {index} payload is truncated")
    return accessor, payload


def validate_float_accessor(accessor: dict, payload: bytes, count: int, label: str) -> None:
    require(accessor.get("componentType") == FLOAT32 and accessor.get("type") == "VEC3", f"{label} must be float32 VEC3")
    require(accessor.get("count") == count, f"{label} count is not {count}")
    require(len(payload) == count * 12, f"{label} payload length is not {count * 12}")


def finite_f32_payload(payload: bytes, label: str) -> dict[str, object]:
    count = len(payload) // 4
    finite = True
    for (value,) in struct.iter_unpack("<f", payload):
        if not math.isfinite(value):
            finite = False
            break
    return {"finite": finite, "floatCount": count, "byteLength": len(payload), "exactPayloadLength": True}


def f32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


def contiguous_ranges(values: set[int]) -> list[list[int]]:
    ordered = sorted(values)
    ranges: list[list[int]] = []
    for value in ordered:
        if not ranges or value != ranges[-1][1] + 1:
            ranges.append([value, value])
        else:
            ranges[-1][1] = value
    return ranges


def displacement_bounds(payload: bytes, count: int) -> dict[str, object]:
    max_abs = 0.0
    l2_values: list[float] = []
    for index in range(count):
        start = index * VERTEX_COUNT * 12
        vector_payload = payload[start:start + VERTEX_COUNT * 12]
        sum_squares = 0.0
        vector_max = 0.0
        for x, y, z in struct.iter_unpack("<3f", vector_payload):
            require(math.isfinite(x) and math.isfinite(y) and math.isfinite(z), "basis contains a non-finite displacement")
            vector_max = max(vector_max, abs(x), abs(y), abs(z))
            sum_squares += x * x + y * y + z * z
        l2 = math.sqrt(sum_squares)
        l2_values.append(l2)
        max_abs = max(max_abs, vector_max)
    return {
        "basisCount": count,
        "l2": {"min": min(l2_values), "max": max(l2_values), "mean": sum(l2_values) / len(l2_values)},
        "maxAbs": max_abs,
    }


def reconstruct(template: bytes, basis_payload: bytes, basis_index: int | None) -> tuple[bytes, bool]:
    output = bytearray(len(template))
    basis_start = 0 if basis_index is None else basis_index * VERTEX_COUNT * 12
    basis = basis_payload[basis_start:basis_start + VERTEX_COUNT * 12] if basis_index is not None else None
    for vertex in range(VERTEX_COUNT):
        offset = vertex * 12
        template_values = struct.unpack_from("<3f", template, offset)
        values = template_values if basis is None else tuple(
            f32(f32(template_values[axis]) + f32(struct.unpack_from("<f", basis, offset + axis * 4)[0]))
            for axis in range(3)
        )
        require(all(math.isfinite(value) for value in values), "reconstruction contains a non-finite value")
        struct.pack_into("<3f", output, offset, *values)
    return bytes(output), all(math.isfinite(value) for (value,) in struct.iter_unpack("<f", output))


def names_from(metadata: dict, document: dict, family: str, expected_count: int) -> list[str]:
    metadata_record = metadata["basis"][family]
    glb_record = document["extras"]["sportsFaceGnmOfficial"]["basis"][family]
    names = metadata_record["names"]
    require(isinstance(names, list) and len(names) == expected_count and all(isinstance(name, str) and name for name in names), f"{family} names are not nonempty and complete")
    require(names == glb_record.get("names"), f"{family} names/order differ between metadata and GLB")
    require(len(set(names)) == expected_count, f"{family} names are not unique")
    require(metadata_record.get("count") == expected_count and metadata_record.get("shape") == [expected_count, VERTEX_COUNT, 3], f"{family} metadata dimensions are invalid")
    return list(names)


def validate_metadata(metadata: dict, canonical_hash: str, canonical_size: int) -> None:
    require(metadata.get("schema") == SCHEMA, "metadata schema is not canonical official GNM")
    require(metadata.get("glb", {}).get("sha256") == canonical_hash and metadata["glb"].get("sizeBytes") == canonical_size, "metadata GLB hash/size does not match canonical GLB")
    require(metadata.get("geometry") == {"vertexCount": VERTEX_COUNT, "triangleCount": 35324, "quadCount": 17662, "identityCount": IDENTITY_COUNT, "expressionCount": EXPRESSION_COUNT, "componentTriangleCounts": {"skin": 24820, "left_eye": 1512, "right_eye": 1512, "upper_teeth_and_gums": 2828, "lower_teeth_and_gums": 2828, "tongue": 1824}}, "metadata geometry dimensions are invalid")


def validate_components(document: dict, binary: bytes, template: bytearray) -> tuple[list[dict[str, object]], set[int]]:
    official = document["extras"]["sportsFaceGnmOfficial"]
    require(document.get("asset", {}).get("version") == "2.0", "canonical GLB asset is not v2")
    require(official.get("schema") == SCHEMA, "canonical official schema is missing")
    primitives = document.get("meshes", [{}])[0].get("primitives", [])
    require(len(primitives) == len(COMPONENTS), "canonical GLB does not contain six component primitives")
    records: list[dict[str, object]] = []
    all_sources: set[int] = set()
    source_bytes_by_id: dict[int, bytes] = {}
    for index, (primitive, component) in enumerate(zip(primitives, COMPONENTS)):
        require(primitive.get("extras", {}).get("componentName") == component, f"component {index} order is invalid")
        position_accessor, position_payload = accessor_bytes(document, binary, primitive["attributes"]["POSITION"])
        source_accessor, source_payload = accessor_bytes(document, binary, primitive["extras"]["sourceVertexIndicesAccessor"])
        validate_float_accessor(position_accessor, position_payload, position_accessor["count"], f"{component} POSITION")
        require(source_accessor.get("componentType") == UINT32 and source_accessor.get("type") == "SCALAR", f"{component} sourceVertexIndices must be uint32 SCALAR")
        require(source_accessor.get("count") == position_accessor["count"] and len(source_payload) == source_accessor["count"] * 4, f"{component} source mapping dimensions are invalid")
        source_ids = struct.unpack(f"<{source_accessor['count']}I", source_payload)
        unique_sources = set(source_ids)
        require(all(source < VERTEX_COUNT for source in source_ids), f"{component} sourceVertexId is out of range")
        for local_index, source in enumerate(source_ids):
            local_bytes = position_payload[local_index * 12:local_index * 12 + 12]
            template_offset = source * 12
            previous = source_bytes_by_id.get(source)
            require(previous is None or previous == local_bytes, f"{component} POSITION disagrees for sourceVertexId {source}")
            source_bytes_by_id[source] = local_bytes
            template[template_offset:template_offset + 12] = local_bytes
        all_sources.update(unique_sources)
        records.append({
            "component": component,
            "primitiveIndex": index,
            "positionAccessor": primitive["attributes"]["POSITION"],
            "sourceVertexIndicesAccessor": primitive["extras"]["sourceVertexIndicesAccessor"],
            "localVertexCount": position_accessor["count"],
            "sourceVertexCount": len(unique_sources),
            "sourceRange": [min(unique_sources), max(unique_sources)],
            "sourceRanges": contiguous_ranges(unique_sources),
            "sourceRangeContiguous": len(contiguous_ranges(unique_sources)) == 1,
            "positionMatchesTemplateBySourceId": True,
        })
    require(len(all_sources) == VERTEX_COUNT and all_sources == set(range(VERTEX_COUNT)), "component sourceVertexId sets are not exhaustive")
    source_sets = []
    for primitive, component in zip(document["meshes"][0]["primitives"], COMPONENTS):
        _, source_payload = accessor_bytes(document, binary, primitive["extras"]["sourceVertexIndicesAccessor"])
        source_accessor = document["accessors"][primitive["extras"]["sourceVertexIndicesAccessor"]]
        source_sets.append(set(struct.unpack(f"<{source_accessor['count']}I", source_payload)))
    require(sum(len(item) for item in source_sets) == VERTEX_COUNT and len(set().union(*source_sets)) == VERTEX_COUNT, "component source IDs are not disjoint/exhaustive")
    return records, all_sources


def compare_render(render_path: Path, template: bytes, canonical_records: list[dict[str, object]]) -> dict[str, object]:
    if not render_path.is_file():
        return {"status": "unavailable", "reason": "render-only GLB is not present"}
    document, binary = read_glb(render_path)
    official = document.get("extras", {}).get("sportsFaceGnmOfficial", {})
    require(official.get("renderOnly") is True and official.get("basisIncluded") is False and "basis" not in official, "render-only GLB basis boundary is invalid")
    results = []
    for canonical_record, primitive in zip(canonical_records, document["meshes"][0]["primitives"]):
        component = canonical_record["component"]
        position_accessor, position_payload = accessor_bytes(document, binary, primitive["attributes"]["POSITION"])
        source_accessor, source_payload = accessor_bytes(document, binary, primitive["extras"]["sourceVertexIndicesAccessor"])
        validate_float_accessor(position_accessor, position_payload, position_accessor["count"], f"render {component} POSITION")
        require(source_accessor.get("componentType") == UINT32 and source_accessor.get("type") == "SCALAR" and source_accessor["count"] == position_accessor["count"], f"render {component} source mapping is invalid")
        source_ids = struct.unpack(f"<{source_accessor['count']}I", source_payload)
        for local_index, source in enumerate(source_ids):
            require(position_payload[local_index * 12:local_index * 12 + 12] == template[source * 12:source * 12 + 12], f"render {component} POSITION does not match canonical template")
        results.append({"component": component, "optimizedVertexCount": position_accessor["count"], "sourceMappingMatchesCanonicalTemplate": True})
    return {"status": "pass", "path": render_path.name, "sha256": sha256(render_path), "basisIncluded": False, "components": results}


def diagnose(canonical_path: Path, metadata_path: Path, render_path: Path) -> dict[str, object]:
    canonical_document, canonical_binary = read_glb(canonical_path)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    canonical_hash = sha256(canonical_path)
    validate_metadata(metadata, canonical_hash, canonical_path.stat().st_size)
    official = canonical_document["extras"]["sportsFaceGnmOfficial"]
    require(official.get("mapping", {}).get("identityOnlyInvariant") is True, "canonical identity-only invariant is missing")
    names = {family: names_from(metadata, canonical_document, family, count) for family, count in (("identity", IDENTITY_COUNT), ("expression", EXPRESSION_COUNT))}

    template = bytearray(VERTEX_COUNT * 12)
    component_records, _ = validate_components(canonical_document, canonical_binary, template)
    template_bytes = bytes(template)
    template_finite = finite_f32_payload(template_bytes, "template")
    require(template_finite["finite"] is True, "assembled template contains non-finite coordinates")

    basis_reports: dict[str, object] = {}
    reconstruction_reports: dict[str, object] = {}
    for family, count in (("identity", IDENTITY_COUNT), ("expression", EXPRESSION_COUNT)):
        record = official["basis"][family]
        accessor, payload = accessor_bytes(canonical_document, canonical_binary, record["accessor"])
        validate_float_accessor(accessor, payload, count * VERTEX_COUNT, f"{family} basis")
        require(record.get("dtype") == "float32-le" and record.get("count") == count and record.get("shape") == [count, VERTEX_COUNT, 3], f"{family} basis metadata is invalid")
        finite_report = finite_f32_payload(payload, f"{family} basis")
        require(finite_report["finite"] is True, f"{family} basis contains non-finite values")
        basis_reports[family] = {"accessor": record["accessor"], "componentType": "FLOAT", "componentTypeCode": FLOAT32, "type": "VEC3", "count": count, "vertexCount": VERTEX_COUNT, "byteLength": len(payload), "expectedByteLength": count * VERTEX_COUNT * 12, "exactPayloadLength": len(payload) == count * VERTEX_COUNT * 12, **finite_report, "names": names[family]}
        samples = [0, count // 2, count - 1]
        one_hot = []
        for sample in samples:
            zero_output, zero_finite = reconstruct(template_bytes, payload, None)
            one_output, one_finite = reconstruct(template_bytes, payload, sample)
            expected = bytearray(len(template_bytes))
            for vertex in range(VERTEX_COUNT):
                offset = vertex * 12
                values = struct.unpack_from("<3f", template_bytes, offset)
                basis_values = struct.unpack_from("<3f", payload, sample * VERTEX_COUNT * 12 + offset)
                struct.pack_into("<3f", expected, offset, *(f32(values[axis] + basis_values[axis]) for axis in range(3)))
            one_hot.append({"index": sample, "name": names[family][sample], "zeroMatchesTemplate": zero_output == template_bytes, "zeroFinite": zero_finite, "oneHotMatchesTemplatePlusBasis": one_output == bytes(expected), "oneHotFinite": one_finite})
        reconstruction_reports[family] = {"samples": one_hot, "allPassed": all(item["zeroMatchesTemplate"] and item["oneHotMatchesTemplatePlusBasis"] and item["zeroFinite"] and item["oneHotFinite"] for item in one_hot)}
        require(reconstruction_reports[family]["allPassed"] is True, f"{family} reconstruction check failed")

    render_metadata = DEFAULT_RENDER_METADATA if render_path == DEFAULT_RENDER else render_path.with_suffix(".json")
    render_report = compare_render(render_path, template_bytes, component_records)
    if render_metadata.is_file():
        render_metadata_document = json.loads(render_metadata.read_text(encoding="utf-8"))
        require(render_metadata_document.get("basisIncluded") is False and render_metadata_document.get("renderOnly") is True, "render metadata basis boundary is invalid")
    report: dict[str, object] = {
        "schema": "sports-face-gnm-official-basis-diagnostic/v1",
        "version": 1,
        "source": {"canonicalGlb": {"path": canonical_path.name, "sizeBytes": canonical_path.stat().st_size, "sha256": canonical_hash}, "metadata": {"path": metadata_path.name, "sizeBytes": metadata_path.stat().st_size, "sha256": sha256(metadata_path)}, "renderGlb": render_report},
        "dimensions": {"vertexCount": VERTEX_COUNT, "identityCount": IDENTITY_COUNT, "expressionCount": EXPRESSION_COUNT},
        "names": names,
        "accessors": {"template": {"kind": "virtual-assembled-from-component-POSITION", "componentType": "FLOAT", "componentTypeCode": FLOAT32, "type": "VEC3", "count": VERTEX_COUNT, "byteLength": VERTEX_COUNT * 12, "exactPayloadLength": True, "finite": True}, "basis": basis_reports},
        "finiteChecks": {"template": template_finite, "identityBasis": basis_reports["identity"]["finite"], "expressionBasis": basis_reports["expression"]["finite"]},
        "reconstruction": {"arithmetic": "float32 round-to-nearest after each addition", "tolerance": {"absolute": 0.0, "relative": 0.0}, "identity": reconstruction_reports["identity"], "expression": reconstruction_reports["expression"]},
        "componentMappings": {"canonical": component_records, "sourceRanges": {"disjoint": True, "exhaustive": True, "vertexCount": VERTEX_COUNT}, "optimizedRender": render_report},
        "bounds": {"identity": displacement_bounds(accessor_bytes(canonical_document, canonical_binary, official["basis"]["identity"]["accessor"])[1], IDENTITY_COUNT), "expression": displacement_bounds(accessor_bytes(canonical_document, canonical_binary, official["basis"]["expression"]["accessor"])[1], EXPRESSION_COUNT)},
        "semanticMapping": "disabled",
        "runtimeBasisLoaded": False,
        "reportHashSha256": "",
    }
    digest_input = json.dumps({key: value for key, value in report.items() if key != "reportHashSha256"}, ensure_ascii=True, indent=2, sort_keys=True) + "\n"
    report["reportHashSha256"] = hashlib.sha256(digest_input.encode("utf-8")).hexdigest()
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--canonical", type=Path, default=DEFAULT_CANONICAL)
    parser.add_argument("--metadata", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--render", type=Path, default=DEFAULT_RENDER)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv)
    try:
        report = diagnose(args.canonical, args.metadata, args.render)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=True, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except (OSError, DiagnosticError, KeyError, TypeError, ValueError, struct.error) as error:
        print(f"FAIL official GNM basis diagnostic: {error}", file=sys.stderr)
        return 1
    print(f"PASS {args.output}: {IDENTITY_COUNT} identity + {EXPRESSION_COUNT} expression float32 basis directions, {VERTEX_COUNT} template vertices, six source mappings, semanticMapping=disabled")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
