#!/usr/bin/env python3
"""Fail-closed validator for an external official GNM asset intake manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import sys
from urllib.parse import urlparse
import zipfile


SCHEMA = "sports-face-gnm-official-bundle/v1"
STATUSES = {"proposed", "reviewed", "accepted"}
REQUIRED_ROLES = ("mesh", "uvs", "materialsTextures", "eyes", "teeth", "tongue")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
REVISION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/+@-]{2,127}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_ASSET_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
PLACEHOLDERS = {
    "",
    "TBD",
    "TODO",
    "UNASSIGNED",
    "UNRECORDED",
    "UNSET",
    "REPLACE_WITH_LICENSE_TEXT.txt",
}


class ValidationError(ValueError):
    pass


def fail(message: str) -> None:
    raise ValidationError(message)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def string(value: object, field: str, *, allow_placeholder: bool = False) -> str:
    require(isinstance(value, str), f"{field} must be a string")
    require(value == value.strip() and "\x00" not in value, f"{field} has invalid whitespace or NUL")
    if not allow_placeholder:
        require(value not in PLACEHOLDERS, f"{field} must not be a placeholder")
    return value


def sha256(value: object, field: str) -> str:
    value = string(value, field, allow_placeholder=True)
    require(SHA256_RE.fullmatch(value) is not None, f"{field} must be a lowercase SHA-256 digest")
    return value


def validate_url(value: object, field: str) -> None:
    value = string(value, field)
    parsed = urlparse(value)
    require(parsed.scheme in {"http", "https"} and parsed.hostname, f"{field} must be an HTTP(S) URL")
    require(parsed.username is None and parsed.password is None, f"{field} must not contain embedded credentials")


def validate_path(value: object, field: str) -> str:
    value = string(value, field, allow_placeholder=True)
    path = Path(value)
    require(value and not path.is_absolute(), f"{field} must be a relative path")
    require(not re.match(r"^[A-Za-z]:", value) and not value.startswith(("/", "\\")), f"{field} must be a relative path")
    require("\\" not in value, f"{field} must use forward-slash separators")
    require("://" not in value and "@" not in value, f"{field} must not contain a URL or embedded credentials")
    require(".." not in path.parts, f"{field} must not contain path traversal")
    return value


def validate_nonnegative_integer(value: object, field: str) -> int:
    require(isinstance(value, int) and not isinstance(value, bool) and value >= 0, f"{field} must be a non-negative integer")
    return value


def validate_positive_integer(value: object, field: str) -> int:
    value = validate_nonnegative_integer(value, field)
    require(value > 0, f"{field} must be greater than zero")
    return value


def validate_json_structure(path: Path, role: str, expected_vertices: int, expected_triangles: int) -> None:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"{role} JSON is invalid: {error}")
    require(isinstance(document, dict), f"{role} JSON must contain an object")
    require(document.get("role") == role, f"{role} JSON role does not match manifest role")
    if role == "mesh":
        require(document.get("vertexCount") == expected_vertices, "mesh vertex count does not match geometry")
        require(document.get("triangleCount") == expected_triangles, "mesh triangle count does not match geometry")
        require(document.get("topologyConsistent") is True, "mesh topology must be marked consistent")
    elif role == "uvs":
        require(document.get("vertexCount") == expected_vertices, "UV vertex count does not match geometry")
    elif role == "materialsTextures":
        require(isinstance(document.get("materials"), list) and document["materials"], "materialsTextures must contain materials")
        require(isinstance(document.get("textures"), list) and document["textures"], "materialsTextures must contain textures")
    else:
        require(document.get("present") is True, f"{role} JSON must explicitly mark the role present")


def validate_glb_structure(path: Path, expected_vertices: int, expected_triangles: int) -> None:
    data = path.read_bytes()
    require(len(data) >= 20, "mesh GLB is shorter than its header")
    magic, version, length = struct.unpack_from("<4sII", data)
    require(magic == b"glTF" and version == 2 and length == len(data), "mesh GLB header is invalid")
    chunk_length, chunk_type = struct.unpack_from("<II", data, 12)
    require(chunk_type == 0x4E4F534A and 20 + chunk_length <= len(data), "mesh GLB JSON chunk is invalid")
    try:
        document = json.loads(data[20:20 + chunk_length].rstrip(b" \t\r\n\x00").decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        fail(f"mesh GLB JSON is invalid: {error}")
    require(document.get("asset", {}).get("version") == "2.0", "mesh GLB must be glTF 2.0")
    accessors = document.get("accessors")
    require(isinstance(accessors, list) and len(accessors) >= 2, "mesh GLB must expose position and index accessors")
    require(accessors[0].get("count") == expected_vertices, "mesh GLB vertex count does not match geometry")
    require(accessors[1].get("count") == expected_triangles * 3, "mesh GLB index count does not match geometry")


def read_npy_shape(payload: bytes) -> tuple[int, ...]:
    require(payload[:6] == b"\x93NUMPY", "NPZ member is not an NPY array")
    major, minor = payload[6], payload[7]
    header_size_bytes = 2 if major == 1 else 4 if major in (2, 3) else 0
    require(header_size_bytes, "unsupported NPY version")
    header_start = 8 + header_size_bytes
    header_size = int.from_bytes(payload[8:header_start], "little")
    header = payload[header_start:header_start + header_size].decode("latin1")
    match = re.search(r"'shape'\s*:\s*\(([^)]*)\)", header)
    require(match is not None, "NPY header has no shape")
    dimensions = tuple(int(item.strip()) for item in match.group(1).split(",") if item.strip())
    require(dimensions, "NPY shape is empty")
    return dimensions


def validate_npz_structure(path: Path, expected_vertices: int, expected_triangles: int) -> None:
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            require("template.npy" in names or "vertices.npy" in names, "mesh NPZ must contain template.npy or vertices.npy")
            require("triangles.npy" in names, "mesh NPZ must contain triangles.npy")
            vertex_name = "template.npy" if "template.npy" in names else "vertices.npy"
            vertex_shape = read_npy_shape(archive.read(vertex_name))
            triangle_shape = read_npy_shape(archive.read("triangles.npy"))
    except (OSError, zipfile.BadZipFile, KeyError, UnicodeError, ValueError) as error:
        fail(f"mesh NPZ is invalid: {error}")
    require(vertex_shape[-2:] == (expected_vertices, 3) or vertex_shape[-2:] == (expected_vertices,), "mesh NPZ vertex shape does not match geometry")
    require(triangle_shape[-2:] == (expected_triangles, 3), "mesh NPZ triangle shape does not match geometry")


def validate_asset_structure(path: Path, role: str, expected_vertices: int, expected_triangles: int) -> None:
    suffix = path.suffix.lower()
    if role == "mesh" and suffix == ".glb":
        validate_glb_structure(path, expected_vertices, expected_triangles)
    elif role == "mesh" and suffix == ".npz":
        validate_npz_structure(path, expected_vertices, expected_triangles)
    elif suffix == ".json":
        validate_json_structure(path, role, expected_vertices, expected_triangles)


def validate_referenced_file(path: Path, descriptor: dict, field: str, *, structural_role: str | None = None, expected_vertices: int = 0, expected_triangles: int = 0) -> int:
    asset_path = validate_path(descriptor.get("path"), f"{field}.path")
    digest = sha256(descriptor.get("sha256"), f"{field}.sha256")
    resolved = (path.parent / asset_path).resolve()
    try:
        resolved.relative_to(path.parent.resolve())
    except ValueError:
        fail(f"{field}.path resolves outside the manifest directory")
    require(resolved.is_file(), f"{field}.path does not reference a file")
    size = resolved.stat().st_size
    require(size <= MAX_ASSET_BYTES, f"{field} exceeds the per-asset size limit")
    declared_size = descriptor.get("sizeBytes")
    if declared_size is not None:
        require(declared_size == size, f"{field}.sizeBytes does not match the file")
    actual_digest = hashlib.sha256(resolved.read_bytes()).hexdigest()
    require(actual_digest == digest, f"{field}.sha256 does not match the file")
    if structural_role:
        validate_asset_structure(resolved, structural_role, expected_vertices, expected_triangles)
    return size


def validate_permission(permission: object, *, accepted: bool) -> bool:
    require(isinstance(permission, dict), "permission must be an object")
    decision = string(permission.get("decision"), "permission.decision", allow_placeholder=True).lower()
    require(decision in {"pending", "approved", "denied"}, "permission.decision must be pending, approved, or denied")
    reviewer = string(permission.get("reviewer"), "permission.reviewer", allow_placeholder=True)
    decision_date = string(permission.get("decisionDate"), "permission.decisionDate", allow_placeholder=True)
    reference = string(permission.get("decisionReference"), "permission.decisionReference", allow_placeholder=True)
    explicit = decision == "approved" and reviewer not in PLACEHOLDERS and DATE_RE.fullmatch(decision_date) is not None and reference not in PLACEHOLDERS
    if accepted:
        require(explicit, "accepted manifest requires an explicit approved permission record")
    return explicit


def validate(manifest_path: Path) -> None:
    require(manifest_path.is_file(), "manifest path does not reference a file")
    require(manifest_path.stat().st_size <= MAX_MANIFEST_BYTES, "manifest exceeds the size limit")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"manifest JSON is invalid: {error}")
    require(isinstance(manifest, dict), "manifest must contain an object")
    require(manifest.get("schema") == SCHEMA, f"manifest schema must be {SCHEMA}")
    status = string(manifest.get("status"), "status")
    require(status in STATUSES, f"status must be one of {sorted(STATUSES)}")
    runtime_allowed = manifest.get("runtimeAllowed")
    require(isinstance(runtime_allowed, bool), "runtimeAllowed must be boolean")

    source = manifest.get("source")
    require(isinstance(source, dict), "source must be an object")
    validate_url(source.get("repositoryUrl"), "source.repositoryUrl")
    revision = string(source.get("upstreamRevision"), "source.upstreamRevision", allow_placeholder=status == "proposed")
    require(status == "proposed" or revision not in PLACEHOLDERS, "accepted/reviewed source revision must be recorded")
    require(REVISION_RE.fullmatch(revision) is not None or status == "proposed", "source.upstreamRevision has invalid format")
    archive_digest = sha256(source.get("archiveSha256"), "source.archiveSha256")
    require(status == "proposed" or archive_digest != "0" * 64, "source archive hash must be recorded")

    license_record = manifest.get("license")
    require(isinstance(license_record, dict), "license must be an object")
    string(license_record.get("name"), "license.name", allow_placeholder=status == "proposed")
    string(license_record.get("spdxId"), "license.spdxId", allow_placeholder=status == "proposed")
    validate_path(license_record.get("textPath"), "license.textPath")
    license_digest = sha256(license_record.get("textSha256"), "license.textSha256")
    require(status == "proposed" or license_digest != "0" * 64, "license text hash must be recorded")

    permission_explicit = validate_permission(manifest.get("permission"), accepted=status == "accepted")
    if runtime_allowed:
        require(status == "accepted", "runtimeAllowed can only be true for an accepted manifest")
        require(permission_explicit, "runtimeAllowed requires an explicit approved permission record")

    geometry = manifest.get("geometry")
    require(isinstance(geometry, dict), "geometry must be an object")
    expected_vertices = validate_nonnegative_integer(geometry.get("expectedVertexCount"), "geometry.expectedVertexCount")
    expected_triangles = validate_nonnegative_integer(geometry.get("expectedTriangleCount"), "geometry.expectedTriangleCount")
    topology = geometry.get("identityTemplateTopology")
    require(isinstance(topology, dict), "geometry.identityTemplateTopology must be an object")
    consistent = topology.get("consistent")
    require(isinstance(consistent, bool), "geometry.identityTemplateTopology.consistent must be boolean")
    identity_count = validate_nonnegative_integer(topology.get("identityCount"), "geometry.identityTemplateTopology.identityCount")
    template_vertices = validate_nonnegative_integer(topology.get("templateVertexCount"), "geometry.identityTemplateTopology.templateVertexCount")
    template_triangles = validate_nonnegative_integer(topology.get("templateTriangleCount"), "geometry.identityTemplateTopology.templateTriangleCount")
    identity_vertices = validate_nonnegative_integer(topology.get("identityVertexCount"), "geometry.identityTemplateTopology.identityVertexCount")
    identity_triangles = validate_nonnegative_integer(topology.get("identityTriangleCount"), "geometry.identityTemplateTopology.identityTriangleCount")
    if status == "accepted":
        require(expected_vertices > 0 and expected_triangles > 0 and identity_count > 0, "accepted geometry counts must be positive")
        require(consistent, "accepted identity/template topology must be consistent")
        require((template_vertices, template_triangles, identity_vertices, identity_triangles) == (expected_vertices, expected_triangles, expected_vertices, expected_triangles), "identity/template topology counts do not match expected geometry")

    assets = manifest.get("assets")
    require(isinstance(assets, dict), "assets must be an object")
    for role in REQUIRED_ROLES:
        descriptor = assets.get(role)
        require(isinstance(descriptor, dict), f"assets.{role} is required")
        validate_path(descriptor.get("path"), f"assets.{role}.path")
        sha256(descriptor.get("sha256"), f"assets.{role}.sha256")
    expressions = assets.get("expressions")
    if expressions is not None:
        require(isinstance(expressions, dict), "assets.expressions must be an object when present")
        validate_path(expressions.get("path"), "assets.expressions.path")
        sha256(expressions.get("sha256"), "assets.expressions.sha256")

    if status != "proposed":
        total_size = 0
        total_size += validate_referenced_file(
            manifest_path,
            {"path": license_record["textPath"], "sha256": license_record["textSha256"]},
            "license.text",
            structural_role=None,
        )
        for role in REQUIRED_ROLES:
            total_size += validate_referenced_file(manifest_path, assets[role], f"assets.{role}", structural_role=role, expected_vertices=expected_vertices, expected_triangles=expected_triangles)
        if expressions is not None:
            total_size += validate_referenced_file(manifest_path, expressions, "assets.expressions", structural_role="expressions", expected_vertices=expected_vertices, expected_triangles=expected_triangles)
        require(total_size <= MAX_TOTAL_BYTES, "referenced files exceed the total size limit")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args(argv)
    try:
        validate(args.manifest)
    except (OSError, ValidationError, KeyError, TypeError, IndexError, struct.error) as error:
        print(f"FAIL {args.manifest}: {error}", file=sys.stderr)
        return 1
    print(f"PASS {args.manifest}: {SCHEMA}, fail-closed provenance/permission/geometry intake gate")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
