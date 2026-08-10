#!/usr/bin/env python3
"""Project named GNM mesh vertices to normalized 2D landmark samples.

A reviewed vertex map is intentionally required. The project does not guess
anatomical vertex IDs from a dense mesh, because a silent wrong map would create
invalid morphology data.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Iterable

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--meshes", type=Path, required=True)
    parser.add_argument("--vertex-map", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--horizontal-axis", choices=("x", "y", "z"), default="x")
    parser.add_argument("--vertical-axis", choices=("x", "y", "z"), default="y")
    parser.add_argument("--flip-vertical", action="store_true")
    return parser.parse_args()


def mean_vertex(vertices: np.ndarray, indices: Iterable[int]) -> np.ndarray:
    values = list(indices)
    if not values or any(index < 0 or index >= len(vertices) for index in values):
        raise ValueError(f"Invalid vertex indices: {values}")
    return vertices[values].mean(axis=0)


def project_raw_landmarks(
    vertices: np.ndarray,
    points: dict,
    horizontal_axis: int,
    vertical_axis: int,
    flip_vertical: bool,
) -> dict[str, list[float]]:
    raw = {}
    for name, indices in points.items():
        if isinstance(indices, int):
            indices = [indices]
        xyz = mean_vertex(vertices, indices)
        vertical = -xyz[vertical_axis] if flip_vertical else xyz[vertical_axis]
        raw[name] = [float(xyz[horizontal_axis]), float(vertical)]
    return raw


def normalization_bounds(raw: dict[str, list[float]]) -> dict[str, float]:
    xs = [value[0] for value in raw.values()]
    ys = [value[1] for value in raw.values()]
    return {
        "left": min(xs),
        "right": max(xs),
        "top": min(ys),
        "bottom": max(ys),
    }


def normalize_landmarks(
    raw: dict[str, list[float]],
    bounds: dict[str, float],
    sample_index: int,
) -> dict[str, dict[str, float]]:
    width = bounds["right"] - bounds["left"]
    height = bounds["bottom"] - bounds["top"]
    if width <= 0 or height <= 0:
        raise ValueError(f"Degenerate projection for sample {sample_index}")
    return {
        name: {
            "x": round(160 + ((value[0] - bounds["left"]) / width) * 448, 4),
            "y": round(96 + ((value[1] - bounds["top"]) / height) * 560, 4),
        }
        for name, value in raw.items()
    }


def project_samples(
    vertices_batch: np.ndarray,
    points: dict,
    horizontal_axis: int,
    vertical_axis: int,
    flip_vertical: bool,
    template: np.ndarray | None = None,
) -> tuple[list[dict], dict[str, object]]:
    if len(vertices_batch) == 0:
        raise ValueError("The mesh archive does not contain any samples")

    if template is not None:
        reference_raw = project_raw_landmarks(
            template, points, horizontal_axis, vertical_axis, flip_vertical
        )
        frame_name = "template"
    else:
        reference_raw = project_raw_landmarks(
            vertices_batch[0], points, horizontal_axis, vertical_axis, flip_vertical
        )
        frame_name = "first-sample"
    bounds = normalization_bounds(reference_raw)

    samples = []
    for sample_index, vertices in enumerate(vertices_batch):
        raw = project_raw_landmarks(
            vertices, points, horizontal_axis, vertical_axis, flip_vertical
        )
        samples.append({
            "id": f"gnm-{sample_index + 1:04d}",
            "landmarks": normalize_landmarks(raw, bounds, sample_index),
        })

    metadata = {
        "normalization": {
            "frame": frame_name,
            "bounds": {name: round(value, 8) for name, value in bounds.items()},
        }
    }
    return samples, metadata


def main() -> int:
    args = parse_args()
    archive = np.load(args.meshes, allow_pickle=False)
    vertices_batch = np.asarray(archive["vertices"])
    template = np.asarray(archive["template"]) if "template" in archive.files else None
    mapping = json.loads(args.vertex_map.read_text(encoding="utf-8"))
    points = mapping.get("landmarks", {})
    if not points:
        raise SystemExit("The vertex map does not define landmarks")

    axis = {"x": 0, "y": 1, "z": 2}
    h_axis = axis[args.horizontal_axis]
    v_axis = axis[args.vertical_axis]
    raw_samples, projection_metadata = project_samples(
        vertices_batch,
        points,
        h_axis,
        v_axis,
        args.flip_vertical,
        template,
    )

    document = {
        "schema": "sports-face-landmark-samples/v1",
        "source": {
            "kind": "gnm-head-v3",
            "gnmDerived": True,
            "meshFile": args.meshes.name,
            "vertexMap": args.vertex_map.name,
            "projection": {
                "horizontalAxis": args.horizontal_axis,
                "verticalAxis": args.vertical_axis,
                "flipVertical": args.flip_vertical,
                **projection_metadata,
            },
        },
        "samples": raw_samples,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(raw_samples)} projected landmark samples to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
