# Third-party notices

## OpenTTD

- Project: OpenTTD
- Repository: https://github.com/OpenTTD/OpenTTD
- Relevant reference files:
  - `src/company_manager_face.h`
  - `src/table/company_face.h`
- License: GNU General Public License version 2 (`GPL-2.0-only`)

This temporary MVP is informed by OpenTTD's company-manager face architecture: compact bit fields, ordered visual variables, palette variables and toggles. It does not include OpenTTD's original sprites.

Copyright remains with the respective OpenTTD contributors.


## ToonHead / DiceBear Toon Head

This prototype includes a curated and modified subset of ToonHead vector
components.

- Creator: Johan Melin
- Original work: ToonHead
- License: CC BY 4.0
- Source: https://www.figma.com/community/file/1589627891082866389
- DiceBear style: https://www.dicebear.com/styles/toon-head/
- Modifications: neutral facial mapping, recolouring, sports kit adaptation,
  morphological scaling, original sports hair/beard overlays, age plausibility
  rules and added sports-face details.

See `third_party/toon-head/ATTRIBUTION.md`.


## GNM Head

This MVP includes a generated official GNM-derived 3D package under the
explicitly authorized public, noncommercial scope. It was generated from
`google/GNM` revision `8ea2906a31aab7f8b550e33968f3c0a86051a92d`, source archive
SHA-256 `2aabb75107ed5a3c7be45ba93700fbfa7e1333c646054ff9dc9d267dd02b730d`,
and official NPZ SHA-256
`03649b09d1f756c94e8b3db709edcfa07ac367de0ba35e2d04c985ebcadbaf14`.

- License: Apache-2.0; complete upstream text is retained at `tools/gnm/work/LICENSE-GNM.txt`.
- Permission: `project-owner`, `2026-08-12`, `sports-face-mvp-noncommercial-mvp-authorization`.
- Runtime style: `sports/morph-webgl-official-v1`, opt-in only; default and prior geometry-only WebGL remain intact.
- Components: skin, left/right eye, upper/lower teeth and gums, tongue.
- Materials: neutral procedural materials only. No complete official material texture bundle is included; `edgeflow_bw_4k.png` is visualization-only and is not used as a texture.
- Render optimization: the canonical `138,998,408` byte GLB is unchanged; the runtime render GLB is `665,904` bytes (`99.52%` smaller), with `18,437` unique render vertices and exact float32 POSITION/UV bytes. No quantization or lossy conversion is used. Official identity/expression basis payloads are omitted from the render asset and remain offline/optional.
- Mapping: semantic FaceDNA/expression mapping is disabled because the names do not safely establish anatomical semantics. Identity-only invariance is preserved.
- Basis diagnostic: `tools/gnm/diagnose_official_gnm_basis.py` and its committed
  report are offline, stdlib-only evidence. The report validates the `253`
  identity and `383` expression float32 bases, finite payloads, deterministic
  reconstruction math, and all six sourceVertexId mappings. It does not load
  bases at runtime or establish semantic mappings; `semanticMapping` remains
  disabled and `runtimeBasisLoaded` remains false.
- Technical Basis Lab: the separately delivered `gnm-official-basis-lab.bin` is
  `1,843,736` bytes and selects only the first four identity and first four
  expression vectors. It uses technical labels, exact float32 values and
  sourceVertexId projection; it establishes no anatomical or FaceDNA mapping.
- Phase 5 visual model: `neutral-procedural-components-v2` is project-authored
  runtime code. It adds no textures or external dependencies; its six component
  colors and lightweight lighting diagnostics are technical presentation choices,
  not official GNM material claims or anatomical semantics.
- Phase 6 semantic evidence: `tools/gnm/analyze_official_gnm_semantics.py` emits
  a deterministic stdlib-only quantitative report. It characterizes the basis
  payload but explicitly keeps `semanticMapping: "unestablished"`; technical
  groups and provisional landmark-region energy are not anatomical claims. No
  FaceDNA-to-GNM paired dataset exists, and no runtime or Basis Lab mapping is
  enabled.
- Phase 7A calibration dataset: `tools/gnm/calibration_dataset.py` and its
  checked-in empty template are offline-only metadata tooling. Labels are
  free-form technical review labels, not anatomical truth; no sample means no
  mapping. Geometry, basis arrays, secrets, PII, and absolute paths are not
  stored. `semanticMapping` remains `unestablished`, `runtimeBasisLoaded`
  remains `false`, and human approval is opt-in.
