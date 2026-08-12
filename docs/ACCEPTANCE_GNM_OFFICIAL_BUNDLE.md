# Acceptance: Official GNM Asset Bundle

This phase adds a fail-closed intake contract for a future official GNM bundle.
It does not accept, download, or redistribute official GNM assets. The current
repository still contains only retained geometry and derived offline artifacts.

## Quick path

1. Copy `tools/gnm/work/official-bundle.example.json` to an intake location outside runtime assets.
2. Replace every neutral placeholder with evidence from the exact upstream bundle.
3. Record human provenance, licensing, and redistribution decisions.
4. Run the validator and retain its output with the review record.

```bash
python3 tools/gnm/validate_official_bundle.py /path/to/official-bundle.json
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
| Assets | Mesh, UVs, materials/textures, eyes, teeth, tongue paths and SHA-256 hashes; expressions are optional |
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

Do not add UVs, textures, eyes, teeth, or tongue to the browser/runtime until a
manifest is `accepted`. This phase makes no runtime, GLB, PCA, FaceDNA, SF2, or
SVG changes. No official GNM asset was accepted or redistributed here.

## Review checklist

- [ ] The repository URL has no embedded credentials.
- [ ] The exact upstream revision/release and source archive hash are recorded.
- [ ] The license text is the text from the reviewed bundle and its hash matches.
- [ ] Redistribution permission is explicit and references a human decision.
- [ ] Mesh, UVs, materials/textures, eyes, teeth, and tongue are complete and hashed.
- [ ] Identity and template topology counts are consistent.
- [ ] `runtimeAllowed` remains false until the human approval is complete.
- [ ] The validator passes from the manifest directory context.
