#!/usr/bin/env python3
"""Sample neutral GNM Head meshes for offline Sports Face processing.

This script is not used by the game runtime. It follows the public GNM NumPy
API documented by google/GNM. Run it inside an environment where GNM Shape is
installed.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=100)
    parser.add_argument("--seed", type=int, default=400)
    parser.add_argument("--sigma", type=float, default=1.15)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.count < 1:
        raise SystemExit("--count must be positive")
    try:
        import numpy as np
        from gnm.shape import gnm_numpy
    except ImportError as error:
        print(
            "GNM Shape is not installed. Create a Python 3.13 environment, "
            "install google/GNM/gnm/shape, and rerun this offline tool.",
            file=sys.stderr,
        )
        print(f"Import error: {error}", file=sys.stderr)
        return 2

    model = gnm_numpy.GNM.from_local(
        version=gnm_numpy.GNMMajorVersion.V3,
        variant=gnm_numpy.GNMVariant.HEAD,
    )
    rng = np.random.default_rng(args.seed)
    identities = np.clip(
        rng.normal(0.0, args.sigma, size=(args.count, model.identity_dim)),
        -3.0,
        3.0,
    )
    expression = np.zeros(model.expression_dim, dtype=np.float32)
    rotations = np.zeros((model.num_joints, 3), dtype=np.float32)
    translation = np.zeros(3, dtype=np.float32)

    meshes = []
    for coefficients in identities:
        vertices = model(
            identity=coefficients.astype(np.float32),
            expression=expression,
            rotations=rotations,
            translation=translation,
        )
        meshes.append(np.asarray(vertices, dtype=np.float32))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        args.output,
        vertices=np.stack(meshes),
        triangles=np.asarray(model.triangles),
        identities=identities.astype(np.float32),
        template=np.asarray(model.template_vertex_positions, dtype=np.float32),
        metadata=json.dumps(
            {
                "schema": "sports-face-gnm-mesh-samples/v1",
                "gnmVersion": "v3",
                "variant": "head",
                "count": args.count,
                "seed": args.seed,
                "sigma": args.sigma,
                "expression": "neutral-zero-vector",
            }
        ),
    )
    print(f"Wrote {args.count} neutral GNM samples to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
