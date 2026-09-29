# Facial material realism

The 3D player is lit by a procedural studio with cast shadows, baked ambient occlusion, an environment light and pre-integrated skin scattering. Its eyes have strand eyelashes, a wet tear line and a refractive cornea, its scalp hair, beard and eyebrows are thousands of generated strands, and every image passes through a multisampled photographic post-process. These are real-time approximations built entirely in code, **not a claim of photorealism**.

## Realism v2, part D: strand beards and eyebrows

### Same-seed comparison

- Close-ups (same players, cameras and 512 px tiles as before and parts A–C): [part C](realism-v2/c-after-closeups.png) → [part D](realism-v2/d-after-closeups.png). The medium player's thick brows and stubble were a painted band and ribbons; they are now strands.
- [Grooming catalogue](realism-v2/d-grooming-catalog.png): the six beards on one fixed masculine identity (seed `realism-v2-grooming`, age 30, so no grey strands) from the front, three-quarter and profile, as 320 px crops of 512 px renders. Below them, the eight brows from the front and three-quarter, as 480 × 240 crops of 819 px renders. Pigments cycle black, brown, blond, red and grey.
- [Grooming details](realism-v2/d-grooming-details.png): 1:1 crops of 2048 px renders. They show brow growth (head, body, tail) and sparse brow edges, stubble with follicle darkening and a fading cheek line, a moustache on an open mouth (alert expression), a short beard's cheek line and neckline, a full beard's jawline silhouette, a goatee, a grey full beard over a smile, key-light visibility (strand shadows) and ambient occlusion of a full beard. A strip of 256 px thumbnails at 1:1 shows the reduced strand tiers.
- Gallery: [after part D](gallery.png). Its manifest is byte-identical to parts A–C: seeds, SF2 codes, identity coefficients, expressions and feature z-scores. The close-up sidecar keeps the same codes, cameras and identity data.
- `tests/browser_feature_isolation.py` passes on both entry points ([pixel footprints](realism-v2/d-feature-isolation.json)). The brow edit now changes only the brow band (rows 142–171 of the 498 px canvas). Until part C it also changed about five nostril pixels (rows down to 237, or 276 with the automatic expression); that leak is gone with the painted brow.

### Techniques

| Area | Implementation |
| --- | --- |
| Surface walk | Brows and beards root on stratified skin candidates (21,080 brow and 29,833 beard candidates, static per template, in a fixed shuffled order). Each strand walks the deformed skin along a straightest geodesic: a triangle and barycentric position, a direction unfolded across shared edges (welded by official source vertex across UV seams) and a zone mask that stops it at the zone border. Every point sits at a lift profile above the skin along the interpolated normal, so strands follow every identity and expression and never go under the skin. |
| Brow growth | The growth field comes from the gradients of the official `browT`/`browD` fields on the deformed triangle. Head hairs point up and slightly out (set against the local vertical). Body hairs point up and out along the style's arch: steeper from the lower edge, flatter from the upper edge, so they converge. Tail hairs point out and down. Hairs lie 0.1–0.8 mm above the skin in random layers, turn gently with the field, bend a little, taper and fade at the tip. Fine hairs gather along the edges and in the head, with a few strays. |
| Brow shape | The catalogue shape (thickness, arch, peak, length, density, angular, low/high offset) sets the root density: roots stop short of the catalogue length because the hairs reach it, and the edges are irregular, with sparse strays and skin showing where density is low. The eight styles stay distinct (tests check offsets, thickness, length and arch). |
| Beard regions | A soft density from the official beard and mouth fields: an irregular, fading cheek line; a soft neckline; the moustache from the red lip up to the nostrils; the chin goatee and the links around the mouth corners. A template gate closes the beard behind the jaw angle (the official neck line only follows jaw landmarks 2–14). Hair grows up to where the red lip begins; the lips, the mouth and the nose stay clear. |
| Beard growth | Down on the cheeks and jaw, down and forward on the chin, down and out on the moustache, back towards the throat under the jaw and down the neck with a low-frequency swirl. Lengths by region (stubble 1 mm; short 4–7 mm; full 11–32 mm). Walks stop at a random lip-mask level, so moustache tips overhang the lip unevenly, and they stay 5 mm above the collar plane. |
| Volume, clumping | Beard strands rise at their lift angle to a layered volume. It is flatter on the cheeks and moustache and fullest at the jaw, chin and under the jaw (up to 8.5 mm for the full beard), so the full beard's silhouette breaks the jawline. Strands clump towards blue-noise seed strands (4.2 mm apart), strongest at the tip, then regain their clearance. The full beard adds frizz and a wave. |
| Stubble | Straight 1 mm stubs standing 38–68° off the skin, about 6,700 on a masculine face, plus a follicle darkening of the skin graded by the same density. |
| Skin underlay | A per-vertex root density (the same density functions as the roots) tints the skin faintly under brows and beards and adds the stubble darkening. It only darkens, fades under the red lip, and is zero outside the zones; `beard/none` leaves only part A's presentation-gated beard shadow. |
| Shading | The scalp hair's fibre program (Marschner-style R, TT and TRT lobes with pigment-gated absorption, so dark beards stay rich), with its own pigment, grey fraction, roughness and tip fade per draw. Beard and brow pigments keep the model's semantics (0.86× and 0.68× the hair colour, greying from ages 30 and 46): each strand has a grey share whose mean is the previous colour. One strand is one hair, so facial strands keep more of their sub-pixel coverage than scalp strands (opacity floor 0.66–0.7, at least 0.5–0.55 px wide). |
| Shadows, AO | Strands cast stochastic partial coverage into the key-light map. Under them the skin filters that coverage over a wider kernel, so the shade under a beard is smooth rather than blotchy. Strands read their root skin vertex's baked AO, and the first third of the beard's reduced tier occludes the AO bake (like the scalp hair), so the neck under a full beard darkens. |
| Level of detail | Thumbnails build only the reduced tier: the candidates in the first 45% of the fixed order, an exact prefix of the full build. The direct fallback and canvases of 320 px or less draw that tier 1.35× wider. Strands are built once per profile; camera orbits never regenerate them. |
| Determinism | Integer hashes and per-strand xorshift streams; the same follicles for every style of a part, so changing a style changes the shape and grooming, not the random pattern. The same profile gives the same strands and the seed varies them. |

