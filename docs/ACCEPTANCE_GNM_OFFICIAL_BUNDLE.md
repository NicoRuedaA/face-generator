# Acceptance: Official GNM Asset Bundle

The accepted runtime boundary is the separate lossless render package. The full
canonical package remains archival and is still validated by the canonical
validator; Pages does not stage the 138 MB canonical GLB.

This acceptance records the first official GNM 3D integration slice for the
explicitly authorized public, noncommercial MVP scope. The source is GNM at
revision `8ea2906a31aab7f8b550e33968f3c0a86051a92d`, archive SHA-256
`2aabb75107ed5a3c7be45ba93700fbfa7e1333c646054ff9dc9d267dd02b730d`, under
Apache-2.0. The package is generated locally; the external checkout is not
copied wholesale.

## Quick path

1. Run the NumPy-only offline importer against the reviewed external NPZ.
2. Validate the accepted manifest, GLB structure, components, UVs, and basis metadata.
3. Run the official browser smoke with the explicit style.
4. Run the deterministic basis diagnostic; it reads the canonical GLB and metadata only.

```bash
python3 tools/gnm/validate_official_bundle.py /path/to/official-bundle.json
python3 tools/gnm/validate_official_gnm_asset.py tools/gnm/work/official-bundle.json
npm run capture:gnm-official-smoke
npm run diagnose:gnm-official-basis
npm run test:gnm-official-basis
```

The canonical placeholder and its tests are intentionally fast and stdlib-only:

```bash
npm run validate:gnm-official-example
npm run test:gnm-official-bundle
```

## Required contract

The manifest schema is `sports-face-gnm-official-bundle/v1`. It must record:

| Area | Required evidence |
| --- | --- |
| Source | Repository URL without embedded credentials, exact upstream revision/commit or release, and source archive SHA-256 |
| License | Declared license name, SPDX identifier, license text path, and license text SHA-256 |
| Permission | Explicit `pending`, `approved`, or `denied` decision, reviewer, decision date, and decision reference; repository license alone is never inferred as redistribution permission |
| Geometry | Expected vertex/triangle counts and identity/template topology consistency with matching counts |
| Assets | Self-contained GLB, metadata, exact UV policy, six components, basis payloads, and SHA-256 hashes |
| Safety | Relative paths only, no traversal, bounded files, and `runtimeAllowed: false` until explicit human approval |

For `reviewed` and `accepted`, every referenced file must exist next to the
manifest, remain within its directory, stay below the validator size limits,
and match its recorded hash. GLB and NPZ mesh files receive additional simple
structural checks; JSON role files must identify their role and counts where
applicable.

## Status transitions

```text
proposed -> reviewed -> accepted
```

- `proposed`: intake shape and intended provenance are being assembled; missing assets and neutral placeholders are allowed; runtime is forbidden.
- `reviewed`: a human has inspected the candidate evidence, but acceptance and runtime use are still forbidden unless it advances to `accepted`.
- `accepted`: all required files, hashes, geometry counts, topology checks, license evidence, and explicit redistribution permission are complete. `runtimeAllowed` may be true only with the approved permission record.

The validator does not promote statuses or infer approval. A human reviewer must
edit the manifest, attach the decision reference, and rerun the exact command.

## Runtime boundary

The runtime uses `gnm-official-head-render.glb`, a `665,904` byte render-only GLB
with `18,437` deduplicated vertices and `35,324` triangles. It preserves exact
float32 POSITION/UV bytes and triangle order through deterministic first-
occurrence pair deduplication, with uint16 indices and no quantization. The
canonical `gnm-official-head.glb` remains `138,998,408` bytes and unchanged.
Basis payloads (`253` identity and `383` expression) are omitted from the render
asset and remain offline/optional; semantic mapping remains disabled.

The public redistribution is explicitly authorized for this noncommercial MVP
by `project-owner` on `2026-08-12`, reference
`sports-face-mvp-noncommercial-mvp-authorization`.

## Phase 4 technical Basis Lab acceptance

The opt-in Basis Lab payload is separately delivered from the render GLB and is
not embedded in either GLB. It selects canonical indices `0..3` in each family:
`head_000..003` and `left_eye_region_000..003`. The projected binary is exactly
`1,843,736` bytes for `18,437` render vertices and eight float32 vectors, with
uint32 `sourceVertexId` correspondence and a strict 3 MiB global budget.

The browser accepts it only after checking metadata schema, canonical/render
hashes, payload size, binary dimensions, and SHA-256. Technical coefficients
are clamped to `[-0.25, 0.25]`; labels never claim anatomy. Lab diagnostics use
`basisIncluded: true`, `semanticMapping: disabled`, and
`runtimeBasisLoaded: true`. Any failure falls back without an uncaught page
error. The existing official neutral style remains unchanged.

## Phase 5 visual-quality acceptance

The official neutral style reports material model
`neutral-procedural-components-v2` and six deterministic technical material
records in primitive order. Each record identifies its component, base color,
perceptual roughness, and specular strength, and is explicitly
`materialSource: neutral-procedural` with `officialTexturesIncluded: false`.

