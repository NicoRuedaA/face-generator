# Changelog

## Unreleased — strand beards and eyebrows (realism v2, part D)

- Replace the painted brows, painted beard and short beard/brow ribbons with generated strands that walk the deformed skin (straightest geodesics across its triangles), so they follow every identity and expression and never go under the skin.
- Grow eyebrows with a real growth pattern from the official brow fields: head hairs up and slightly out, body hairs up and out converging from both edges, tail hairs out and down, lying close to the skin in layers with fine hairs and irregular sparse edges. All eight catalogue shapes (thickness, arch, peak, length, density, angular, low/high) stay recognisable, and the old brow paint no longer leaks into the nostrils.
- Grow beards by region (down on the cheeks, down and forward on the chin, down and out on the moustache, back and down on the neck) with soft, fading cheek lines and necklines, clumping, and a volume that lets the full beard's silhouette break the jawline. Stubble is dense 1 mm stubs plus a graded follicle darkening; goatee and moustache keep their shapes. Hair stops at the red lip, stays out of the mouth under every expression preset, off the nose and above the collar.
- Shade beards and brows with the scalp hair's fibre program (pigment-gated absorption, per-strand greying that keeps the model's beard and brow colours as the mean), strand shadows, root AO, alpha-to-coverage and the reduced tier for thumbnails. A per-vertex root density tints the skin faintly under the hair; `beard/none` keeps the presentation-gated beard shadow.
- Add `--mode grooming-catalog` and `--mode grooming-details` captures and `tests/gnm-player-facial-hair.test.mjs`. FaceDNA/SF2, identity, catalogue order and the gallery manifest are unchanged.

## Unreleased — strand-based scalp hair (realism v2, part C)

- Replace the helmet-like hair shell with generated strands for every catalogue style and the side-part prototype. Each style has a groom: a flow field with parting and crown whorl, lengths by region with fade gradients, guide curves, and clumped interpolated strands with frizz, curls or waves, baby hairs and flyaways. Braids are plaited fibres and the bun is wrapped strands.
- Keep strands outside the head, ears, neck, jersey and shoulders with per-frame collision proxies. Hanging hair climbs onto the ears and drapes over the front or back of the shoulders; short cuts are trimmed around the ears.
- Draw strands as tapered camera-facing ribbons with alpha-to-coverage on tips, a minimum pixel width, and wider ribbons where hair hangs away from the scalp. A painted root underlayer keeps dense hair opaque and shows scalp on buzz cuts and fades; partings are narrow and shaded.
- Shade hair with a Marschner-style model (shifted R, TT and TRT lobes, pigment absorption, darker roots, sun-lightened tips, per-strand greying). Strands cast soft, broken shadows into the key-light map and occlude the ambient-occlusion bake.
- Build a reduced strand tier (an exact prefix) for thumbnails and the direct fallback; strands are cached per profile, so camera orbits never regenerate them. Beard and brows are unchanged.
- Add hair catalogue and hair detail captures (`--mode hair-catalog`, `--mode hair-details`) and `tests/gnm-player-hair.test.mjs`. FaceDNA/SF2, identity, catalogue order and the gallery manifest are unchanged.

## Unreleased — eyes, lashes and photographic post-processing (realism v2, part B)

- Add seed-stable, clumped strand eyelashes rooted on the reconstructed lid margins. Upper and lower lashes are tapered and kept outside the eyeball and skin. They are drawn with alpha-to-coverage, cast soft key-light shadows and receive shadows and AO; sub-pixel lashes are skipped.
- Add a per-frame eye rig (sclera/cornea sphere fits, iris plane, lid contact table) with analytic eye occlusion, a wet tear line and a moist caruncle and lid margin.
- Replace the painted iris with a procedural one (radial fibres, crypts, collarette, limbal ring, optional central heterochromia) seen through a refractive cornea with key and fill catchlights. Catalogue colours, order and FaceDNA semantics are unchanged.
- Render into an offscreen 4× MSAA RGBA16F target, with RGBA8 and direct fallbacks reported in diagnostics. The final composite applies tone mapping, sRGB, eye-focused depth of field, deterministic grain and a gentle vignette.
- Replace the striped backdrop with seamless studio paper in the kit colour's family, and add eye-detail and post-processing evidence captures.

## Unreleased — lighting, shadows and skin (realism v2, part A)

- Add soft contact-hardening key-light shadows and rim-light shadows from per-redraw GPU depth maps; hair, ribbons, glasses, bun and jersey cast and receive.
- Bake per-profile ambient occlusion on the GPU from 32 fixed directional depth layers (never on camera orbit) and apply it to diffuse and specular ambient light.
- Replace the hemisphere ambient and directional fill with a procedural studio environment (L2 SH diffuse, spherical-Gaussian specular); switch highlights to hue-preserving ACES.
- Shade skin with a pre-integrated scattering LUT (d'Eon & Luebke profile), per-vertex curvature, dual-lobe GGX and seed-stable regional redness, periorbital, beard-shadow and T-zone variation.
- Add fixed close-up capture evidence (`tools/gnm/capture_realism_closeups.py`); FaceDNA/SF2, identity and catalog order are unchanged.

## Unreleased — crew neck, skin aging and grooming

- Replace the wide torso-cut neckline with a fitted closed ribbed crew neck, intersected against each reconstructed neck and backed by real garment geometry.
- Add age-progressive forehead, eye-corner, under-eye and nasolabial creases guided by facial landmarks; identity geometry stays unchanged.
- Add bounded tapered hair, beard and eyebrow ribbons; clumped scalp volume with recomputed normals, directional texture and softer grooming boundaries.
- Add fixed-pigment age captures, three skin tones and front/three-quarter/profile evidence.

## Unreleased — facial material realism

- Add bounded geometry-derived cavity shading around concave facial features, without changing GNM identity or vertex positions.
- Reduce waxy skin highlights and add subtle, footprint-filtered pore microrelief and roughness variation.
- Add upper-eyelid landmark contact shading, less luminous sclera/iris and restrained corneal highlights.
- Rebalance studio lighting; retain one WebGL2 context for gallery thumbnails and deterministic FaceDNA/SF2.

## Unreleased — 3D player only

- Promote Sports GNM 3D Player v1 to the sole default rendering path.
- Remove legacy 2D/SVG, prototype WebGL and Basis Lab implementations, galleries and obsolete tools.
- Preserve FaceDNA/SF2 compatibility, 3D thumbnails, camera, expressions and PNG export.
- Fail explicitly when WebGL2 or assets are unavailable; no alternate renderer or blank PNG export.
- Preserve official GNM geometry, offline source datasets and license provenance.

Earlier versions remain available in Git history.
