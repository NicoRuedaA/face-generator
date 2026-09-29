# Remove side-part hair bands across colors

The reported radial/"leopard" pattern reproduced in the side-part prototype,
especially in gray and blond. Pigment selection worked: the same unwanted
surface pattern was multiplied by every color.

## Root cause and fix

`gnmPlayerHairSurfaceOffset` embossed a repeated `cos(flow * 660)` into the
prototype; `hairAlbedo` repeated that wave in pigment and normal detail.
The curved coordinate made those regular bands look like nested/radial stripes.
This is one prototype material/geometry defect, not separate color bugs.

Removed the prototype's periodic waves. Its random directional fibers now use
head-surface angles rather than parallel world-space slices, with
screen-footprint filtering for subpixel detail. The asymmetric crown and carved
part remain. The fix is restricted to the prototype: original straight, curly,
braided and other catalog styles keep their pre-fix geometry/material behavior.
An early broad material attempt reduced curl distinctiveness and was rejected.

## Compare

Columns: dark, blond, gray. Rows: original short, medium, curly, then side-part.
Same face, lighting, age, camera and pigments before/after; 24 renders per phase.

- Front: [before](before-front.png) / [after](after-front.png)
- Side: [before](before-side.png) / [after](after-side.png)
- Runtime evidence: [before](before.json) / [after](after.json)
- [Verification](verification.json): 24 matching identity/code/camera pairs; original short/medium/curly image rows are pixel-identical (ImageMagick AE = 0 for front and side).

Broad repeating prototype bands are removed, not hidden by recoloring or a
whole-image blur. Fine procedural fibers remain visible. Hair is still sculpted:
comb-like fibers are not finished authored hair assets. Evidence covers one face,
four styles, three colors and two angles—not every possible head/view.

## Checks and reproduction

- `npm run test:gnm-player`: prototype crown ripple/pigment mask regression,
  filtered strand detail, original envelopes identical to pre-fix formulas,
  eight distinct pigments and existing identity/SF2 invariance tests.
- `npm run test:model`, `npm run test:rendering`, `npm run test:browser-smoke`.
- `npm run build:offline`, release/checksum refresh and integrity verification.
- Native capture (serve current source over HTTP):
  `uv run --with playwright python3 /home/nico/.agents/skills/webapp-testing/scripts/with_server.py --server "python3 -m http.server 8080" --port 8080 -- python3 tools/gnm/capture_hair_pattern.py --phase after`

Rollback only the prototype envelope/material edits and their regression
assertions/capture evidence; rebuild the bundle and integrity files. Do not revert
prior prototype/UI work or unrelated dirty 3D-only, skin, age, grooming and collar changes.
