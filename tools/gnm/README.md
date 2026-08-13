# GNM offline pipeline

GNM itself is never loaded by the browser or game runtime. A generated portable
morphology pack may be embedded in the offline bundle and selected explicitly
as `sports/morph-gnm-v1`; the analytic `sports/morph-v1` remains the default.
Only the portable JSON pack crosses the browser boundary.

## Official GNM 3D asset package

The first official package is accepted for the project-owner-authorized public,
noncommercial MVP scope. It is generated from the exact GNM revision recorded in
`tools/gnm/work/official-bundle.json`; the external checkout is never copied
wholesale.

```bash
npm run validate:gnm-official-example
npm run test:gnm-official-bundle
/home/nico/src/GNM/gnm/shape/.venv/bin/python tools/gnm/import_official_gnm_npz.py
python3 tools/gnm/validate_official_gnm_asset.py tools/gnm/work/official-bundle.json
npm run validate:gnm-official-render
npm run test:gnm-official-render
npm run capture:gnm-official-smoke
```

For a real external candidate, create a manifest outside release/runtime asset
paths and validate it with the exact command below:

```bash
python3 tools/gnm/validate_official_bundle.py /path/to/official-bundle.json
```

The importer reads only the official NPZ with NumPy offline and emits
`tools/gnm/work/gnm-official-head.glb`, `gnm-official-head.json`, an accepted
manifest, and a copied Apache-2.0 license text. The GLB has six component
primitives and six neutral procedural materials. Triangle UVs are preserved
exactly by splitting every triangle corner into its own vertex; the importer
fails closed on ambiguous topology, component membership, or UV correspondence.
The package retains 253 identity and 383 expression basis directions, but maps
neither to FaceDNA nor application expression modes because the source names do
not safely establish those semantics. Identity-only invariance remains explicit.
No complete official material texture bundle is included. See
[`docs/ACCEPTANCE_GNM_OFFICIAL_BUNDLE.md`](../../docs/ACCEPTANCE_GNM_OFFICIAL_BUNDLE.md).

The runtime uses the separate render-only optimization, generated without GNM or
NumPy:

```bash
npm run build:gnm-official-render
npm run validate:gnm-official-render
npm run test:gnm-official-render
```

It reduces the canonical `138,998,408` byte GLB to `665,904` bytes (`99.52%`
smaller) and `18,437` unique render vertices while preserving every decoded
triangle POSITION/UV byte exactly. Deduplication uses deterministic first
occurrence `(POSITION, TEXCOORD_0)` pairs and remaps to uint16 indices; no
quantization or lossy conversion is permitted. The six component/material
contract and camera/render contract remain unchanged. The render asset is
`renderOnly: true`, `basisIncluded: false`; identity/expression bases remain
offline/optional and semantic mapping remains disabled. The canonical GLB and
full canonical validator still remain the archival package.

### Conservative official basis diagnostic

The canonical basis payload has a standard-library-only diagnostic/scrubber. It
reads `gnm-official-head.glb` and `gnm-official-head.json`, never writes either
asset, and emits the deterministic report
`tools/gnm/work/gnm-official-basis-diagnostic.json`:

```bash
npm run diagnose:gnm-official-basis
npm run test:gnm-official-basis
```

It validates the official v2 schema, exact identity/expression dimensions and
ordered names, finite little-endian float32 payloads, zero/one-hot float32
reconstruction, aggregate displacement bounds, and byte-exact POSITION to
`sourceVertexId` correspondence across all six primitives. The six source sets
are disjoint and exhaustive. It also compares the optimized render mapping when
the render asset is present. The report has no absolute paths and records
`semanticMapping: disabled` and `runtimeBasisLoaded: false`.

This phase is evidence only. It does not load basis arrays in the browser or
runtime, project them to FaceDNA/morphology, or alter the canonical GLB, the
render-only GLB (`basisIncluded: false`), or its runtime URL.

### Phase 4: opt-in technical Basis Lab

The separate `sports/morph-webgl-official-basis-lab-v1` style loads
`gnm-official-basis-lab.bin` and its JSON metadata. The stdlib-only builder
selects the first four identity directions (`head_000` through `head_003`) and
the first four expression directions (`left_eye_region_000` through
`left_eye_region_003`), then gathers exact float32 values by optimized render
`sourceVertexId`. The payload is exactly `1,843,736` bytes under the strict
global 3 MiB budget. Coefficients are technical only and bounded to
`[-0.25, 0.25]`; no FaceDNA/SF2 mutation or GLB modification occurs.

```bash
npm run build:gnm-official-basis-lab
npm run validate:gnm-official-basis-lab
npm run test:gnm-official-basis-lab
```

