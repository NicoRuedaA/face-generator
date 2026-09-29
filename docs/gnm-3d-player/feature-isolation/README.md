# Independent face controls and style catalogs

Local edits now preserve the underlying player instead of resampling the whole head. The editor exposes real-render thumbnail catalogs for **12 hairstyle slots, 6 beard styles and 8 eyebrow styles**. No new WebGL context is allocated per card.

## Try it

1. Open `index.html` or `index.module.html` over HTTP and expand **Catálogo de estilos**.
2. Choose a card with the mouse, or Tab to it and press Enter/Space. The matching named selector and selection border update together.
3. Switch brows, freckles or eye color: skin pigment, global geometry and automatic expression stay fixed. Change eyes, nose, mouth or ears: only that anatomical region changes.

The thumbnail is explicitly a reference face, not a preview of the current player's exact geometry/pigment. Selecting a hairstyle enables hair visibility and clears the old session-only prototype override. The profile's SF2 code stores the catalog selection.

## Root fixes

| Root | Correction |
| --- | --- |
| Skin tint hashed the complete `identityBits` word | Tint now uses only skin slot and the stable profile seed. Freckles and iris color cannot tint skin. |
| Each local label resampled global PCA components; conditioning also had global support | Seed-stable base identity; broad head/jaw/proportion conditioning; independent official-GNM feature deltas blended through compact template-space support. |
| Automatic expression depended on eyes/brows/mouth | Automatic expression now depends only on the seed; explicit expression controls remain independent. |
| Brow styles altered global shape, including styles with no shape targets | All eight styles are grooming-only. High/low styles offset the brow field; angular brows have a sharper arch. |
| Freckles were barely visible interpolated noise | Sparse antialiased pigment spots, restricted to upper cheeks/nose by existing anatomical fields. No change to skin base, geometry or expression. |
| Hidden hair canonicalizes to slot zero | Enable visibility **before** writing a selected catalog hair slot. The browser keyboard test caught this activation-order bug. |

Local support bounds are tied to the validated GNM template, not the changing output coordinates. Masks have a full-strength core and smooth compact edges. Eye/teeth/tongue geometry inside the region receives the same reconstruction as the adjacent skin. Normals and attached grooming are rebuilt afterward. Ear-adjacent sideburns may follow the edited local surface; the crown and collar stay fixed.

## Catalog scope

The existing catalog IDs and counts are retained. Seven hair slots were refined: rapado (0), short volume (1), cropped fringe (2), side part (3), center part (5), curly volume (6), high fade (9). Side part is now durable, not only a session toggle. Fades taper pigment/groom coverage as well as shell thickness. Medium/long/braided/bun families remain available; **long hair and braids are procedural approximations, not strand-simulated production assets**. Beard styles retain their six existing coverage/strand families, now visible through named cards. Eyebrow cards use close crops of actual render output.

## Compatibility

- FaceDNA/SF2 bit positions, valid values, IDs and encoded round trips are unchanged.
- Render mapping is **`gnm-player-mapping-v2-local`**. Old codes remain loadable, but their rendered face can differ from v1 because the global prior and feature composition were corrected. This is NOT a pixel-preserving renderer update.
- The same seed, SF2 data and render settings remain deterministic. Editing a feature and restoring its value restores the exact output pixels.
- Head, jaw and facial proportion are intentionally broad edits. Skin changes pigmentation; shared hair color intentionally changes hair, beard and brows. Age and expression retain their documented wider effects.

## Evidence

- `tests/feature-isolation.test.mjs`: all controls on three deterministic seeds, unchanged cosmetic geometry/pigment, positive local geometry changes, independently specified anatomical bounds, stable crown/collar, reversible edits, every local label nontrivial, all 12/6/8 catalog meshes distinct.
- `tests/gnm-player.test.mjs`: 11 anatomical high/low measurement orderings over 24 seeds each, payload/catalog parity, coefficient bounds, official expressions, groom/collar and side-part pattern regressions.
- `tests/browser_feature_isolation.py`: actual UI selections, neutral and automatic expressions, localized pixel differences and exact restoration; all 26 thumbnails, hidden-hair activation, keyboard selection and 390px responsive layout.
- `browser-results.json` (modules) and `browser-bundle-results.json` (bundle): pixel-change counts and bounding boxes; `comparison.png`: same seed/camera/light before and after each edit.
- `catalog-desktop.png`, `catalog-mobile.png`: native browser screenshots, not generated artwork.

The pre-fix regression failed immediately on `head: skin base isolated`: a head edit changed RGB from `[0.502233, 0.302774, 0.194943]` to `[0.488746, 0.298771, 0.199215]`, despite preserving the skin selector. The same test now checks the full control matrix instead of accepting correlated global drift.

Run with the existing HTTP server on port 8080:

```sh
npm run test:model
npm run test:rendering
npm run test:gnm-player
uv run --with playwright python3 tests/browser_smoke.py
uv run --with playwright python3 tests/browser_feature_isolation.py
uv run --with playwright python3 tests/browser_feature_isolation.py --entrypoint index.html --check-only
```

### Final verification

- `npm test`: passed, including the new isolation suite wired through `test:gnm-player`; official source-NPZ tests and generator rebuild were explicitly skipped because external upstream inputs/dependencies are unavailable. Committed runtime payload validation and 16 fail-closed mutation cases passed.
- `uv run --with playwright python3 tests/browser_smoke.py`: both module/bundle entrypoints passed, including unavailable-WebGL and unavailable-asset behavior.
- Focused browser harness: **both entrypoints passed**, 14 actual edits each (7 controls × neutral/automatic), 26 rendered thumbnails each, keyboard activation and 390px responsive checks. The observed changed-pixel fraction ranged from **0.072% to 2.612%** of the portrait; all reverted renders were byte-identical to baseline. No page errors.
- `git diff --check`: clean.

## Rollback boundary

Remove only this work unit's local composition/skin/expression changes, catalog UI/preview additions, coverage/brow/freckle modifications and their new regressions. Keep the pre-existing 3D-only cleanup, realism, collar/grooming, aging and prototype radial-pattern fix. `src/app.bundle.js`, release manifest and checksums must then be regenerated; do not reset the dirty worktree to HEAD.
