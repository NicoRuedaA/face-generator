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

```bash
python3 tools/gnm/validate_official_bundle.py /path/to/official-bundle.json
python3 tools/gnm/validate_official_gnm_asset.py tools/gnm/work/official-bundle.json
npm run capture:gnm-official-smoke
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

## Review checklist

- [ ] The repository URL has no embedded credentials.
- [ ] The exact upstream revision/release and source archive hash are recorded.
- [ ] The license text is the text from the reviewed bundle and its hash matches.
- [ ] Redistribution permission is explicit and references a human decision.
- [x] Render mesh, UVs, neutral materials, eyes, teeth, and tongue are complete and hashed.
- [x] Canonical identity/template topology counts are consistent; render triangle counts match exactly.
- [x] `runtimeAllowed` is true only for the explicit project-owner MVP decision.
- [x] The canonical and render validators pass from the repository context.