Phase 2 also exports the retained neutral template mesh to a standards-compliant
binary glTF 2.0 file for offline inspection. The later WebGL2 slice is opt-in;
SVG remains the default and GNM itself is never loaded by runtime.

## Quick path: regenerate a candidate

Install GNM Shape separately from the official `google/GNM` repository, create
its documented Python 3.13 environment, and activate that environment before
running any command in this section. The orchestrator uses the active
interpreter as `sys.executable` for every stage.

```bash
source /path/to/gnm/shape/.venv/bin/activate
python tools/gnm/build_runtime_pack.py \
  --count 200 --seed 400 --sigma 1.15 --families 8
```

The default output is the provisional candidate
`tools/gnm/work/gnm-morphology-pack-200.json`. It also writes the sampled mesh
and projected landmarks beside it. The canonical runtime pack
`tools/gnm/work/gnm-morphology-pack.json` is not replaced.

Review the provisional landmark map and generated data before promotion. The
map must be inspected against a frontal mesh; it is not guessed automatically.

After the map and candidate pass review, run the same command with the explicit
promotion flag:

```bash
python tools/gnm/build_runtime_pack.py \
  --count 200 --seed 400 --sigma 1.15 --families 8 --promote
```

Promotion is never implicit. After promotion, rebuild and verify the artifacts
with these exact commands:

```bash
npm run build:offline
npm test
npm run refresh:release
python3 -m json.tool docs/release-manifest-v040.json >/dev/null
npm run test:gnm-quality
```

The Phase 1 landmark audit is also standard-library-first. It always validates
the JSON map, projected samples, bilateral orientation, fixed-frame bounds,
retained-artifact consistency and report-only provenance evidence. The report
includes the excursion count, percentage, worst sample/landmark/axis/value/
distance, and source filename paths. A source filename mismatch is WARN when
retained landmarks are byte-identical; it is not silently treated as a failure.
If `gnm-heads-200.npz` exists, it additionally uses NumPy to compare map
coordinates with the template, inspect raw-mesh bilateral orientation, and
report raw XYZ extrema. Without NumPy it emits a bounded WARN and no fabricated
extrema:

```bash
npm run test:gnm-landmarks
```

The command exits successfully for the documented provisional `PASS with WARN`
baseline. It exits nonzero for duplicate or out-of-range IDs, bilateral
inversions, count mismatches, or retained-artifact integrity failures.
Every report carries `provisionalReview: "required"` and
`anatomicalCorrectness: "not_proven"`. This quality-gate slice improves evidence
only; it does not correct landmark IDs or prove anatomy.

## Phase 2: export the retained template

Use the external GNM environment with NumPy active. The exporter reads only the
retained NPZ arrays `template` and `triangles`; the validator and tests use only
the Python standard library:

```bash
npm run build:gnm-glb
npm run test:gnm-glb
python tools/gnm/validate_gnm_glb.py tools/gnm/work/head.glb
```

The current output has 17,821 vertices, 35,324 triangles and 105,972 uint32
indices. The retained NPZ has no UVs, textures, eyes, teeth, tongue or morph
targets. Those elements are intentionally absent and must come only from
official GNM data in a later slice. See
[`docs/ACCEPTANCE_GNM_GLB.md`](../../docs/ACCEPTANCE_GNM_GLB.md).

## Phase 3: offline PCA morph-target reduction

This bounded Phase 3 slice creates an auditable offline package from the 200
retained neutral identity meshes. It is geometry-derived prototype data, not
official semantic GNM controls. The SVG renderer remains the default.

The builder inspects the NPZ before choosing source data. In the retained
archive, `identities` has shape `(200, 253)` and contains parameter vectors, so
the builder uses `vertices` with shape `(200, 17,821, 3)` as the per-sample mesh
array. If valid mesh data are unavailable, it fails closed rather than
fabricating targets.

```bash
npm run build:gnm-morph-targets
npm run test:gnm-morph-targets
python tools/gnm/validate_gnm_morph_targets.py tools/gnm/work/gnm-morph-targets.json
```

The accepted target-count range is 12-20; the canonical package uses 16 neutral
IDs `gnm-pca-01` through `gnm-pca-16`. JSON metadata references a separate
relocation-safe `gnm-morph-targets.bin` payload containing the template,
mean-delta reference, and target deltas as little-endian float32 values with
exact byte offsets and lengths. The PCA records explained variance per target,
weight ranges, retained variance and residual/error metrics. The current
package retains 95.2596% variance with residual RMSE `0.0172562` and maximum
absolute residual `0.147963`.

`npm run build:offline` is the only step that embeds the portable JSON into
`src/app.bundle.js` and writes `tools/gnm/work/gnm-morphology-pack.js`.
`npm run refresh:release` updates SHA-256 entries for the release's operational
files. Neither command installs or imports GNM in the browser/runtime.

