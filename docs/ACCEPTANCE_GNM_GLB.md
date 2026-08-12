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

## Phase 3 bounded slice

The first Phase 3 slice is offline target reduction only. It does not load the
target package in a browser, add a WebGL renderer, or alter the default SVG
renderer. The separate package is a geometry-derived PCA prototype, not an
official set of semantic GNM controls. Its neutral labels must remain IDs such
as `gnm-pca-01`; no anatomical names are assigned.

Run the reduction and standard-library validation with NumPy available only to
the builder:

```bash
npm run build:gnm-morph-targets
npm run test:gnm-morph-targets
python tools/gnm/validate_gnm_morph_targets.py tools/gnm/work/gnm-morph-targets.json
```

The package accepts 12 through 20 targets. The canonical artifact contains 16
targets over 17,821 vertices, stored as JSON metadata plus a relocation-safe
little-endian float32 `.bin` payload. Its current PCA metrics are 95.2596%
retained variance, 4.7404% residual variance, residual RMSE `0.0172562`, and
maximum absolute residual `0.147963` in source mesh units.

The NPZ `identities` array is `(200, 253)` parameter data, not mesh data. The
builder therefore uses the verified per-sample `vertices` array `(200, 17,821,
3)` and records this provenance; it fails closed if valid sample meshes are not
available. No GLB morph-target integration is included in this slice.
