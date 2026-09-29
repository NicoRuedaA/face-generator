# Official GNM asset provenance

The sole runtime, Sports GNM 3D Player v1, uses the compact official GNM render geometry plus its own player-generator payload. The full canonical GLB remains an offline source asset.

## Retained assets

| Asset | Role |
| --- | --- |
| `tools/gnm/work/gnm-official-head.glb` | Canonical GNM geometry and identity/expression bases; Git LFS |
| `tools/gnm/work/gnm-official-head-render.glb` | Runtime geometry, UVs and source vertex mapping; no full bases |
| `tools/gnm/work/gnm-official-head-render.json` | Render optimization metadata and checksums |
| `tools/gnm/work/official-bundle.json` | Canonical source provenance |
| `tools/gnm/work/official-render-bundle.json` | Render asset provenance |
| `tools/gnm/work/LICENSE-GNM.txt` | Full Apache-2.0 license |

The render geometry retains exact float32 position/UV values, six official components and source vertex IDs. No official textures are distributed. Runtime appearance is procedural.

## Verify

```sh
npm run test:gnm-canonical-asset
npm run test:gnm-official-render
npm run test:gnm-official-basis
npm run validate:gnm-player-generator
```

Tests that require the full canonical LFS object or external upstream NPZ report a skip when those inputs are absent. A skip is not reconstruction proof. The compact committed runtime payload is validated independently.

See [3D player acceptance](ACCEPTANCE_GNM_3D_PLAYER.md) for identity/feature mapping and exact upstream hashes, and [third-party notices](../THIRD_PARTY_NOTICES.md) for attribution and the recorded project-owner noncommercial scope.