## Phase 3: GLB morph integration and WebGL2 prototype

Build and validate the portable browser asset with NumPy available to the
offline exporter only:

```bash
npm run build:gnm-glb-morph
npm run test:gnm-glb-morph
python tools/gnm/validate_gnm_glb.py tools/gnm/work/head-morph.glb
```

The exporter validates adjacent metadata and `.bin` hash, exact byte ranges,
finite float32 payloads, vertex count, target ranges, and neutral target order.
The GLB base is `template + meanDelta`; target buffers are additive deltas. The
runtime style `sports/morph-webgl-v1` uses one position attribute and a 16-layer
`RGBA32F` texture rather than requiring 17 vertex attributes. It maps only the
permanent identity values `head`, `skin`, `eyes`, `brows`, `nose`, `mouth`,
`freckles`, `eyeColor`, `earShape`, `jaw`, and `faceProportion` to bounded neutral
PCA weights. Its decorrelation hash is derived from `identityBits` only, so
appearance, age, presentation, kit, expression, and seed changes with identical
identity bits cannot change geometry. PCA components remain geometry-derived and
are not anatomical or semantic controls. Missing WebGL2 or asset/resource errors fall
back to the existing GNM SVG renderer. The GLB is geometry-derived, GNM itself is
not runtime data, and this remains a prototype with the existing provenance and
licensing caveats.

## Phase 3: bounded SVG/WebGL2 A/B evidence

The committed comparison uses the same eight fixed FaceDNA seeds, age `22`, and
neutral presentation in `sports/morph-gnm-v1` (SVG reference) and
`sports/morph-webgl-v1` (opt-in WebGL2 geometry-only candidate). It is qualitative
diagnostic evidence, not pixel equivalence: the renderers have different
projection and shading. The capture uses Playwright through the shared
`with_server.py` workflow and writes stable `svg-*`, `webgl-*`, `comparison.html`,
and `comparison.json` files.

```bash
npm run capture:gnm-webgl-ab
npm run validate:gnm-webgl-ab
```

The canonical evidence is in `docs/gnm-webgl-ab/`. Missing WebGL2 is a bounded
`fallback` or `unavailable` result and is never reported as a fabricated pass.
The prototype remains geometry-only: it has no UVs, textures, eyes, teeth,
tongue, or animation. The neutral PCA IDs are not semantic controls.

When the opt-in WebGL2 style is selected in the UI, the canvas additionally
offers bounded inspection-only controls: pointer drag orbit, wheel zoom, and an
accessible camera reset. The default front view remains deterministic, and
camera gestures redraw existing GPU resources without refetching or reuploading
the GLB. These controls do not add textures, official assets, FaceDNA, or SF2
state.

The capture records canvas dimensions, a proportional non-background occupancy
and bounding box, plus a WebGL2 `readPixels` probe when the candidate really
renders. The stdlib PNG fallback accepts only 8-bit RGB/RGBA, non-interlaced PNGs
and uses the dominant RGB color plus a fixed 24-level tolerance; these fields are
diagnostics for draw health and framing, not semantic or anatomical checks.
The renderer uses base bounds expanded by a conservative sum of per-target
coordinate displacement bounds, depth testing, and two-sided drawing because
the retained mesh has mixed winding. It remains an opt-in prototype, not a
production renderer.

The standard-library-only canonical quality gate is also available directly:

```bash
npm run test:gnm-quality
```

Use `--dry-run` to inspect the four planned subprocess commands without GNM,
NumPy, or file changes:

```bash
python tools/gnm/build_runtime_pack.py --dry-run
```

## Bounded scale comparison

The canonical acceptance gate remains the 200-sample `test_gnm_quality.py` gate.
Scale comparison is report-only and never calls `--promote`, changes runtime,
FaceDNA, SF2, GLB, SVG, PCA, or canonical pack assets.

```bash
npm run test:gnm-quality-scales
npm run compare:gnm-quality-scales
npm run plan:gnm-quality-scales:400
npm run compare:gnm-quality-scales:400
```

`compare_gnm_quality_scales.py` is stdlib-first. It accepts separate candidate
and canonical pack/landmark paths and emits JSON with sample/member counts,
exact feature-vector duplicates, normalized nearest-neighbor minimum/median and
percentiles, per-feature range/variance, family counts and balance, common-family
centroid deltas, source/seed/sigma provenance, and deterministic rerun byte
identity. The defaults are documented diagnostic thresholds, not a replacement
for the canonical gate: duplicate vectors `0`, nearest minimum `0.20`, family
balance ratio `0.50`, and common-family centroid delta `0.10`. Use `--strict`
only when a warning should fail the command.

