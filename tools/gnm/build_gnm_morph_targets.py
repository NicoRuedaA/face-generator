#!/usr/bin/env python3
"""Build a deterministic, offline PCA morph-target package from GNM meshes."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

try:
    import numpy as np
except ModuleNotFoundError as error:  # pragma: no cover - environment dependent
    raise SystemExit("NumPy is required to build GNM morph targets") from error


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INPUT = ROOT / "tools" / "gnm" / "work" / "gnm-heads-200.npz"
DEFAULT_OUTPUT = ROOT / "tools" / "gnm" / "work" / "gnm-morph-targets.json"
SCHEMA = "sports-face-gnm-morph-targets/v1"
MIN_TARGET_COUNT = 12
MAX_TARGET_COUNT = 20


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help=f"source NPZ (default: {DEFAULT_INPUT})")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help=f"metadata JSON (default: {DEFAULT_OUTPUT})")
    parser.add_argument("--target-count", type=int, default=16, help="number of PCA targets (12-20, default: 16)")
    parser.add_argument("--name-prefix", default="gnm-pca-", help="neutral target ID prefix (default: gnm-pca-)")
    parser.add_argument("--glb-output", type=Path, help="reserved for a later compatible GLB integration; not implemented")
    return parser.parse_args(argv)


def fail(message: str) -> None:
    raise ValueError(message)


def finite_float_array(name: str, value: object) -> np.ndarray:
    array = np.asarray(value)
    if array.dtype.kind != "f":
        fail(f"{name} must use a floating-point dtype, got {array.dtype}")
    if not np.isfinite(array).all():
        fail(f"{name} contains non-finite values")
    return array


def mesh_array(value: object, vertex_count: int, name: str) -> np.ndarray | None:
    array = np.asarray(value)
    if array.dtype.kind != "f" or not np.isfinite(array).all():
        return None
    if array.ndim == 3 and array.shape[1:] == (vertex_count, 3):
        return array
    if array.ndim == 2 and array.shape[1] == vertex_count * 3:
        return array.reshape(array.shape[0], vertex_count, 3)
    return None


def load_source(path: Path) -> tuple[np.ndarray, np.ndarray, dict]:
    try:
        archive = np.load(path, allow_pickle=False)
    except (OSError, ValueError) as error:
        raise ValueError(f"could not read NPZ {path}: {error}") from error

    try:
        names = list(archive.files)
        if "template" not in archive:
            fail("NPZ is missing required template; refusing to fabricate a reference")
        template = finite_float_array("template", archive["template"])
        if template.ndim != 2 or template.shape[1] != 3 or template.shape[0] == 0:
            fail(f"template must have shape (vertex_count, 3), got {template.shape}")
        vertex_count = int(template.shape[0])

        # Prefer identities only when it is actually a per-sample mesh array.
        identity_mesh = mesh_array(archive["identities"], vertex_count, "identities") if "identities" in archive else None
        if identity_mesh is not None:
            sample_name = "identities"
            samples = identity_mesh
        else:
            samples = mesh_array(archive["vertices"], vertex_count, "vertices") if "vertices" in archive else None
            sample_name = "vertices"
        if samples is None or samples.ndim != 3 or samples.shape[0] < 2:
            fail(
                "NPZ does not contain valid per-sample mesh data in identities or vertices; "
                "refusing to fabricate morph targets"
            )
        if not np.isfinite(samples).all():
            fail(f"{sample_name} contains non-finite values")
        metadata_text = None
        if "metadata" in archive:
            metadata_value = np.asarray(archive["metadata"])
            if metadata_value.ndim == 0 and metadata_value.dtype.kind in "SU":
                metadata_text = str(metadata_value.item())
        try:
            archive_metadata = json.loads(metadata_text) if metadata_text else None
        except json.JSONDecodeError:
            archive_metadata = {"raw": metadata_text}
        array_inventory = {
            name: {"shape": list(np.asarray(archive[name]).shape), "dtype": str(np.asarray(archive[name]).dtype)}
            for name in names
        }
        provenance = {
            "archive": path.name,
            "archiveSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "archiveMetadata": archive_metadata,
            "arrays": array_inventory,
            "meshArray": sample_name,
            "templateArray": "template",
            "identitiesInterpretation": (
                "per-sample mesh data"
                if identity_mesh is not None
                else "parameter vectors, not mesh data"
            ),
        }
        return template.astype(np.float64), samples.astype(np.float64), provenance
    finally:
        archive.close()


def aligned_float32(value: np.ndarray) -> np.ndarray:
    result = np.ascontiguousarray(value, dtype="<f4")
    if not np.isfinite(result).all():
        fail("computed payload contains non-finite float32 values")
    return result


def build_package(
    template: np.ndarray,
    samples: np.ndarray,
    provenance: dict,
    output: Path,
    target_count: int,
    name_prefix: str,
) -> tuple[dict, bytes]:
    if not MIN_TARGET_COUNT <= target_count <= MAX_TARGET_COUNT:
        fail(f"target-count must be between {MIN_TARGET_COUNT} and {MAX_TARGET_COUNT}")
    if not name_prefix:
        fail("name-prefix must not be empty")
    if samples.shape[1:] != template.shape:
        fail(f"mesh samples must have shape (sample_count, {template.shape[0]}, 3), got {samples.shape}")

    deltas = samples - template[None, :, :]
    mean_delta = deltas.mean(axis=0)
    centered = (deltas - mean_delta).reshape(samples.shape[0], -1)
    left_vectors, singular_values, components = np.linalg.svd(centered, full_matrices=False)
    total_variance = float(np.square(singular_values).sum() / (samples.shape[0] - 1))
    if not np.isfinite(total_variance) or total_variance <= 0:
        fail("identity mesh deltas have no finite variance; refusing to emit useless targets")
    rank_tolerance = np.finfo(np.float64).eps * max(centered.shape) * singular_values[0]
    rank = int(np.count_nonzero(singular_values > rank_tolerance))
    if target_count > rank:
        fail(f"requested {target_count} targets but centered mesh data has numerical rank {rank}")

    # Fix SVD's sign ambiguity by making the first maximum-magnitude coordinate positive.
    oriented_components = components[:target_count].copy()
    oriented_singular_values = singular_values[:target_count].copy()
    for index, component in enumerate(oriented_components):
        pivot = int(np.argmax(np.abs(component)))
        if component[pivot] < 0:
            oriented_components[index] *= -1
            left_vectors[:, index] *= -1

    scale = oriented_singular_values / np.sqrt(samples.shape[0] - 1)
    target_deltas = (oriented_components * scale[:, None]).reshape(target_count, *template.shape)
    weights = left_vectors[:, :target_count] * np.sqrt(samples.shape[0] - 1)
    reconstructed_centered = weights @ oriented_components
    residual = centered - reconstructed_centered
    reconstructed = template[None, :, :] + mean_delta[None, :, :] + reconstructed_centered.reshape(samples.shape)
    residual_rmse = float(np.sqrt(np.mean(np.square(residual))))
    residual_max_abs = float(np.max(np.abs(residual)))
    template_rmse = float(np.sqrt(np.mean(np.square(samples - template[None, :, :]))))
    mean_reference_rmse = float(np.sqrt(np.mean(np.square(samples - (template + mean_delta)[None, :, :]))))
    explained = np.square(oriented_singular_values) / np.square(singular_values).sum()
    retained_variance = float(explained.sum())

    reference_bytes = aligned_float32(template).tobytes(order="C")
    mean_bytes = aligned_float32(mean_delta).tobytes(order="C")
    target_bytes = [aligned_float32(delta).tobytes(order="C") for delta in target_deltas]
    binary_parts = [reference_bytes, mean_bytes, *target_bytes]
    binary = b"".join(binary_parts)
    binary_name = output.with_suffix(".bin").name if output.suffix else f"{output.name}.bin"
    vertex_bytes = template.shape[0] * 3 * 4
    targets = []
    offset = len(reference_bytes) + len(mean_bytes)
    for index, (delta_bytes, variance) in enumerate(zip(target_bytes, explained)):
        coefficient_range = weights[:, index]
        target_id = f"{name_prefix}{index + 1:02d}"
        targets.append(
            {
                "id": target_id,
                "label": target_id,
                "index": index,
                "weightRange": [float(coefficient_range.min()), float(coefficient_range.max())],
                "explainedVariance": float(variance),
                "delta": {
                    "byteOffset": offset,
                    "byteLength": len(delta_bytes),
                    "dtype": "float32",
                    "shape": [int(template.shape[0]), 3],
                },
            }
        )
        offset += len(delta_bytes)

    document = {
        "schema": SCHEMA,
        "version": "offline-prototype-v1",
        "vertexCount": int(template.shape[0]),
        "sampleCount": int(samples.shape[0]),
        "targetCount": target_count,
        "reference": {
            "kind": "template",
            "array": "template",
            "deltaBase": "template + meanDelta",
            "meanDelta": {
                "byteOffset": len(reference_bytes),
                "byteLength": len(mean_bytes),
                "dtype": "float32",
                "shape": [int(template.shape[0]), 3],
            },
            "template": {
                "byteOffset": 0,
                "byteLength": len(reference_bytes),
                "dtype": "float32",
                "shape": [int(template.shape[0]), 3],
            },
        },
        "binary": {
            "path": binary_name,
            "byteOrder": "little-endian",
            "dtype": "float32",
            "layout": "template, meanDelta, target deltas in target index order",
            "byteLength": len(binary),
            "sha256": hashlib.sha256(binary).hexdigest(),
        },
        "method": {
            "algorithm": "centered-pca-svd",
            "input": "per-sample mesh deltas relative to template",
            "centering": "subtract mean mesh delta before SVD",
            "targetScale": "one standard deviation per principal component",
            "weightFormula": "U[:,i] * sqrt(sampleCount - 1)",
            "signConvention": "first maximum-magnitude component coordinate is positive",
        },
        "metrics": {
            "templateRmse": template_rmse,
            "meanReferenceRmse": mean_reference_rmse,
            "residualRmse": residual_rmse,
            "residualMaxAbs": residual_max_abs,
            "retainedVariance": retained_variance,
            "residualVariance": float(1.0 - retained_variance),
            "numericalRank": rank,
        },
        "source": provenance,
        "targets": targets,
    }
    return document, binary


def write_package(document: dict, binary: bytes, output: Path) -> None:
    binary_name = document["binary"]["path"]
    binary_path = output.parent / binary_name
    output.parent.mkdir(parents=True, exist_ok=True)
    binary_path.write_bytes(binary)
    output.write_text(json.dumps(document, ensure_ascii=True, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.glb_output is not None:
        print("error: --glb-output is reserved for a later GLB integration", file=sys.stderr)
        return 2
    try:
        template, samples, provenance = load_source(args.input)
        document, binary = build_package(template, samples, provenance, args.output, args.target_count, args.name_prefix)
        write_package(document, binary, args.output)
    except (OSError, ValueError, TypeError, np.linalg.LinAlgError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(
        f"Wrote {args.output} and {args.output.parent / document['binary']['path']}: "
        f"{document['vertexCount']} vertices, {document['targetCount']} targets, "
        f"retained variance {document['metrics']['retainedVariance']:.8f}, "
        f"residual RMSE {document['metrics']['residualRmse']:.8g}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
