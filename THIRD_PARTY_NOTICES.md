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


## GNM Head

This MVP includes a generated official GNM-derived 3D package under the
explicitly authorized public, noncommercial scope. It was generated from
`google/GNM` revision `8ea2906a31aab7f8b550e33968f3c0a86051a92d`, source archive
SHA-256 `2aabb75107ed5a3c7be45ba93700fbfa7e1333c646054ff9dc9d267dd02b730d`,
and official NPZ SHA-256
`03649b09d1f756c94e8b3db709edcfa07ac367de0ba35e2d04c985ebcadbaf14`.

- License: Apache-2.0; complete upstream text is retained at `tools/gnm/work/LICENSE-GNM.txt`.
- Permission: `project-owner`, `2026-08-12`, `sports-face-mvp-noncommercial-mvp-authorization`.
- Runtime style: `sports/gnm-3d-player-v1`, the only renderer. Previous 2D and prototype viewers have been removed.
- Components: skin, left/right eye, upper/lower teeth and gums, tongue, plus project-authored procedural hair, glasses and jersey.
- Materials: procedural painting only; no official textures are included.
- The canonical full GLB remains offline; the application loads the compact render GLB and player-generator payload.
- Phase 8 GNM 3D Player: `tools/gnm/work/gnm-player-generator.bin` and its
  metadata are derived offline from the same official NPZ (32 head identity
  directions, 19 normalized feature-gradient tails and three expression
  presets), the official `head_sparse_68.txt` landmark definition (upstream
  revision `0ae8cc7aa2ef3c08dbc7fd35d6772869380e7f96`, SHA-256
  `d8b6066a87ca37c48bcf4d0834542db841709b65cb983e873fa1e441a22219d0`) and the
  official semantic-sampler `expression_decoder_model.h5` (revision
  `8ea2906a31aab7f8b550e33968f3c0a86051a92d`, SHA-256
  `5eba165f8a414f73b24be96963d0a17e708c0856739ed85a19031f318dfb51e6`), all
  Apache-2.0, under the same noncommercial authorization. Only derived numeric
  data is redistributed (no decoder weights, no textures). Painting fields,
  hair shells, glasses and the jersey bust are project-authored procedural
  rendering, not official materials.
