# Closed crew neck, skin aging and grooming

The sports jersey now fits around the neck base, age adds skin creases independently of gray hair, and grooming includes actual tapered strand geometry.

## Visual evidence

- [Before these changes: same 16 seeds](grooming-before.png)
- [After: same 16 seeds](realism-v2/before-gallery.png) (the current [gallery](gallery.png) also includes the later lighting pass)
- [Ages 22/40/60, three skin tones, grooming and orbit views](details/details.png)
- [Capture metadata](details/details.json)

The first three rows of the details sheet use the same bald, clean-shaven identity at three ages. Grooming pigment/recession age is explicitly fixed at 30 by a capture-only diagnostic control, so gray eyebrows cannot explain the wrinkle differences. The last two rows inspect medium/full-beard and curly/stubble styles from front, three-quarter and profile views. Identity coefficients remain equal across ages.

## Implementation

| Area | Behavior |
| --- | --- |
| Crew neck | A sloped plane intersects the actual reconstructed skin above the old wide torso cut. A closed 128-vertex ring has thickness, a ribbed band and a continuous shoulder/chest mesh. Covered torso skin is clipped below the collar. No logos are copied. |
| Aging | Landmark-guided forehead creases, eye-corner/under-eye lines and nasolabial folds gradually strengthen between ages 28 and 60. The shader changes microrelief and shading, not GNM identity vertices. |
| Grooming | Area-weighted roots are cached once. Tapered surface-following ribbons are capped at 1,500 scalp strands, 750 beard strands and 160 eyebrow strands. Directional base shading, tapered coverage and low-frequency clumped hair volume complement the ribbons. Shell normals are recomputed for the clumped surface. |

## Verification

`npm test` includes crew-neck fit, finite/closed geometry, strand budgets, shaved-style behavior, deterministic grooming, age-strength progression and unchanged identity/positions. Browser smoke covers both entrypoints, live shaders, camera, gallery thumbnails, PNG export, SF2 and failure states.

To recapture against a local HTTP server with Playwright and Chromium:

```sh
python3 tools/gnm/capture_player_details.py
python3 tools/gnm/capture_player_gallery.py --size 384
```

## Limits

Wrinkles are procedural material relief, not sculpted skin displacement. Hair remains a compact clumped envelope plus ribbons, not tens of thousands of simulated strands; long hair/braids and full beards remain approximate. The fit is a procedural sports bust, not cloth simulation. No external textures, paid services or additional dependencies were added. GPU/driver differences affect pixels.