The official shader remains WebGL2/GLSL ES 3.00 and does not sample textures.
It uses derivative normals with `faceforward`, disabled culling for mixed
winding, hemisphere ambient, key/fill/rim lights, bounded lightweight
specular response, and a cavity-like normal/light agreement term. Diagnostics
expose all six feature flags (`hemisphere`, `key`, `fill`, `rim`, `specular`,
`cavity`). Basis Lab reuses the same visual model while preserving its separate
payload request and CPU deformation semantics.

## Conservative basis diagnostic result

The committed report is `tools/gnm/work/gnm-official-basis-diagnostic.json`. It
is generated with Python standard library only and contains no absolute paths.
The diagnostic passed for asset v2 and schema
`sports-face-gnm-official-head/v1`, identity `253 x 17,821 x 3`, expression
`383 x 17,821 x 3`, and template `17,821 x 3`. Every payload is little-endian
float32 with the exact expected byte length and finite values. Zero and sampled
first/middle/last one-hot reconstructions passed with float32 arithmetic and
exact byte comparison. The report records aggregate displacement bounds and all
six sourceVertexId mappings.

The source ranges are disjoint and exhaustive over vertices `0..17,820`; local
POSITION bytes match the assembled canonical template byte-for-byte. The
optimized render mapping was also compared successfully. This is diagnostic
evidence only: `semanticMapping: disabled`, `runtimeBasisLoaded: false`, no
browser basis loading, and no canonical or render GLB modification.

## Phase 6 quantitative semantic evidence

The Phase 6 acceptance artifact is
`tools/gnm/work/gnm-official-semantic-evidence.json`, generated by the
stdlib-only command:

```bash
npm run analyze:gnm-official-semantics
npm run test:gnm-official-semantics
```

It reports exact source hashes and a `source.evidenceBaseRevision` identifying
the project source snapshot analyzed (not the future commit containing the
report), plus `253` identity and `383` expression directions over `17,821`
vertices, compact per-basis norms/maxima, energy totals
and shares by technical prefix/component, plus FaceDNA and morphology inventories.
The exact prefix groups are descriptive only: `head`, `eyes`, `teeth`,
`left_eye_region`, `right_eye_region`, `lower_face_region`, `tongue`, and
`pupils`. They do not establish anatomy or application semantics.

If the vertex map is present, the report also gives provisional radius `0.01`
landmark-region energy. It is a raw squared-displacement sum, shares are divided
by family total, and there is no area normalization. The map remains
`ai-assisted-full-landmark-map-provisional`, with `anatomicalCorrectness:
not_proven` and no anatomical claims.

The report must state `semanticMapping: "unestablished"` and
`runtimeBasisLoaded: false`. No paired FaceDNA-value-to-GNM-coefficient or
target-geometry dataset exists. Future acceptance requires paired data, a
predeclared held-out R² threshold, cross-validation, bilateral consistency,
causal one-hot tests, negative controls, human approval, and versioned mapping
metadata. This phase does not enable semantic mappings; Basis Lab remains a
numeric/technical experiment and runtime assets/source remain unchanged.

The report precision policy retains full JSON float precision from deterministic
IEEE float32-derived Python calculations and excludes raw basis arrays. The
serialized report must remain at or below `600,000` bytes. Landmark IDs are
validated against coordinate-selected radius membership; regional assignments
are explicitly non-exclusive, and regional energies must not be summed.

## Phase 7A deterministic calibration annotation dataset

Phase 7A is accepted as an offline-only dataset contract. The checked-in
`tools/gnm/work/gnm-calibration-dataset.json` is deterministic and empty:
**no samples means no mapping**. Human labels are free-form review labels, not
anatomical truth. The dataset records canonical SF2/profile metadata, the exact
ordered eight-vector coefficients, technical names, source/selection hashes,
split seed/version, and evidence revision; it stores no geometry or basis
arrays.

The contract requires `semanticMapping: "unestablished"`,
`runtimeBasisLoaded: false`, and `humanApproved: false` by default. Approval is
explicit. Validation rejects duplicate IDs, invalid/non-canonical SF2,
out-of-range coefficients, hash/vector drift, inconsistent splits, absolute
paths, and PII-like fields.

```bash
npm run calibration:gnm-init
npm run calibration:gnm-validate
npm run calibration:gnm-test
python3 tools/gnm/calibration_dataset.py split \
  --dataset tools/gnm/work/gnm-calibration-dataset.json \
  --output-dir /tmp/gnm-calibration-splits
```

The example human-add command is documented in the README and is not executed
as part of acceptance. Projections do not modify the source dataset.

## Review checklist

- [ ] The repository URL has no embedded credentials.
- [ ] The exact upstream revision/release and source archive hash are recorded.
- [ ] The license text is the text from the reviewed bundle and its hash matches.
- [ ] Redistribution permission is explicit and references a human decision.
- [x] Render mesh, UVs, neutral materials, eyes, teeth, and tongue are complete and hashed.
- [x] Canonical identity/template topology counts are consistent; render triangle counts match exactly.
- [x] `runtimeAllowed` is true only for the explicit project-owner MVP decision.
- [x] The canonical and render validators pass from the repository context.
