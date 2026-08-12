#!/usr/bin/env python3
"""Import the official GNM v3 Head NPZ into a portable, neutral GLB package.

NumPy is intentionally an offline-only dependency. The importer fails closed if
the official topology, UVs, or component masks cannot be mapped exactly.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys

import numpy as np


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INPUT = Path("/home/nico/src/GNM/gnm/shape/data/versions/v3_0/gnm_head.npz")
DEFAULT_OUTPUT = ROOT / "tools/gnm/work/gnm-official-head.glb"
DEFAULT_METADATA = ROOT / "tools/gnm/work/gnm-official-head.json"
DEFAULT_MANIFEST = ROOT / "tools/gnm/work/official-bundle.json"
DEFAULT_LICENSE_OUTPUT = ROOT / "tools/gnm/work/LICENSE-GNM.txt"
SOURCE_REPOSITORY = "https://github.com/google/GNM"
SOURCE_REVISION = "8ea2906a31aab7f8b550e33968f3c0a86051a92d"
SOURCE_ARCHIVE_SHA256 = "2aabb75107ed5a3c7be45ba93700fbfa7e1333c646054ff9dc9d267dd02b730d"
NPZ_SHA256 = "03649b09d1f756c94e8b3db709edcfa07ac367de0ba35e2d04c985ebcadbaf14"
NPZ_SIZE = 53305389
LICENSE_SHA256 = "58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd"
DECISION_DATE = "2026-08-12"
DECISION_REFERENCE = "sports-face-mvp-noncommercial-mvp-authorization"
COMPONENTS = (
    "skin",
    "left_eye",
    "right_eye",
    "upper_teeth_and_gums",
    "lower_teeth_and_gums",
    "tongue",
)
GLB_MAGIC = b"glTF"
GLB_VERSION = 2
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


class ImportErrorClosed(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ImportErrorClosed(message)


def aligned(data: bytes) -> bytes:
    return data + b"\0" * ((-len(data)) % 4)


def aligned_json(data: bytes) -> bytes:
    return data + b" " * ((-len(data)) % 4)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--metadata", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--license-output", type=Path, default=DEFAULT_LICENSE_OUTPUT)
    parser.add_argument("--license-input", type=Path, default=Path("/home/nico/src/GNM/LICENSE"))
    return parser.parse_args(argv)


def load_source(path: Path) -> dict[str, np.ndarray | list[str]]:
    require(path.is_file(), f"official NPZ does not exist: {path}")
    require(path.stat().st_size == NPZ_SIZE, "official NPZ size does not match the reviewed source")
    require(digest(path) == NPZ_SHA256, "official NPZ SHA-256 does not match the reviewed source")
    try:
        archive = np.load(path, allow_pickle=False)
    except (OSError, ValueError) as error:
        raise ImportErrorClosed(f"could not read official NPZ: {error}") from error
    with archive:
        required = (
            "template_vertex_positions", "triangles", "quads", "triangle_uvs", "quad_uvs",
            "vertex_identity_basis", "identity_names", "expression_basis", "expression_names",
            "mesh_component_names", "vertex_group_names", "vertex_groups",
        )
        missing = [name for name in required if name not in archive]
        require(not missing, f"official NPZ is missing required array(s): {', '.join(missing)}")
        return {name: np.array(archive[name], copy=True) for name in required}


def validate_source(data: dict[str, np.ndarray]) -> dict[str, object]:
    template = data["template_vertex_positions"]
    triangles = data["triangles"]
    quads = data["quads"]
    triangle_uvs = data["triangle_uvs"]
    quad_uvs = data["quad_uvs"]
    identity_basis = data["vertex_identity_basis"]
    expression_basis = data["expression_basis"]
    component_names = [str(value) for value in data["mesh_component_names"].tolist()]
    group_names = [str(value) for value in data["vertex_group_names"].tolist()]
    groups = data["vertex_groups"]

    require(template.shape == (17821, 3) and template.dtype == np.float32, "template_vertex_positions must be float32 (17821, 3)")
    require(np.isfinite(template).all(), "template_vertex_positions contains non-finite values")
    require(triangles.shape == (35324, 3) and triangles.dtype.kind in "iu", "triangles must be integer (35324, 3)")
    require(quads.shape == (17662, 4) and quads.dtype.kind in "iu", "quads must be integer (17662, 4)")
    require(triangle_uvs.shape == (35324, 3, 2) and triangle_uvs.dtype == np.float32, "triangle_uvs must be float32 (35324, 3, 2)")
    require(quad_uvs.shape == (17662, 4, 2) and quad_uvs.dtype == np.float32, "quad_uvs must be float32 (17662, 4, 2)")
    require(np.isfinite(triangle_uvs).all() and np.isfinite(quad_uvs).all(), "UVs contain non-finite values")
    require(identity_basis.shape == (253, 17821, 3) and identity_basis.dtype == np.float32, "vertex_identity_basis must be float32 (253, 17821, 3)")
    require(expression_basis.shape == (383, 17821, 3) and expression_basis.dtype == np.float32, "expression_basis must be float32 (383, 17821, 3)")
    require(np.isfinite(identity_basis).all() and np.isfinite(expression_basis).all(), "basis contains non-finite values")
    require(component_names == list(COMPONENTS), "mesh_component_names do not match the reviewed six-component contract")
    require(groups.shape == (len(group_names), 17821) and groups.dtype == np.float32, "vertex_groups shape/dtype is invalid")

    component_indices = []
    for component in COMPONENTS:
        require(component in group_names, f"component group is missing: {component}")
        weights = groups[group_names.index(component)]
        require(np.all((weights == 0) | (weights == 1)), f"component group is not binary: {component}")
        component_indices.append(weights.astype(bool))
    component_matrix = np.stack(component_indices)
    require(np.all(component_matrix.sum(axis=0) == 1), "component groups must be disjoint and exhaustive")

    triangle_components = component_matrix[:, triangles]
    require(np.all(triangle_components.sum(axis=0) == 1), "every triangle corner must belong to exactly one component")
    winners = triangle_components.argmax(axis=0)
    require(np.all(winners == winners[:, 0:1]), "a triangle crosses component boundaries")
    counts = [int((winners[:, 0] == index).sum()) for index in range(len(COMPONENTS))]
    require(sum(counts) == triangles.shape[0], "component triangle counts do not cover the topology")
    require(np.all(triangles >= 0) and np.all(triangles < template.shape[0]), "triangle index is out of range")

    # The triangle UV array is authoritative. Verify it against the quad UV map
    # by vertex identity, without assuming the quad split order.
    quad_lookup: dict[tuple[int, int, int], int] = {}
    for quad_index, quad in enumerate(quads):
        for omitted in range(4):
            key = tuple(sorted(int(vertex) for corner, vertex in enumerate(quad) if corner != omitted))
            require(key not in quad_lookup, "quad topology has ambiguous triangle membership")
            quad_lookup[key] = quad_index
    for triangle, uv in zip(triangles, triangle_uvs):
        quad_index = quad_lookup.get(tuple(sorted(int(vertex) for vertex in triangle)))
        require(quad_index is not None, "triangle topology cannot be mapped to a quad")
        expected = np.array([quad_uvs[quad_index, np.where(quads[quad_index] == vertex)[0][0]] for vertex in triangle])
        require(np.array_equal(expected, uv), "triangle UVs do not match quad UVs by source vertex")

    return {
        "vertexCount": int(template.shape[0]),
        "triangleCount": int(triangles.shape[0]),
        "quadCount": int(quads.shape[0]),
        "identityCount": int(identity_basis.shape[0]),
        "expressionCount": int(expression_basis.shape[0]),
        "componentTriangleCounts": dict(zip(COMPONENTS, counts)),
    }


def add_payload(parts: list[bytes], payload: bytes, target: int | None = None) -> tuple[int, int]:
    offset = sum(len(part) for part in parts)
    data = aligned(payload)
    parts.append(data)
    return offset, len(payload)


def make_glb(data: dict[str, np.ndarray], summary: dict[str, object]) -> tuple[bytes, dict[str, object]]:
    template = data["template_vertex_positions"]
    triangles = data["triangles"].astype(np.uint32, copy=False)
    triangle_uvs = data["triangle_uvs"]
    group_names = [str(value) for value in data["vertex_group_names"].tolist()]
    groups = data["vertex_groups"]
    component_matrix = np.stack([groups[group_names.index(component)].astype(bool) for component in COMPONENTS])
    triangle_components = component_matrix[:, triangles].argmax(axis=0)[:, 0]

    binary_parts: list[bytes] = []
    buffer_views: list[dict[str, object]] = []
    accessors: list[dict[str, object]] = []
    primitives: list[dict[str, object]] = []
    component_records: list[dict[str, object]] = []

    def append_view(payload: bytes, *, target: int | None = None) -> int:
        offset, length = add_payload(binary_parts, payload)
        view: dict[str, object] = {"buffer": 0, "byteLength": length, "byteOffset": offset}
        if target is not None:
            view["target"] = target
        buffer_views.append(view)
        return len(buffer_views) - 1

    def append_accessor(view_index: int, component_type: int, accessor_type: str, count: int, *, minimum: list[float] | None = None, maximum: list[float] | None = None) -> int:
        accessor: dict[str, object] = {
            "bufferView": view_index,
            "componentType": component_type,
            "count": count,
            "type": accessor_type,
        }
        if minimum is not None:
            accessor["min"] = minimum
        if maximum is not None:
            accessor["max"] = maximum
        accessors.append(accessor)
        return len(accessors) - 1

    colors = (
        (0.62, 0.42, 0.32, 1.0),
        (0.92, 0.96, 1.0, 1.0),
        (0.92, 0.96, 1.0, 1.0),
        (0.96, 0.92, 0.82, 1.0),
        (0.96, 0.92, 0.82, 1.0),
        (0.72, 0.26, 0.30, 1.0),
    )
    materials = []
    for component, color in zip(COMPONENTS, colors):
        materials.append({
            "name": f"GNM Neutral Procedural {component}",
            "extras": {"materialSource": "neutral-procedural", "officialTexturesIncluded": False},
            "pbrMetallicRoughness": {
                "baseColorFactor": list(color),
                "metallicFactor": 0.0,
                "roughnessFactor": 0.88 if component == "skin" else 0.5,
            },
        })

    for component_index, component in enumerate(COMPONENTS):
        selected = np.flatnonzero(triangle_components == component_index)
        source_triangles = triangles[selected]
        positions = np.ascontiguousarray(template[source_triangles].reshape(-1, 3), dtype="<f4")
        uvs = np.ascontiguousarray(triangle_uvs[selected].reshape(-1, 2), dtype="<f4")
        source_indices = np.ascontiguousarray(source_triangles.reshape(-1), dtype="<u4")
        local_indices = np.arange(positions.shape[0], dtype="<u4")
        position_view = append_view(positions.tobytes(), target=34962)
        uv_view = append_view(uvs.tobytes(), target=34962)
        source_view = append_view(source_indices.tobytes())
        index_view = append_view(local_indices.tobytes(), target=34963)
        position_accessor = append_accessor(position_view, 5126, "VEC3", positions.shape[0], minimum=positions.min(axis=0).tolist(), maximum=positions.max(axis=0).tolist())
        uv_accessor = append_accessor(uv_view, 5126, "VEC2", uvs.shape[0], minimum=uvs.min(axis=0).tolist(), maximum=uvs.max(axis=0).tolist())
        source_accessor = append_accessor(source_view, 5125, "SCALAR", source_indices.shape[0])
        index_accessor = append_accessor(index_view, 5125, "SCALAR", local_indices.shape[0])
        primitives.append({
            "attributes": {"POSITION": position_accessor, "TEXCOORD_0": uv_accessor},
            "extras": {"componentName": component, "sourceVertexIndicesAccessor": source_accessor},
            "indices": index_accessor,
            "material": component_index,
            "mode": 4,
        })
        component_records.append({
            "name": component,
            "primitiveIndex": component_index,
            "triangleCount": int(selected.size),
            "cornerVertexCount": int(positions.shape[0]),
            "sourceVertexCount": int(np.unique(source_indices).size),
            "uvSource": "triangle_uvs",
            "uvSeams": "preserved-by-corner-split",
        })

    identity = np.ascontiguousarray(data["vertex_identity_basis"], dtype="<f4")
    expression = np.ascontiguousarray(data["expression_basis"], dtype="<f4")
    identity_view = append_view(identity.tobytes())
    expression_view = append_view(expression.tobytes())
    identity_accessor = append_accessor(identity_view, 5126, "VEC3", int(identity.shape[0] * identity.shape[1]))
    expression_accessor = append_accessor(expression_view, 5126, "VEC3", int(expression.shape[0] * expression.shape[1]))

    basis_records = {
        "identity": {
            "array": "vertex_identity_basis",
            "shape": list(identity.shape),
            "count": int(identity.shape[0]),
            "names": [str(value) for value in data["identity_names"].tolist()],
            "bufferView": identity_view,
            "accessor": identity_accessor,
            "dtype": "float32-le",
            "semanticMapping": "unsafe-neutral-only",
        },
        "expression": {
            "array": "expression_basis",
            "shape": list(expression.shape),
            "count": int(expression.shape[0]),
            "names": [str(value) for value in data["expression_names"].tolist()],
            "bufferView": expression_view,
            "accessor": expression_accessor,
            "dtype": "float32-le",
            "semanticMapping": "unsafe-neutral-only",
        },
    }
    official_extras = {
        "schema": "sports-face-gnm-official-head/v1",
        "source": {"repository": SOURCE_REPOSITORY, "revision": SOURCE_REVISION, "npzSha256": NPZ_SHA256},
        "topology": {"templateVertexCount": summary["vertexCount"], "triangleCount": summary["triangleCount"], "quadCount": summary["quadCount"]},
        "components": component_records,
        "uvHandling": "Official triangle_uvs are preserved exactly. Every triangle corner is a separate GLB vertex; no UV seam is collapsed.",
        "basis": basis_records,
        "materials": {"kind": "neutral-procedural", "officialTexturesIncluded": False},
        "mapping": {
            "identity": {"applied": False, "safe": False, "reason": "Official identity_names are neutral head_/eyes_/teeth_ IDs, not FaceDNA semantic variables."},
            "expression": {"applied": False, "safe": False, "reason": "Official expression_names describe regions, not the application's expression modes."},
            "identityOnlyInvariant": True,
        },
    }
    document = {
        "accessors": accessors,
        "asset": {"copyright": "Google GNM Head v3.0 data; converted for the noncommercial Sports Face MVP", "generator": "sports-face-mvp tools/gnm/import_official_gnm_npz.py", "version": "2.0"},
        "buffers": [{"byteLength": sum(len(part) for part in binary_parts)}],
        "bufferViews": buffer_views,
        "extras": {"sportsFaceGnmOfficial": official_extras},
        "materials": materials,
        "meshes": [{"name": "GNM Official Head v3.0", "primitives": primitives}],
        "nodes": [{"mesh": 0, "name": "GNM Official Head v3.0"}],
        "scene": 0,
        "scenes": [{"name": "GNM Official Head Scene", "nodes": [0]}],
    }
    json_data = aligned_json(json.dumps(document, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    binary = b"".join(binary_parts)
    total_length = 12 + 8 + len(json_data) + 8 + len(binary)
    glb = b"".join((
        struct.pack("<4sII", GLB_MAGIC, GLB_VERSION, total_length),
        struct.pack("<II", len(json_data), JSON_CHUNK), json_data,
        struct.pack("<II", len(binary), BIN_CHUNK), binary,
    ))
    return glb, official_extras


def make_metadata(summary: dict[str, object], official_extras: dict[str, object], glb: bytes) -> dict[str, object]:
    return {
        "schema": "sports-face-gnm-official-head/v1",
        "source": {
            "repository": SOURCE_REPOSITORY,
            "revision": SOURCE_REVISION,
            "archiveSha256": SOURCE_ARCHIVE_SHA256,
            "npzPath": str(DEFAULT_INPUT),
            "npzSizeBytes": NPZ_SIZE,
            "npzSha256": NPZ_SHA256,
        },
        "geometry": summary,
        "components": official_extras["components"],
        "uvHandling": official_extras["uvHandling"],
        "basis": official_extras["basis"],
        "materials": official_extras["materials"],
        "mapping": official_extras["mapping"],
        "glb": {"path": "gnm-official-head.glb", "sizeBytes": len(glb), "sha256": hashlib.sha256(glb).hexdigest()},
        "notes": "No complete material texture bundle is included. Runtime uses neutral procedural materials and does not claim official textures.",
    }


def make_manifest(summary: dict[str, object], glb: bytes, metadata: dict[str, object], license_path: Path) -> dict[str, object]:
    glb_digest = hashlib.sha256(glb).hexdigest()
    metadata_digest = hashlib.sha256(json.dumps(metadata, ensure_ascii=True, indent=2).encode("utf-8") + b"\n").hexdigest()
    roles = {role: {"path": "gnm-official-head.json", "sha256": metadata_digest} for role in ("uvs", "materialsTextures", "eyes", "teeth", "tongue")}
    roles["mesh"] = {"path": "gnm-official-head.glb", "sha256": glb_digest, "sizeBytes": len(glb)}
    roles["expressions"] = {"path": "gnm-official-head.json", "sha256": metadata_digest}
    return {
        "schema": "sports-face-gnm-official-bundle/v1",
        "status": "accepted",
        "runtimeAllowed": True,
        "source": {"repositoryUrl": SOURCE_REPOSITORY, "upstreamRevision": SOURCE_REVISION, "archiveSha256": SOURCE_ARCHIVE_SHA256, "archiveFormat": "git archive tar at exact revision"},
        "license": {"name": "Apache License 2.0", "spdxId": "Apache-2.0", "textPath": license_path.name, "textSha256": LICENSE_SHA256},
        "permission": {"decision": "approved", "reviewer": "project-owner", "decisionDate": DECISION_DATE, "decisionReference": DECISION_REFERENCE, "scope": "Public redistribution for this noncommercial MVP only; replace with custom assets when the MVP result is desirable."},
        "geometry": {"expectedVertexCount": summary["vertexCount"], "expectedTriangleCount": summary["triangleCount"], "identityTemplateTopology": {"consistent": True, "identityCount": summary["identityCount"], "templateVertexCount": summary["vertexCount"], "templateTriangleCount": summary["triangleCount"], "identityVertexCount": summary["vertexCount"], "identityTriangleCount": summary["triangleCount"]}},
        "assets": roles,
        "assetPackage": {"metadataPath": "gnm-official-head.json", "glbPath": "gnm-official-head.glb", "components": list(COMPONENTS), "officialTexturesIncluded": False, "runtimeMaterials": "neutral-procedural"},
        "notes": "Accepted official GNM-derived package for the explicitly authorized noncommercial/public MVP scope. No complete material texture bundle is included; runtime uses neutral procedural materials.",
    }


def write_json(path: Path, document: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        data = load_source(args.input)
        summary = validate_source(data)
        require(args.license_input.is_file(), f"upstream license does not exist: {args.license_input}")
        require(digest(args.license_input) == LICENSE_SHA256, "upstream license SHA-256 does not match the reviewed source")
        glb, official_extras = make_glb(data, summary)
        metadata = make_metadata(summary, official_extras, glb)
        manifest = make_manifest(summary, glb, metadata, args.license_output)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(glb)
        write_json(args.metadata, metadata)
        write_json(args.manifest, manifest)
        args.license_output.parent.mkdir(parents=True, exist_ok=True)
        args.license_output.write_bytes(args.license_input.read_bytes())
    except (OSError, ImportErrorClosed, TypeError, ValueError, KeyError, IndexError) as error:
        print(f"FAIL official GNM import: {error}", file=sys.stderr)
        return 2
    print(f"PASS official GNM import: {args.output} ({summary['vertexCount']} source vertices, {summary['triangleCount']} triangles, {len(COMPONENTS)} components, {summary['identityCount']} identity basis, {summary['expressionCount']} expression basis)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