`run_gnm_scale_comparison.py` uses the documented external GNM Python from
`GNM_PYTHON` or `/home/nico/src/GNM/gnm/shape/.venv/bin/python`, and samples
400 heads by default. It runs two isolated deterministic candidates, compares
them with the canonical 200 pack, and deletes temporary mesh/candidate files
after writing the report. If GNM or NumPy cannot be imported, it writes a
bounded `unavailable` report with no invented metrics. The current committed
400-sample evidence is [`docs/gnm-quality-scale-comparison.json`](../../docs/gnm-quality-scale-comparison.json)
and is `warn`; it is scale evidence only, not anatomy proof or promotion.

The intended pipeline is:

```text
GNM Head neutral meshes
  → reviewed vertex map
  → frontal 2D landmark samples
  → deterministic clustering
  → portable morphology pack JSON
  → Sports Morph Lab renderer
```

## 1. Install GNM separately

GNM Shape currently documents Python 3.13 and exposes NumPy, JAX, PyTorch and
TensorFlow backends. Its model separates identity, expression and pose. Install
it from the official `google/GNM` repository in a dedicated environment.
The browser project does not install GNM as an npm or Python runtime
dependency. Keep the GNM checkout and its environment outside this project.

## 2. Sample neutral identities

```bash
python sample_gnm_heads.py --count 200 --seed 400 --output work/gnm-heads.npz
```

## 3. Review a vertex map

Copy `gnm-vertex-map.example.json`, replace every `-1`, and verify the selected
vertices visually. The tool deliberately refuses to guess anatomical indices.

## 4. Project landmarks

```bash
python project_gnm_landmarks.py \
  --meshes work/gnm-heads.npz \
  --vertex-map work/gnm-vertex-map.json \
  --horizontal-axis x --vertical-axis y --flip-vertical \
  --output work/gnm-landmarks.json
```

The correct axis choices must be verified against an exported frontal mesh.

The projector must use one normalization frame for the complete sample set. A
per-sample bounding box is forbidden: when each sample's own left, right, top
and bottom are mapped to the same output rectangle, absolute face height and
ear span become constants by construction. This destroys the morphology
variation that the GNM identities provide. When the mesh archive contains
`template`, the mapped template landmarks define the stable frame. Every sample
is normalized against those same bounds, so differences in face height and ear
span survive into the generated features. Archives without a template use the
first sample as a deterministic fallback. The selected frame and bounds are
recorded under `source.projection.normalization`.

The generated pack exposes fourteen deterministic features. The four added
landmark-derived metrics are calculated from the projected coordinates:

- `chinWidth = distance(chinLeft, chinRight) / faceHeight`;
- `eyeWidth = mean(distance(leftOuter, leftInner), distance(rightOuter, rightInner)) / faceHeight`;
- `eyeHeight = mean(distance(leftTop, leftBottom), distance(rightTop, rightBottom)) / faceHeight`;
- `templeSlope = mean(atan2(abs(dy), abs(dx)) for temple-to-hairline segments on both sides)`.

The temple slope is an unsigned angle in radians: `0` means a horizontal
segment and `pi / 2` means a vertical segment. `atan2` keeps each segment in
the bounded `[0, pi / 2]` range, and averaging both sides makes the result
bilateral and independent of which side is called left or right. The new map
IDs are provisional frontal/depth surface anchors, not semantic mesh labels.

## 5. Build the pack manually

```bash
python build_morphology_pack.py \
  --input work/gnm-landmarks.json \
  --families 8 --seed 400 \
  --output work/gnm-morphology-pack.json
python validate_morphology_pack.py work/gnm-morphology-pack.json
```

The orchestrator above is the preferred path because it runs these four stages
in order with one interpreter and a deterministic set of paths. The individual
commands remain useful for diagnosis.

## Current bundled data

`starter-landmark-samples.json` and the runtime family definitions are analytic
fixtures. They exercise the complete data contract but are not claimed as GNM
derivatives. The canonical generated artifacts are the 200-sample
`work/gnm-landmarks.json` projection from `gnm-heads-200.npz` and its matching
`work/gnm-morphology-pack.json`. The retained `work/gnm-landmarks-200.json` and
`work/gnm-morphology-pack-200.json` files preserve the reviewed candidate
provenance; the two pack files are byte-identical. `work/gnm-morphology-pack.js`
is the modular browser copy written by `npm run build:offline`; the pack is
embedded in `src/app.bundle.js` as well. These artifacts are consumed only by
the explicit GNM renderer. Its current landmark map is provisional.
Family selection uses the reviewed `face-dna-shape-v1` FaceDNA rule table in
`src/morphology.js`; it is explicit and semantic, not learned from the pack or
derived from the profile seed. The analytic `sports/morph-v1` renderer and
runtime defaults are unchanged.