### Performance

Measured on this machine against part C's preserved bundle, interleaved. The host was loaded by unrelated jobs (load average 6–13), so minima are reported with medians.

- Warm CPU frame generation, 12 gallery players (Node, three interleaved runs of nine repetitions): part C 529–546 ms, part D 589–602 ms (1.10–1.12×; medians 1.12–1.15×). The gallery has 12 brows, 3 stubble, 2 short and 1 full beard. The reduced tier that thumbnails build is 1.05–1.09×. With the facial strands stubbed out, part D takes 0.99× part C. Isolated per-frame costs: brows 1.1–2.5 ms, stubble 2.2 ms, short beard 6.7 ms, full beard 11.7 ms, goatee 2.8 ms, moustache 1.0 ms; the retired ribbons cost about 1.8 ms per frame. One-time start-up is not slower (whole static build 173–258 ms against part C's 189–306 ms in the same runs): the facial-hair zones and candidates replace the old 14,000 groom samples. Camera orbits run no strand generation.
- GPU on SwiftShader, through each build's own bundle (5 players, minima and medians):
  - Default profiles (one short beard, one stubble): orbit redraw 0.98× and 0.98× (256 px), 0.97× and 1.00× (512 px); full render 0.97× and 0.92× (256 px), 1.00× and 1.06× (512 px).
  - Forced full beard and thick brows on all five players: orbit redraw 1.06× and 0.95× (256 px), 0.95× and 0.93× (512 px); full render 1.10× and 1.03× (256 px), 1.01× and 1.05× (512 px).
- Where the time goes: on the CPU, walking the skin (a few triangle crossings per strand) and writing the ribbon buffers. To stay inside the budget, brows take 4 segments, the short beard 3 and the full beard 5; clump seeds are 4.2 mm apart; stubble skips the walk (its stubs are far shorter than the skin's curvature radius); per-style candidate densities are cached per asset. On the GPU the strands add one draw each for the beard and the brows in the main pass and the key-light map, which the removal of the painted brow and beard (per-pixel noise in the skin shader) offsets.

### Verify

- `npm test` includes `tests/gnm-player-facial-hair.test.mjs`. It checks the static zone data (mutual edge neighbours, candidates inside their triangles and zones, blue-noise clump seeds). It builds all 8 brows and 6 beards on 3 identities (neutral, alert and soft expressions) and requires finite, bounded strands rooted on the skin. An exact point-to-triangle test puts every checked point outside the skin (188,180 points, lowest 0.018 mm). Brows stay inside the brow region; beards stay above the collar, never lie on the red lips or in the mouth, and never touch the nose. The moustache, goatee and full beard are checked under all four expression presets. It also checks the growth direction by region, hairs lying close to the skin, per-style character (offsets, thickness, length and arch; stubble, short and full lengths, the full beard's volume and hang, goatee and moustache shapes), pairwise distinct styles, determinism, seed variation and the reduced tier as an exact prefix. Aperiodicity is checked with the root-grid spectrum, per-strand correlation and no `Math.random`. Isolation: hair style, colour and visibility and unrelated controls never change the beard or brows, beard and brows never change each other, and the underlay stays in its zone.
- Tests updated because the semantics changed legitimately: `tests/gnm-player.test.mjs` (beard and brows are strands with their own bounds, and the groom takes the seed), `tests/gnm-player-lighting.test.mjs` (strand roots and AO texels replace ribbon root triangles) and `tests/browser_smoke.py` (strand caps, facial-hair diagnostics and levels of detail).
- Re-capture with `python3 tools/gnm/capture_realism_closeups.py --output <png>`, adding `--mode grooming-catalog` or `--mode grooming-details`.

### Limits

- **Strand count.** Brows have about 800–1,800 strands and beards about 500–6,700, one render strand per hair. At 512 px a strand is at least half a pixel wide, two to three times a real hair, so its opacity is reduced to keep the density plausible; the texture still changes a little with resolution (individual hairs resolve only in large renders).
- **The full beard** is a volume that follows the skin of the jaw, chin and neck, up to 8.5 mm thick. It does not hang freely, so very long beards are out of scope.
- **Surface following** uses the mesh (about 2.5 mm triangles) with interpolated normals. There are no dynamics or hair-to-hair collisions beyond clumping.
- **Region fields.** Beard regions use the official beard and mouth fields plus a template gate behind the jaw angle. Some styles meet the scalp hair's sideburn with a small gap of skin in front of the ears.
- **Shadows.** Brow hairs cast micro-shadows smaller than a key-light texel, so their shade on the skin is barely visible; the beard's shade under the strands is filtered smooth.
- **The direct fallback** dithers strand coverage without MSAA and looks thinner.
- **SwiftShader timings** are CPU-emulated; GPU/driver pixel differences are expected.

## Realism v2, part C: strand-based scalp hair

### Same-seed comparison

- Close-ups (same players, cameras and 512 px tiles as parts A and B): [part B](realism-v2/b-after-closeups.png) → [part C](realism-v2/c-after-closeups.png). The helmet-like hair shell is gone: the bob, the crop and the curls are now strands.
- [Hair catalogue](realism-v2/c-hair-catalog.png): the 12 catalogue styles and the session side-part prototype on one fixed identity (seed `realism-v2-hair`), each from the front, in profile and from behind, cycling black, blond, auburn and grey. The tiles are 512 px renders shown at 320 px.
- [Hair details](realism-v2/c-hair-details.png): 1:1 crops of 2048 px renders. They show a caesar hairline, a blond fringe, a temple fade, centre and side partings from above, curly and long silhouettes against the backdrop, cornrows, and key-light visibility (strand shadows) under a fringe and on a cheek and neck. A strip of 256 px thumbnails at 1:1 shows the reduced strand tier.
- Gallery: [after part C](gallery.png). Its manifest is byte-identical to parts A and B: seeds, SF2 codes, identity coefficients, expressions and feature z-scores. The close-up sidecar keeps the same codes, cameras and identity data.

### Techniques

| Area | Implementation |
| --- | --- |
| Grooming | A groom per catalogue style (the side-part prototype shares slot 3's groom). Each defines a flow field over the scalp: a crown whorl with a swirl, a parting, and a comb direction by region (forward, quiff, side or centre part, tousled, outward curls, towards the bun, along cornrow rows). Lengths are set per region (top, fringe, sides, back, nape) with fade gradients, plus root lift, gravity, clumping, frizz, and curl or wave. |
| Roots and guides | 40,067 stratified candidate roots sit on the reconstructed skin (triangle and barycentric, static per template). They are accepted in a fixed shuffled order by a density field: a soft hairline falloff with about 4 mm of jitter (twice as wide on the buzz cut), fade gradients, a narrow parting channel and cornrow bands. 1,383 blue-noise guide roots are 5.5 mm apart. |
| Strand growth | Guides grow on demand in up to 22 steps. They collide with a spherical head map (128 × 64 cells, re-projected every frame from the deformed mesh, dilated around the ears with a cone so hanging hair climbs onto them), a neck cylinder, and a top-down height field of the jersey and visible shoulders. Hair resting on the shoulders drapes over their front or back, not outwards along them. Short cuts are trimmed where they would stand out over the ears. Render strands blend two or three guides from the same side of the parting by rotations about the head centre. Directions and radii are blended separately, so no strand takes a chord through the head. Each strand then gets clumping towards its guide, a smooth random deviation, curl or wave, a layer offset and a per-point collision pass. |
| Hairline, partings | Baby hairs and flyaways sit in the soft hairline band. A painted underlayer tints the scalp with root colour by density and follicle noise, so dense hair never looks see-through while buzz cuts and fades show scalp. Partings are a narrow, slightly wandering channel of darker, less saturated scalp in the shade of the hair. Strands beside it lie flatter and a few are combed across it. |
| Braids, bun | Cornrows are three interlaced fibre bundles per row, following per-row paths over the scalp and ending in hanging plaits. The bun is strands spiralling from its rim towards its crown, with the scalp strands combed towards it. |
| Ribbons | Tapered camera-facing ribbons in a dedicated lean shader. They are at least 0.6 px wide (1.0 px on the direct fallback), and the width they lack becomes coverage. Fibre bodies stay opaque (alpha-to-coverage does not accumulate across strands on SwiftShader); tips and wisps use alpha-to-coverage, and the direct fallback uses screen-door dithering. Scalp strands fade over their last ~8 mm. Hanging hair and standing volume (below the ear tops, or more than 12 mm off the scalp) get wider ribbons point by point, because no scalp shows behind them. |
| Shading | Marschner-style approximation. It has an R lobe shifted towards the root, a TT forward-scatter lobe and a coloured TRT lobe shifted towards the tip. Absorption is fixed and comes from the pigment: dark, eumelanin-rich fibres transmit almost nothing, so black hair stays black in the rim light and through frizz. A wrapped volume diffuse, SH ambient on a radial volume normal and a faint neutral sheen complete it. Each strand varies its melanin, has darker roots and, on lighter colours, sun-lightened tips. Age greying keeps the model's age mapping: each strand has a grey share whose mean is the hair colour (mixed in gamma-2 space). |
| Shadows, AO | Strands cast stochastic partial coverage into the key-light map (4× width, 0.9 coverage), so a fringe leaves soft, broken shade instead of the shell's hard band. A four-tap deep-shadow approximation darkens strands with depth in the volume, and the rim map gates the rim light. Each strand fetches its root's AO texel. The AO bake now also rasterises the first third of the reduced strand tier (the same strands at every level of detail), so skin, ears, jersey and the scalp under hanging hair darken. |
| Level of detail | Thumbnails build only the reduced tier: 45% of the strands, an exact prefix of the full build. The direct fallback and canvases of 320 px or less draw that tier 1.35× wider. Strands are built once per profile; camera orbits never regenerate them. |
| Determinism | Integer hashes and per-strand xorshift streams in a fixed draw order, and no `Math.random`. The same profile gives the same strands; the seed varies them. |

Depth of field now focuses on the near side of the head when the eyes face away from the camera (back views), so hair seen from behind is sharp.

### Performance

Measured on this machine with part B's preserved bundle, interleaved. The host was loaded by unrelated jobs, so minima are reported.

- Warm CPU frame generation, 12 gallery players (Node, three interleaved runs at load ≈ 5): part B 358–361 ms, part C 539–553 ms with the full strand tier (1.51–1.54×) and 439–459 ms with the reduced tier that thumbnails build (1.22–1.28×). Hair hidden, part C takes 297 ms against part B's 319 ms. One-time start-up (scalp candidates, guides, map tables) adds about 80 ms. Camera orbits run no strand generation.
- GPU on SwiftShader, through each build's own bundle (5 players, minima and medians):
  - Part B's own profiles: orbit redraw 0.85× (256 px) and 0.85–1.01× (512 px); full render 0.97–1.19× (256 px) and 1.05–1.32× (512 px).
  - Forced heavy styles (caesar, bob, long wavy, curls, bun): orbit redraw 0.86–0.96× (256 px) and 0.82–1.01× (512 px); full render 1.14–1.23× (256 px) and 1.04–1.14× (512 px). A repeat under a load spike (load average above 16) measured up to 1.63× for 256 px full renders.
- Where the time goes: strand generation is roughly 45% of a frame's CPU time, about a sixth of it growing guides. To stay inside the budget the strand counts were trimmed by 10% during tuning, guides take coarser steps (8 mm or more), and a third guide is blended only when its weight is at least a quarter. The ambient-occlusion bake rasterises only a third of the reduced tier, which keeps full renders (and thumbnails) close to part B. Orbit redraws are not slower than part B: the hair shell is no longer drawn in the main pass and strands use a lean shader.

### Verify

- `npm test` includes `tests/gnm-player-hair.test.mjs`. It checks the scalp candidates, guides and collision map. It builds 13 grooms × 3 identities (one with an expression) and requires finite, bounded, rooted strands, with 2.86 million points outside the head map and the independent skin check. It checks per-style character: buzz stubble, crop lengths, long styles on the shoulders, the bob, curl tortuosity, straight styles, plaits, the bun, partings and baby hairs. It checks the width boost (hanging styles only, never at roots), the tip fade, determinism and seed variation, and that the reduced tier and the AO occluders are exact prefixes. Aperiodicity is checked with the root-grid spectrum, per-strand correlation, no periodic masks in the hair shaders and no `Math.random`. It also checks feature isolation (face, eyes, beard and brows untouched by hair) and the grey strand mean.
- Tests updated because the semantics changed legitimately: `tests/gnm-player.test.mjs` (hair is strands with their own bounds; beard and brows unchanged), `tests/feature-isolation.test.mjs` (12 distinct strand meshes), `tests/gnm-player-lighting.test.mjs` (hair roots and AO texels) and `tests/browser_smoke.py` (strand diagnostics and level of detail by canvas and fallback).
- `tests/browser_feature_isolation.py` passes on both entry points ([pixel footprints](realism-v2/c-feature-isolation.json)).
- Re-capture with `python3 tools/gnm/capture_realism_closeups.py --output <png>`, adding `--mode hair-catalog` or `--mode hair-details`.

### Limits

- **Strand count.** About 4,900–12,600 render strands stand in for about 100,000 hairs, so ribbons are wider than real fibres and each reads as a small lock. In extreme close-ups (2048 px crops) the outer halo of the curly style is sparser than real hair, and the head outline shows inside the volume.
- **Collision** uses proxies: a spherical head map, a neck cylinder and a top-down jersey height field. Long hair lies on the flat top of the procedural bust's back before it hangs, so from behind its ends form a band at shoulder level.
- **No dynamics.** Hair is groomed procedurally, not simulated.
- **Shading** is an approximation. There is no multiple scattering between strands beyond the deep-shadow term, and highlights on thin strands can sparkle at small sizes.
- **Partings** still catch some key light near the front hairline.
- **Beard and brows** kept their previous ribbons and painting in part C; part D converts them to strands.
- **The direct fallback** dithers strand coverage without MSAA and looks thinner.
- **SwiftShader timings** are CPU-emulated; GPU/driver pixel differences are expected.

## Realism v2, part B: eyes, lashes and post-processing

### Same-seed comparison

- Close-ups (same players, cameras and 512 px tiles as part A): [part A](realism-v2/a-after-closeups.png) → [part B](realism-v2/b-after-closeups.png).
- [Eye details](realism-v2/b-eyes-details.png): crops from 2048 px renders with brown, hazel, blue and green irises on light, medium, dark and light-medium skin. Each row has front and three-quarter views plus one non-neutral expression (alert, focused or soft).
- [Post-processing](realism-v2/b-post-details.png): one 768 px render with post effects off and on. It adds 2× ear/hair-edge crops (depth of field), 4× cheek crops (grain) and 256 px thumbnails. "Off" is a capture-only switch that also shows part A's striped backdrop.
- Gallery: [after part B](gallery.png). Its manifest is byte-identical to part A's: seeds, SF2 codes, identity coefficients, expressions and feature z-scores. The close-up sidecar keeps part A's codes, cameras and identity data.

### Techniques

| Area | Implementation |
| --- | --- |
| Eye rig | Rebuilt every frame from the deformed mesh (with lashes and tear line, about 2 ms of CPU per player). Least-squares sphere fits give the sclera and the corneal dome, and a plane fit gives the iris (identity tilts it by up to about 8° from the eye axis). The lid margins come from the official eye-socket field: an inner and outer canthus, spokes and a 32-azimuth polar table of the lid contact line. |
| Eyelashes | Per eye, 96 upper and 30 lower tapered strands of 6 segments, rooted on the reconstructed lid margins, so they follow identity, eye shape and every expression. Seeded clumps of 2–4 lashes pull their tips together. Upper lashes are longer and curl up and out; inner-corner lashes are shorter, sparser and fan less. Lower lashes are fewer, shorter and lighter. A collision pass pushes every point clear of the eyeball envelope and the skin; tests check more than 0.1 mm to the eyeball and no skin penetration. |
| Lash rendering | View-aligned ribbons at least 0.75 px wide carry their true width as coverage alpha and are drawn with `SAMPLE_ALPHA_TO_COVERAGE` into the MSAA target. In the key-light map they cast stochastic partial coverage, so they leave soft streaks. They receive key shadows and their root's baked AO. Pigment comes from the scalp hair: darker than it, with blond and red lashes lighter but dark at the root. Lashes thinner than about 1/8 px (small thumbnails) are skipped. A lash-line darkening on the lid margin remains at every size. |
| Tear line, caruncle | A thin fillet strip along the lid/eye contact line gives a wet body and a sharp specular. The posterior lid margin and the caruncle are shaded as moist pink mucosa with a lumpy caruncle and a sharp highlight. The socket lining is cut just outside the eyeball envelope, so the lids meet the eye at the tear line instead of a dark crevice. |
| Eyeball | Warm off-white sclera, pinker towards the canthi, with faint ridged-noise vessels that fade before they go sub-pixel. Eye occlusion is analytic and comes from the lid contact table, wider under the upper lid. The procedural iris has three radial fibre octaves (each fades out before it would alias), crypts, a zig-zag collarette and an optional seed-stable amber central zone. It also has a limbal ring and a pupillary ruff. The catalogue's four iris colours, their order and FaceDNA semantics are unchanged; only structure is added. |
| Cornea | View rays refract (n = 1.336) through the corneal dome onto the iris plane. The parallax fades to zero at the limbus, so at three-quarter views the iris stays attached to its edge and no sclera shows inside it. A tear-film reflection uses an analytic normal, with Fresnel capped at 0.3. Over the iris only 30% of the environment reflection remains, so pigment is not veiled. The key and fill softbox catchlights stay crisp and are cut by lid and lash shadows. |
| Pipeline | The scene renders offscreen into 4× MSAA RGBA16F when `EXT_color_buffer_float` is available. Otherwise it uses RGBA8 with a compressed encoding. Every framebuffer is checked for completeness. Colour and depth are resolved by blit. A half-resolution depth-of-field gather follows, then a full-screen composite that owns tone mapping (part A's hybrid ACES) and sRGB. Without multisampled storage the renderer draws directly to the canvas, tone-mapped but without MSAA or post effects. Diagnostics report the mode, format, samples and fallbacks. |
| Depth of field | Thin-lens blur focused between the corneal apexes, weighted towards the nearer eye. It is roughly a 60 mm portrait lens at f/6.5, capped at 0.6% of the image height, so collars and shoulders soften without smearing. Background samples cannot bleed over sharper pixels. It is off for canvases of 320 px or less. |
| Grain, vignette | Triangular grain from an integer PCG hash of pixel, profile seed and camera (the same image every time). It peaks in mid-tones, fades in shadows and highlights, and is 1.8% at 512 px but only dither-level (0.6%) on thumbnails. A 20% vignette. Chromatic aberration was left out because it did not help. |
| Backdrop | Seamless studio paper in the kit colour's family: saturation 0.25, luminance 0.015–0.06, a light pool, key spill, a floor sweep and faint mottling. It is dithered, so 8-bit output does not band. |

### Performance

Measured on the same machine. The host rebooted during the work, so part A could not be re-measured side by side; its figures below are the ones documented above.

- Warm CPU frame generation, 12 gallery players (Node): 330–340 ms with part B vs 331–344 ms for part A. The eye rig, lashes and tear line are about 22 ms of that. Camera orbits still run no CPU work beyond uniforms.
- GPU on SwiftShader, min–median of repeated runs over 4 players:
  - Orbit redraw at 256 px: 344–377 ms (part A 231–234 ms).
  - Orbit redraw at 512 px: 662–703 ms (part A 502–539 ms).
  - Full profile render at 256 px: 465–534 ms (part A 306–334 ms).
  - Full profile render at 512 px: 797–847 ms (part A 560–572 ms).
  - Orbit redraws are about 1.5–1.6× at 256 px and 1.3–1.4× at 512 px. Full renders are 1.4–1.7× at 256 px and 1.4–1.5× at 512 px.
- The extra cost is mostly fixed full-screen work: the 4× RGBA16F target, the resolve, the half-resolution depth-of-field pass and the composite. SwiftShader emulates it on the CPU, so it weighs most on small canvases. On a hardware GPU these passes should cost well under a millisecond (not measured here). Thumbnails already skip lashes and depth of field.

### Verify

- `npm test` includes `tests/gnm-player-eyes.test.mjs`. It covers sphere fits, the contact table, lid topology and canthi, and masks. For lashes it checks bounds, taper, root attachment and no penetration across 36,288 points (6 eye shapes × 4 expressions), plus tear-line contact. It also checks determinism, lash and iris-detail isolation and lash pigment rules. `tests/gnm-player-post.test.mjs` covers the thin-lens CoC, depth-of-field restraint, the PCG grain mirrored exactly in GLSL, the vignette and the paper backdrop.
- `tests/browser_smoke.py` checks the float16 4× MSAA pipeline. It forces the RGBA8 and direct fallbacks through init scripts and compares them with the float render. It also checks PNG export and that repeated renders give identical hashes.
- `tests/browser_feature_isolation.py` passes on both entry points ([pixel footprints](realism-v2/b-feature-isolation.json)). An iris-colour edit changes only iris pixels. The mapping-v2 nose edit moves eyeball and lid vertices by up to about 1 mm, and the lashes follow that geometry. Lash parameters depend only on the seed, the lid geometry and the hair colour.
- Re-capture with `python3 tools/gnm/capture_realism_closeups.py --output <png>`, adding `--mode eye-details` or `--mode post-details --size 768`.

### Limits

- **Lashes** are alpha-to-coverage ribbons, not fibres. They have no inter-lash shading beyond the key shadow map and disappear below about 1/8 px, where only the lash line remains.
- **The iris** is a flat procedural layer. The refraction parallax is faded at the limbus for stability, so the iris edge does not shift as it would through a real cornea. There are no caustics and no pupil response.
- **The tear line** is a thin static strip. In extreme three-quarter close-ups (2048 px renders) the far canthus still shows a one-pixel shadowed crease where the lid meets the eye. At grazing angles the sclera's tear film reflects the studio lobes as soft arcs.
- **Depth of field** is a single-layer gather. Blurred foreground does not spread over sharp background, which is barely visible at this strength.
- **The direct fallback** (no multisampled storage) has no MSAA and no post effects. RGBA8 targets band slightly more than RGBA16F before grain.
- **The green catalogue colour** stays fairly saturated, because hex values were kept and only structure was added.
- **SwiftShader timings** are CPU-emulated; GPU/driver pixel differences are expected.

## Realism v2, part A: lighting, shadows and skin

### Same-seed comparison

- Gallery (16 fixed players, same camera): [before](realism-v2/before-gallery.png) → [after](gallery.png). [Opposing trait labels](label-pairs.png).
- Close-ups (light, medium and dark skin; front, three-quarter and profile; 512 px): [before](realism-v2/before-closeups.png) → [after](realism-v2/a-after-closeups.png).
- [Lighting details](realism-v2/a-lighting-details.png): final render, key-light visibility, baked ambient occlusion and scattering curvature at front, three-quarter and profile yaw. It shows the nose shadow, the fringe shadow on the forehead, the jaw/chin shadow on the neck and ear shading.

The before/after gallery manifests are byte-identical: seeds, SF2 codes, identity coefficients, expressions and feature z-scores. The close-up JSON sidecars have identical codes, cameras and identity data. Only light and material response changed.

### Techniques

| Area | Implementation |
| --- | --- |
| Key light shadow | Depth map from the camera-mounted key light over a fixed world-space sphere (head, hair, glasses, bun, upper bust), re-rendered on the GPU per redraw: 2048² (1024² for thumbnails). Contact-hardening soft shadow (PCSS): 8-tap blocker search, then 16 or 32 rotated hardware-bilinear PCF taps. Each 2×2 pixel quad uses complementary rotations and is averaged. Normal-offset and slope-dependent bias; near the terminator self-shadowing is left to the diffuse falloff. |
| Casters | Skin clipped at the crew neck, hair shell, hair/beard/brow ribbons (key map only), glasses frames, bun and jersey. Corneas and lenses never cast. A smaller rim-light map (half size, 4-tap PCF) stops the back rim light from reaching surfaces it cannot see. |
| Ambient occlusion | Baked once per profile or geometry change, never on camera orbit. All opaque casters are rendered into 32 fixed world-space orthographic depth layers (192²). Each vertex (skin, eyes, mouth, hair shell, jersey, bun, frames) gathers cosine-weighted visibility into its own RGBA8 texel. One neighbour-averaging pass uses the source-mesh adjacency. The result stays on the GPU: the vertex shader fetches its texel and ribbons fetch their root's, so there is no readback stall. It covers hair, ears, jaw/neck and collar occlusion. The existing cavity term still adds finer creases. |
| AO use | Multi-bounce, albedo-tinted occlusion (Jimenez et al.) on the environment diffuse; specular occlusion (Lagarde) on the environment specular; softer gating of the rim light. |
| Environment | Procedural studio defined as spherical Gaussians in view space: fill softbox, ceiling, warm floor bounce, two rim strips and dark surroundings. It is projected once to L2 spherical harmonics for diffuse irradiance, and integrated analytically against a GGX-shaped lobe (split-sum BRDF fit) for specular. Corneas reflect the same studio. The directional fill and hemisphere ambient are gone. Key, fill and rim are rebalanced. |
| Skin diffuse | Pre-integrated subsurface scattering (Penner & Borshukov). A 64×64 LUT indexed by N·L and curvature is generated at start-up from the six-Gaussian skin profile of d'Eon & Luebke. Mean curvature per vertex comes from the reconstructed mesh in the same edge pass as the cavity term. The profile distances are scaled 3.5×, an artistic scale that keeps the effect visible at portrait size. Red follows the geometric normal, green/blue the detailed normal. It replaces the old wrap + red scatter. Penumbrae bleed slightly red; ears transmit the rim light. |
| Skin specular | Dual-lobe GGX (0.72× / 1.3× roughness, 25/75) with Schlick Fresnel, F0 0.028. The key highlight is widened by the softbox size and shadowed; environment specular with specular occlusion. |
| Regional variation | Masks use each vertex's static template position and official fields, so they stay attached to the surface. They cover redness on the nose, cheek apples, ears and perioral area, plus low-frequency mottling, periorbital darkening, a shaved-beard shadow and oilier T-zone vs rougher cheeks. Strengths depend only on seed, skin tone, age and presentation (for example, no beard shadow for feminine/neutral). Redness fades on darker tones and the under-eye tint shifts from violet to brown. |
| Tone mapping | ACES fit (Narkowicz) per channel below mid-grey, blending into the same curve applied to the peak channel (hue-preserving) above it. Pure per-channel ACES bleached the lightest tones towards porcelain. A pure luminance-based variant made medium/dark tones grey. The blend keeps both warm; see the tone-mapping note below. |

**Tone-mapping note:** close-ups compared three curves. Per-channel ACES desaturates bright skin: tone 0 highlights go from R/B ≈ 2.3 to ≈ 1.5. The hue-preserving variant alone turns medium/dark skin ashy, because it drops the saturation that per-channel ACES adds in the toe. The hybrid leaves medium and dark pixels exactly as per-channel ACES and removes the bleaching. The lightest tone therefore reads darker (face luminance ≈ 0.8× the previous capture) but no longer clips toward white. Medium is 0.91–0.94× and dark 1.05–1.10× of the previous capture.

### Performance

Measured on this machine (Ryzen 5 7600X). The host was busy with an unrelated multi-core job, so timings are noisy and minima are reported.

- Warm CPU frame generation, 12 gallery players: Node about 330–355 ms before and 331–344 ms after; Chromium 341–411 ms before and 342–381 ms after. Lighting adds only the shared curvature pass and seed-stable scalars, so the ratio is about 1.0×. Camera orbits run no CPU work beyond uniforms.
- One-time start-up: LUT about 10 ms, SH projection about 6 ms, AO adjacency about 6 ms.
- GPU on SwiftShader (the test harness):
  - Orbit redraw with both shadow maps: 256 px 137–169 → 231–234 ms; 512 px 288–324 → 502–539 ms (about 1.6–1.8×).
  - Full profile render: 256 px 166–199 → 306–334 ms; 512 px 288–364 → 560–572 ms (about 1.8–2×).
  - The AO bake itself is about 70–80 ms per profile on SwiftShader, and should be a few milliseconds on a GPU.
  - Twelve gallery thumbnails still return to JavaScript in about 0.45 s, because nothing reads back from the GPU.

### Verify

- `npm test` covers the LUT (normalized profile, Lambert at zero curvature, monotonic rows, red wrap, bounds), the SH projection/convolution and shader layout, and positive studio irradiance. It also covers SG integrals, curvature on spheres/planes (scale, sign, translation), the light matrices and AO directions, the smoothing adjacency and ribbon root texels. For regional variation it checks determinism and isolation from every non-skin control.
- `tests/browser_smoke.py` asserts complete shadow maps and AO bake, and that camera orbit never re-bakes AO.
- `tests/browser_feature_isolation.py` (both entry points) keeps every edit local with exact pixel round-trips ([pixel footprints](realism-v2/a-feature-isolation.json)).
- Re-capture against a local server with `python3 tools/gnm/capture_realism_closeups.py --output <png>`, adding `--mode lighting-details` for the debug views. The gallery is re-captured with `python3 tools/gnm/capture_player_gallery.py`.

### Limits

- **Ambient occlusion** is per vertex from 32 directions at about 3.75 mm texels. Creases smaller than that rely on the cavity term, and the coarse jersey mesh interpolates it broadly.
- **Soft shadows** use a filtered depth map, not area-light ray tracing. Zoomed penumbrae show 2×2 structure. The hair shell edge cast a fairly hard band under fringes; since part C, strands cast instead.
- **The skin** is a curvature LUT with an artistic scatter scale, not texture-space diffusion. There is no measured albedo map, and ear transmission is a heuristic. Specular has no anti-aliasing beyond the existing footprint filtering.
- **The lights** are camera-mounted, so shadows move with the view by design.
- **GPU/driver differences** in pixels are expected.
- A pre-existing painted-eyebrow field leaks into about five nostril pixels when the eyebrow style changes. This is unrelated to lighting and also present before.

## Earlier material pass

That pass reduced waxy skin, deepened facial creases and made the eyes more restrained. Before/after: [before](realism-before.png) → [after](realism-v2/before-gallery.png), which also includes the later grooming pass. It added a bounded normal-projected edge curvature cavity, softer highlights with footprint-filtered pore microrelief, and upper-lid contact shading. The cavity term remains in use for fine creases. See [crew-neck, aging and grooming evidence](DETAILS.md).
