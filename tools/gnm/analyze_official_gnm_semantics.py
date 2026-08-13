#!/usr/bin/env python3
"""Generate conservative quantitative evidence for official GNM semantics.

The analyzer is deliberately offline and standard-library-only.  It memory-maps
the canonical GLB and reads float32 records with ``struct``; it never creates a
large Python array and never imports application/runtime code.  Technical group
names are reported as descriptive prefixes only.  They are not anatomical or
FaceDNA semantics.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import mmap
from pathlib import Path
import re
import struct
from typing import BinaryIO


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CANONICAL = ROOT / "tools/gnm/work/gnm-official-head.glb"
DEFAULT_METADATA = ROOT / "tools/gnm/work/gnm-official-head.json"
DEFAULT_DIAGNOSTIC = ROOT / "tools/gnm/work/gnm-official-basis-diagnostic.json"
DEFAULT_RENDER = ROOT / "tools/gnm/work/gnm-official-head-render.glb"
DEFAULT_RENDER_METADATA = ROOT / "tools/gnm/work/gnm-official-head-render.json"
DEFAULT_VERTEX_MAP = ROOT / "tools/gnm/work/gnm-vertex-map.json"
DEFAULT_FACEDNA = ROOT / "src/face-model.js"
DEFAULT_MORPHOLOGY = ROOT / "src/morphology.js"
DEFAULT_MORPH_PACK = ROOT / "tools/gnm/work/gnm-morphology-pack.json"
DEFAULT_OUTPUT = ROOT / "tools/gnm/work/gnm-official-semantic-evidence.json"

SCHEMA = "sports-face-gnm-semantic-evidence/v1"
UPSTREAM_REVISION = "8ea2906a31aab7f8b550e33968f3c0a86051a92d"
PROJECT_REVISION = "da9982f"
VERTEX_COUNT = 17821
IDENTITY_COUNT = 253
EXPRESSION_COUNT = 383
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
GROUPS = ("head", "eyes", "teeth", "left_eye_region", "right_eye_region", "lower_face_region", "tongue", "pupils")
COMPONENTS = ("skin", "left_eye", "right_eye", "upper_teeth_and_gums", "lower_teeth_and_gums", "tongue")


class AnalysisError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AnalysisError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def relative_name(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError as error:
        raise AnalysisError(f"input must be inside the project: {path}") from error


def read_glb_layout(path: Path) -> tuple[dict, int, int]:
    with path.open("rb") as handle:
        header = handle.read(12)
        require(len(header) == 12, "GLB header is truncated")
        magic, version, length = struct.unpack("<4sII", header)
        require(magic == b"glTF" and version == 2 and length == path.stat().st_size, "GLB header is invalid")
        json_payload = None
        bin_offset = None
        bin_length = None
        offset = 12
        while offset < length:
            handle.seek(offset)
            chunk_header = handle.read(8)
            require(len(chunk_header) == 8, "GLB chunk header is truncated")
            chunk_size, chunk_type = struct.unpack("<II", chunk_header)
            chunk_data_offset = offset + 8
            require(chunk_size % 4 == 0 and chunk_data_offset + chunk_size <= length, "GLB chunk range is invalid")
            if chunk_type == JSON_CHUNK:
                handle.seek(chunk_data_offset)
                json_payload = handle.read(chunk_size)
            elif chunk_type == BIN_CHUNK:
                bin_offset, bin_length = chunk_data_offset, chunk_size
            offset = chunk_data_offset + chunk_size
        require(json_payload is not None and bin_offset is not None and bin_length is not None, "GLB JSON/BIN chunks are missing")
        try:
            document = json.loads(json_payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise AnalysisError(f"GLB JSON is invalid: {error}") from error
        require(document.get("buffers", [{}])[0].get("byteLength") == bin_length, "GLB BIN length is invalid")
        return document, bin_offset, bin_length


COMPONENT_BYTE_LENGTHS = {5121: 1, 5123: 2, 5125: 4, 5126: 4}
TYPE_COMPONENT_COUNTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def accessor_span(document: dict, accessor_index: int, bin_length: int) -> tuple[int, int, dict]:
    try:
        accessor = document["accessors"][accessor_index]
        view = document["bufferViews"][accessor["bufferView"]]
    except (IndexError, KeyError, TypeError) as error:
        raise AnalysisError(f"accessor {accessor_index} metadata is incomplete") from error
    require(isinstance(accessor, dict) and isinstance(view, dict), f"accessor {accessor_index} metadata is invalid")
    require(view.get("buffer") == 0, f"accessor {accessor_index} references an unsupported buffer")
    require(accessor.get("componentType") in COMPONENT_BYTE_LENGTHS, f"accessor {accessor_index} componentType is unsupported")
    require(accessor.get("type") in TYPE_COMPONENT_COUNTS, f"accessor {accessor_index} type is unsupported")
    count = accessor.get("count")
    view_length = view.get("byteLength")
    view_offset = view.get("byteOffset", 0)
    accessor_offset = accessor.get("byteOffset", 0)
    require(isinstance(count, int) and count >= 0, f"accessor {accessor_index} count is invalid")
    require(isinstance(view_length, int) and view_length >= 0, f"accessor {accessor_index} byteLength is invalid")
    require(isinstance(view_offset, int) and view_offset >= 0, f"bufferView for accessor {accessor_index} byteOffset is invalid")
    require(isinstance(accessor_offset, int) and accessor_offset >= 0, f"accessor {accessor_index} byteOffset is invalid")
    require("byteStride" not in view, f"accessor {accessor_index} uses unsupported byteStride")
    element_length = COMPONENT_BYTE_LENGTHS[accessor["componentType"]] * TYPE_COMPONENT_COUNTS[accessor["type"]]
    expected_length = accessor_offset + count * element_length
    require(view_length == expected_length, f"accessor {accessor_index} byteLength is not exact")
    offset = view_offset + accessor_offset
    require(offset % 4 == 0, f"accessor {accessor_index} is not aligned")
    require(view_offset + view_length <= bin_length, f"accessor {accessor_index} is outside BIN")
    require(offset + count * element_length <= bin_length, f"accessor {accessor_index} payload is outside BIN")
    return offset, count * element_length, accessor


def unpack_f32(binary: mmap.mmap, offset: int) -> tuple[float, float, float]:
    return struct.unpack_from("<3f", binary, offset)


def unpack_u32(binary: mmap.mmap, offset: int) -> int:
    return struct.unpack_from("<I", binary, offset)[0]


def technical_group(name: str) -> str:
    for group in GROUPS:
        if name == group or name.startswith(f"{group}_"):
            return group
    raise AnalysisError(f"basis name has no technical group: {name}")


def extract_string_array(source: str, constant: str) -> list[str]:
    match = re.search(rf"export const {re.escape(constant)} = Object\.freeze\(\[(.*?)\]\);", source, re.S)
    require(match is not None, f"could not extract {constant}")
    return re.findall(r'"([^"\\]*(?:\\.[^"\\]*)*)"', match.group(1))


def extract_object_array(source: str, constant: str) -> list[dict[str, str | int]]:
    match = re.search(rf"export const {re.escape(constant)} = Object\.freeze\(\[(.*?)\]\);", source, re.S)
    require(match is not None, f"could not extract {constant}")
    records: list[dict[str, str | int]] = []
    for body in re.findall(r"\{(.*?)\}", match.group(1), re.S):
        record: dict[str, str | int] = {}
        for field in ("key", "type", "domain", "status"):
            field_match = re.search(rf"\b{field}:\s*(?:\"([^\"]+)\"|[A-Za-z0-9_]+\.([A-Za-z0-9_-]+))", body)
            if field_match:
                record[field] = field_match.group(1) or field_match.group(2)
        values_match = re.search(r"\bvalidValues:\s*(\d+)", body)
        length_match = re.search(r"\blength:\s*(\d+)", body)
        require("key" in record and "domain" in record and "type" in record and values_match is not None, f"incomplete FaceDNA variable: {body}")
        record["validValues"] = int(values_match.group(1))
        record["bitLength"] = int(length_match.group(1)) if length_match else 0
        record["status"] = record.get("status", "active")
        records.append(record)
    return records


def extract_catalogs(source: str) -> dict[str, list[str]]:
    match = re.search(r"export const ASSET_CATALOGS = Object\.freeze\(\{(.*?)\n\}\);", source, re.S)
    require(match is not None, "could not extract ASSET_CATALOGS")
    catalogs: dict[str, list[str]] = {}
    for key, body in re.findall(r"^\s*(\w+): Object\.freeze\(\[(.*?)\]\),", match.group(1), re.M | re.S):
        catalogs[key] = re.findall(r'"([^"\\]*(?:\\.[^"\\]*)*)"', body)
    return catalogs


def extract_rules(source: str) -> list[dict[str, str]]:
    match = re.search(r"export const GNM_FAMILY_SELECTION_RULES = Object\.freeze\(\[(.*?)\]\);", source, re.S)
    require(match is not None, "could not extract GNM_FAMILY_SELECTION_RULES")
    rules = []
    for condition, family_id in re.findall(r'condition:\s*"([^"]+)",\s*familyId:\s*"([^"]+)"', match.group(1)):
        rules.append({"condition": condition, "familyId": family_id})
    return rules


def facedna_inventory(path: Path) -> dict:
    source = path.read_text(encoding="utf-8")
    variables = extract_object_array(source, "IDENTITY_VARS") + extract_object_array(source, "APPEARANCE_VARS")
    catalogs = extract_catalogs(source)
    inventory = []
    for variable in variables:
        key = str(variable["key"])
        values = catalogs.get(key, [])
        require(len(values) == variable["validValues"], f"FaceDNA catalog count differs for {key}")
        inventory.append({
            "key": key,
            "domain": variable["domain"],
            "type": variable["type"],
            "bitLength": variable["bitLength"],
            "validValues": variable["validValues"],
            "values": values,
            "reservedStatus": variable["status"],
            "reserved": variable["status"] != "active",
        })
    return {"variableCount": len(inventory), "variables": inventory}


def morphology_inventory(path: Path, pack_path: Path) -> dict:
    source = path.read_text(encoding="utf-8")
    features = extract_string_array(source, "GNM_MORPHOLOGY_FEATURES")
    inputs = extract_string_array(source, "GNM_FAMILY_SELECTION_INPUTS")
    rules = extract_rules(source)
    modes = extract_string_array(source, "MICRO_EXPRESSION_MODES")
    pack = json.loads(pack_path.read_text(encoding="utf-8"))
    return {
        "sourceKind": "analytic-starter",
        "sourceGnmDerived": False,
        "featureCount": len(features),
        "features": features,
        "familyCount": len(pack.get("families", [])),
        "familySelection": {"version": "face-dna-shape-v1", "inputs": inputs, "ruleCount": len(rules), "rules": rules},
        "microExpressionModes": modes,
        "expressionModes": ["auto", *modes],
        "pack": {"path": relative_name(pack_path), "sha256": sha256(pack_path), "sampleCount": sum(int(f.get("memberCount", 0)) for f in pack.get("families", []))},
    }


def source_record(path: Path) -> dict[str, str | int]:
    return {"path": relative_name(path), "sizeBytes": path.stat().st_size, "sha256": sha256(path)}


def assemble_template(document: dict, binary: mmap.mmap, binary_base: int, binary_length: int) -> tuple[list[tuple[float, float, float]], list[str]]:
    template = [(0.0, 0.0, 0.0)] * VERTEX_COUNT
    components = ["" for _ in range(VERTEX_COUNT)]
    primitives = document["meshes"][0]["primitives"]
    require(len(primitives) == len(COMPONENTS), "canonical GLB must have six components")
    for component, primitive in zip(COMPONENTS, primitives):
        position_offset, position_length, position_accessor = accessor_span(document, primitive["attributes"]["POSITION"], binary_length)
        source_offset, source_length, source_accessor = accessor_span(document, primitive["extras"]["sourceVertexIndicesAccessor"], binary_length)
        count = position_accessor["count"]
        require(position_accessor.get("componentType") == 5126 and position_accessor.get("type") == "VEC3", f"{component} positions are invalid")
        require(source_accessor.get("componentType") == 5125 and source_accessor.get("type") == "SCALAR" and source_accessor["count"] == count, f"{component} source IDs are invalid")
        require(position_length >= count * 12 and source_length >= count * 4, f"{component} payload is truncated")
        for local_index in range(count):
            source_id = unpack_u32(binary, binary_base + source_offset + local_index * 4)
            require(0 <= source_id < VERTEX_COUNT, f"source ID out of range: {source_id}")
            require(components[source_id] in ("", component), f"source ID overlaps components: {source_id}")
            template[source_id] = unpack_f32(binary, binary_base + position_offset + local_index * 12)
            components[source_id] = component
    require(all(component for component in components), "component source IDs are not exhaustive")
    return template, components


def energy_report(document: dict, binary: mmap.mmap, binary_base: int, binary_length: int, metadata: dict, template: list[tuple[float, float, float]], components: list[str], vertex_map_path: Path | None) -> tuple[dict, dict | None]:
    official = document["extras"]["sportsFaceGnmOfficial"]
    basis_reports: dict[str, dict] = {}
    landmark_regions: dict | None = None
    landmark_data = json.loads(vertex_map_path.read_text(encoding="utf-8")) if vertex_map_path else None
    landmark_indices: dict[str, list[int]] = {}
    if landmark_data:
        coordinates = landmark_data.get("coordinates", {})
        require(isinstance(coordinates, dict), "landmark coordinates are invalid")
        for name, ids in landmark_data.get("landmarks", {}).items():
            require(name in coordinates, f"landmark {name} has no coordinate")
            require(isinstance(ids, list), f"landmark {name} IDs are invalid")
            landmark_indices[name] = [int(value) for value in ids]
        radius = 0.01
        radius_sq = radius * radius
        selected: dict[str, list[int]] = {}
        declared_validation: dict[str, dict[str, int | str]] = {}
        for name, coordinate in coordinates.items():
            require(isinstance(coordinate, list) and len(coordinate) == 3, f"landmark {name} coordinate is invalid")
            require(all(isinstance(value, (int, float)) and math.isfinite(value) for value in coordinate), f"landmark {name} coordinate is invalid")
            selected[name] = [index for index, point in enumerate(template) if sum((point[axis] - coordinate[axis]) ** 2 for axis in range(3)) <= radius_sq]
            declared = landmark_indices.get(name, [])
            in_range = sum(0 <= index < VERTEX_COUNT for index in declared)
            within_radius = sum(0 <= index < VERTEX_COUNT and index in selected[name] for index in declared)
            validation = {
                "declaredCount": len(declared),
                "inRangeCount": in_range,
                "withinRadiusCount": within_radius,
                "outOfRangeCount": len(declared) - in_range,
                "outsideRadiusCount": in_range - within_radius,
                "status": "passed" if in_range == len(declared) and within_radius == len(declared) else "failed",
            }
            declared_validation[name] = validation
            require(validation["status"] == "passed", f"landmark {name} declared ID validation failed")
        assignment_count = sum(len(indices) for indices in selected.values())
        unique_vertex_count = len({index for indices in selected.values() for index in indices})
        overlap_assignment_count = assignment_count - unique_vertex_count
        max_regions_per_vertex = max((sum(index in indices for indices in selected.values()) for index in range(VERTEX_COUNT)), default=0)
        landmark_regions = {
            "status": "provisional-descriptive-only",
            "anatomicalCorrectness": "not_proven",
            "mapStatus": landmark_data.get("status"),
            "mapSha256": sha256(vertex_map_path),
            "radius": radius,
            "radiusUnits": "canonical mesh coordinate units",
            "normalization": "raw sum of squared displacement energy over vertices within radius; share divides by the family total; no area normalization",
            "noAnatomicalClaims": True,
            "declaredIdValidation": {
                "status": "passed",
                "assignmentCount": sum(item["declaredCount"] for item in declared_validation.values()),
                "inRangeCount": sum(item["inRangeCount"] for item in declared_validation.values()),
                "withinRadiusCount": sum(item["withinRadiusCount"] for item in declared_validation.values()),
                "outOfRangeCount": sum(item["outOfRangeCount"] for item in declared_validation.values()),
                "outsideRadiusCount": sum(item["outsideRadiusCount"] for item in declared_validation.values()),
                "regions": declared_validation,
            },
            "assignmentCount": assignment_count,
            "uniqueVertexCount": unique_vertex_count,
            "overlapAssignmentCount": overlap_assignment_count,
            "maxRegionsPerVertex": max_regions_per_vertex,
            "regionsAreNonExclusive": True,
            "sumWarning": "Regional energies must not be summed because radius-selected regions overlap.",
            "regions": {},
        }
    for family, count in (("identity", IDENTITY_COUNT), ("expression", EXPRESSION_COUNT)):
        names = metadata["basis"][family]["names"]
        accessor_offset, accessor_length, accessor = accessor_span(document, official["basis"][family]["accessor"], binary_length)
        require(accessor.get("count") == count * VERTEX_COUNT, f"{family} accessor dimensions are invalid")
        require(accessor_length == count * VERTEX_COUNT * 12, f"{family} accessor payload length is invalid")
        group_totals = {group: 0.0 for group in GROUPS}
        component_totals = {component: 0.0 for component in COMPONENTS}
        total = 0.0
        basis_records = []
        region_totals = {name: 0.0 for name in landmark_indices}
        region_membership = {}
        if landmark_data:
            for region, indices in selected.items():
                for vertex_index in indices:
                    region_membership.setdefault(vertex_index, []).append(region)
        region_counts = {name: len(selected.get(name, [])) for name in landmark_indices} if landmark_data else {}
        for basis_index, name in enumerate(names):
            start = accessor_offset + basis_index * VERTEX_COUNT * 12
            energy = 0.0
            max_abs = 0.0
            component_energy = {component: 0.0 for component in COMPONENTS}
            for vertex_index in range(VERTEX_COUNT):
                x, y, z = unpack_f32(binary, binary_base + start + vertex_index * 12)
                require(math.isfinite(x) and math.isfinite(y) and math.isfinite(z), f"non-finite {family} basis payload")
                value = x * x + y * y + z * z
                energy += value
                max_abs = max(max_abs, abs(x), abs(y), abs(z))
                component_energy[components[vertex_index]] += value
                if landmark_data:
                    for region in region_membership.get(vertex_index, ()):
                        region_totals[region] += value
            group = technical_group(name)
            group_totals[group] += energy
            for component, value in component_energy.items():
                component_totals[component] += value
            total += energy
            basis_records.append({"index": basis_index, "name": name, "group": group, "energy": energy, "share": 0.0, "l2Norm": math.sqrt(energy), "maxAbsDisplacement": max_abs, "componentEnergy": component_energy})
        for record in basis_records:
            record["share"] = record["energy"] / total
        basis_reports[family] = {
            "count": count,
            "totalEnergy": total,
            "frobeniusNorm": math.sqrt(total),
            "groups": {group: {"count": sum(1 for name in names if technical_group(name) == group), "energy": value, "share": value / total} for group, value in group_totals.items() if value or any(technical_group(name) == group for name in names)},
            "components": {component: {"energy": value, "share": value / total} for component, value in component_totals.items()},
            "basis": basis_records,
        }
        if landmark_data and landmark_regions is not None:
            landmark_regions["regions"][family] = {
                name: {"vertexCount": region_counts[name], "energy": value, "share": value / total}
                for name, value in region_totals.items()
            }
    return basis_reports, landmark_regions


def analyze(paths: dict[str, Path]) -> dict:
    canonical = paths["canonical"]
    document, bin_file_offset, bin_length = read_glb_layout(canonical)
    metadata = json.loads(paths["metadata"].read_text(encoding="utf-8"))
    diagnostic = json.loads(paths["diagnostic"].read_text(encoding="utf-8"))
    render_metadata = json.loads(paths["render_metadata"].read_text(encoding="utf-8"))
    render_document, _, _ = read_glb_layout(paths["render"])
    require(metadata.get("geometry", {}).get("vertexCount") == VERTEX_COUNT, "metadata vertex count is invalid")
    require(diagnostic.get("dimensions") == {"vertexCount": VERTEX_COUNT, "identityCount": IDENTITY_COUNT, "expressionCount": EXPRESSION_COUNT}, "basis diagnostic dimensions are invalid")
    require(diagnostic.get("semanticMapping") == "disabled" and diagnostic.get("runtimeBasisLoaded") is False, "basis diagnostic boundary is invalid")
    require(render_metadata.get("basisIncluded") is False and render_metadata.get("renderOnly") is True, "render metadata basis boundary is invalid")
    render_official = render_document.get("extras", {}).get("sportsFaceGnmOfficial", {})
    require(render_official.get("basisIncluded") is False and render_official.get("renderOnly") is True, "render GLB basis boundary is invalid")
    with canonical.open("rb") as handle:
        with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as mapped_file:
            # Keep the 139 MB BIN chunk memory-mapped; no Python bytes/array copy
            # is made.  Accessors are relative to this chunk and add its base.
            binary = mapped_file
            template, components = assemble_template(document, binary, bin_file_offset, bin_length)
            basis, landmark_regions = energy_report(document, binary, bin_file_offset, bin_length, metadata, template, components, paths.get("vertex_map"))
    report = {
        "schema": SCHEMA,
        "version": 1,
        "conclusion": "Official GNM basis payloads are quantitatively characterized, but FaceDNA semantic mapping is currently unestablished.",
        "semanticMapping": "unestablished",
        "runtimeBasisLoaded": False,
        "precisionPolicy": {
            "calculation": "Full JSON float precision from deterministic IEEE float32-derived Python calculations.",
            "basisPayload": "Source little-endian float32 values are unpacked with struct; derived values are not decimal-rounded.",
            "rawBasisArraysIncluded": False,
            "reportSizeBudgetBytes": 600000,
        },
        "source": {
            "evidenceBaseRevision": PROJECT_REVISION,
            "upstreamRepository": metadata["source"]["repository"],
            "upstreamRevision": metadata["source"]["revision"],
            "archiveSha256": metadata["source"]["archiveSha256"],
            "npzSha256": metadata["source"]["npzSha256"],
            "files": {key: source_record(path) for key, path in paths.items() if path is not None},
        },
        "dimensions": {"vertexCount": VERTEX_COUNT, "identityCount": IDENTITY_COUNT, "expressionCount": EXPRESSION_COUNT},
        "technicalGrouping": {"names": list(GROUPS), "descriptiveOnly": True, "semanticClaim": False, "rule": "exact technical name prefixes; grouping is not anatomical or FaceDNA semantic evidence"},
        "basis": basis,
        "landmarkRegionEnergy": landmark_regions or {"status": "unavailable", "reason": "vertex map was not supplied"},
        "faceDna": facedna_inventory(paths["facedna"]),
        "morphology": morphology_inventory(paths["morphology"], paths["morph_pack"]),
        "missingEvidence": [
            "No paired FaceDNA value -> official GNM coefficient dataset exists.",
            "No paired FaceDNA value -> target-geometry observation dataset exists.",
            "Official technical names and regional energy concentrations do not establish application semantics.",
            "The provisional vertex map is not anatomical evidence and is not area-normalized.",
        ],
        "futureAcceptanceCriteria": [
            "Human-approved paired FaceDNA -> GNM coefficient/target dataset with versioned provenance.",
            "Held-out R² threshold defined before fitting and met for each mapped variable.",
            "Cross-validation with leakage controls and confidence intervals.",
            "Bilateral consistency checks for paired left/right controls.",
            "Causal one-hot tests showing the intended variable changes the target and unrelated targets stay bounded.",
            "Negative controls against shuffled labels, unrelated variables, and region-only shortcuts.",
            "Human approval of visual and technical semantics.",
            "Versioned mapping metadata with source hashes, coefficients, normalization, and rollback identity.",
        ],
        "reportHashSha256": "",
    }
    digest_input = json.dumps({key: value for key, value in report.items() if key != "reportHashSha256"}, ensure_ascii=True, indent=2, sort_keys=True) + "\n"
    report["reportHashSha256"] = hashlib.sha256(digest_input.encode("utf-8")).hexdigest()
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--canonical", type=Path, default=DEFAULT_CANONICAL)
    parser.add_argument("--metadata", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--diagnostic", type=Path, default=DEFAULT_DIAGNOSTIC)
    parser.add_argument("--render", type=Path, default=DEFAULT_RENDER)
    parser.add_argument("--render-metadata", type=Path, default=DEFAULT_RENDER_METADATA)
    parser.add_argument("--vertex-map", type=Path, default=DEFAULT_VERTEX_MAP)
    parser.add_argument("--facedna", type=Path, default=DEFAULT_FACEDNA)
    parser.add_argument("--morphology", type=Path, default=DEFAULT_MORPHOLOGY)
    parser.add_argument("--morphology-pack", type=Path, default=DEFAULT_MORPH_PACK)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv)
    paths = {"canonical": args.canonical, "metadata": args.metadata, "diagnostic": args.diagnostic, "render": args.render, "render_metadata": args.render_metadata, "vertex_map": args.vertex_map, "facedna": args.facedna, "morphology": args.morphology, "morph_pack": args.morphology_pack}
    try:
        report = analyze(paths)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=True, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except (OSError, AnalysisError, KeyError, TypeError, ValueError, struct.error, json.JSONDecodeError) as error:
        print(f"FAIL official GNM semantic evidence: {error}")
        return 1
    print(f"PASS {args.output.name}: schema={SCHEMA}, 253 identity + 383 expression, 17821 vertices, semanticMapping=unestablished, reportHashSha256={report['reportHashSha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
