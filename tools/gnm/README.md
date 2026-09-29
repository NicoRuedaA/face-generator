# GNM 3D player asset pipeline

The supported runtime is **Sports GNM 3D Player v1**. No 2D morphology renderer, prototype WebGL renderer or Basis Lab is shipped.

## Validate the retained runtime

```sh
npm run validate:gnm-player-generator
npm run validate:gnm-official-render
npm run test:gnm-player
```

Runtime assets in `work/`:

- `gnm-official-head-render.glb`: compact official geometry, with source vertex IDs.
- `gnm-player-generator.bin` and `.json`: identity directions, measured feature gradients, official expression presets and procedural appearance fields.
- `LICENSE-GNM.txt`: complete upstream license.

## Rebuild offline

The player builder needs a separate GNM checkout, NumPy and h5py. These are not browser dependencies.

```sh
GNM_ROOT=/path/to/GNM npm run build:gnm-player-generator
GNM_ROOT=/path/to/GNM python3 tools/gnm/test_player_generator.py
```

Official source import and render optimization remain available through `build:gnm-official`, `build:gnm-official-render` and their validators. Use each Python script's `--help` to override local source paths. The canonical GLB is managed by Git LFS and is not fetched by the application.

`capture_player_gallery.py` captures the retained player via Playwright against a running HTTP server. `capture_realism_closeups.py --output <png>` renders three fixed players (light/medium/dark skin) from front, three-quarter and profile cameras at 512 px for realism before/after comparisons; `--mode lighting-details` adds key-shadow, ambient-occlusion and curvature debug views. `--mode eye-details` crops the eyes from 2048 px renders (four iris colours, three skin tones, front/three-quarter and one expression each); `--mode post-details --size 768` compares post effects off and on, with depth-of-field and grain crops and 256 px thumbnails. `--mode hair-catalog` / `--mode hair-details` show the strand hairstyles, and `--mode grooming-catalog` / `--mode grooming-details` the strand beards and eyebrows. `diagnose_official_gnm_basis.py` remains an offline canonical-asset diagnostic, not a runtime renderer.

## Preserved source data

Existing source datasets, landmark maps, canonical geometry and provenance reports in `work/` are intentionally preserved. Older morphology/calibration reports are historical offline inputs/evidence, not supported runtime modes or current acceptance claims. Their retired 2D/Basis Lab builders and browser capture tools have been removed. No private NPZ/Numpy data or external GNM checkout is deleted.

See [player acceptance](../../docs/ACCEPTANCE_GNM_3D_PLAYER.md) for measured feature mapping and provenance, and [third-party notices](../../THIRD_PARTY_NOTICES.md) for attribution.
