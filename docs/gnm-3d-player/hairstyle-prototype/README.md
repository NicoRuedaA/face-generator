# Side-part hairstyle trial

One opt-in hairstyle adds an asymmetric swept crown, a recessed lateral part,
shorter sides, and directional strands. It reuses the reconstructed scalp and
existing WebGL resources; it is not a new imported hair asset or a full editor.

## Try it

Open either entry point through HTTP. Under **Prueba de peinado**, choose
**Raya lateral con volumen · prototipo**. **Pelo visible** must be **Sí**.
Choose **Peinado del perfil** to compare the same face with its original hair.
The selection applies to the portrait, gallery, and PNG export for this session.
It is deliberately not saved in FaceDNA/SF2 and resets on reload.

## Compatibility and limitations

The 12 existing hair IDs and seed mappings are unchanged. The extra render option
is allowlisted, respects hair visibility, and does not change head geometry,
identity coefficients, expression, or the facial code. No dependency was added.
The result is still procedural/sculpted: regular strand ridges remain visible,
and fitting has only been checked on three head configurations, not every face.
A production catalog still needs authored styles and broader fitting validation.

## Evidence

These first-trial captures predate the [hair-pattern correction](../hair-pattern-fix/README.md); see that comparison for the current material.

- [Baseline](baseline.png), [narrow/long](narrow.png), [broad/compact](broad.png):
  original medium hair above, prototype below; front and both profiles.
- [Diagnostics](diagnostics.json): 18 renders with matching SF2 and identity for
  each six-view group, complete framebuffers, and bounded grooming counts.
- Capture: `uv run --with playwright python3 /home/nico/.agents/skills/webapp-testing/scripts/with_server.py --server "python3 -m http.server 8080" --port 8080 -- python3 tools/gnm/capture_hairstyle_prototype.py`.
- Focused checks: `npm run test:model`, `npm run test:rendering`,
  `npm run test:gnm-player`; browser checks: `npm run test:browser-smoke`.

## Rollback boundary

Remove only the `hairstylePrototype` option/selector, `GNM_PLAYER_SIDE_PART`,
side-part-specific envelope/groom/shader branches, added prototype assertions,
and this capture script/evidence. Rebuild the bundle and refresh manifest/checksums.
Keep existing 3D-only routing, realism, aging, grooming and collar changes intact.
