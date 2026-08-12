# Phase 2 GNM GLB Acceptance

Phase 2 publishes a deterministic, geometry-only binary glTF 2.0 template from
the retained `tools/gnm/work/gnm-heads-200.npz`. It is an offline artifact for
inspection and later integration; it does not implement a WebGL runtime.

## Quick path

Activate the external GNM Python environment that contains NumPy, then run:

```bash
npm run build:gnm-glb
npm run test:gnm-glb
python tools/gnm/validate_gnm_glb.py tools/gnm/work/head.glb
```

The default output is `tools/gnm/work/head.glb`.

## Acceptance contract

- The GLB has valid magic, version 2, declared length, JSON and BIN chunks.
- The asset contains one scene, one node, one mesh, one triangle primitive and a
  neutral material.
- Positions are float32 `VEC3` values with finite `min` and `max` bounds.
- Indices are uint32 scalar values for indexed triangles.
- Buffer views stay within the BIN chunk and all payloads are 4-byte aligned.
- Repeated exports from the same NPZ are byte-identical.

The retained source currently produces `17,821` vertices, `35,324` triangles,
and `105,972` indices. This export contains no UVs, textures, eyes, teeth,
tongue, or morph targets: those data are not present in the retained NPZ and
must be added only from official GNM data in a later slice.

## Scope boundary

This phase does not change runtime or SVG behavior. The browser does not load the
GLB, GNM, or NumPy, and this phase does not implement WebGL rendering.
