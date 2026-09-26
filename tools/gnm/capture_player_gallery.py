#!/usr/bin/env python3
"""Capture reproducible visual evidence for the GNM 3D player generator.

Renders fixed FaceDNA seeds with `sports/gnm-3d-player-v1` in a real browser
(Playwright + Chromium WebGL2) and writes:

* `gallery.png`: a contact sheet of generated players;
* `label-pairs.png`: the same base players with contrasting FaceDNA labels
  (e.g. nose/wide vs nose/narrow) to show measured-feature control;
* `manifest.json`: seeds, SF2 codes, targets, realized feature z-scores and
  identity diagnostics for every tile.

Requires a local HTTP server at the repository root (for example
`python3 -m http.server 8080`). Evidence only; not part of `npm test`.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = ROOT / "docs/gnm-3d-player"
GALLERY_SEEDS = ("gnm3d-001", "gnm3d-002", "gnm3d-003", "gnm3d-004", "gnm3d-005", "gnm3d-006", "gnm3d-007", "gnm3d-008",
                 "gnm3d-009", "gnm3d-010", "gnm3d-011", "gnm3d-012", "gnm3d-013", "gnm3d-014", "gnm3d-015", "gnm3d-016")
PAIRS = (
    ("nose", 1, 2, "noseWidth", "nose/wide vs nose/narrow"),
    ("jaw", 4, 0, "jawWidth", "jaw/very-broad vs jaw/very-narrow"),
    ("faceProportion", 4, 0, "faceHeight", "ratio/very-long vs ratio/compact"),
    ("mouth", 3, 4, "lipThickness", "mouth/full vs mouth/thin"),
    ("eyes", 1, 3, "eyeOpening", "eyes/round vs eyes/narrow"),
    ("earShape", 2, 1, "earHeight", "ears/large vs ears/small"),
)

SCRIPT = """
async ({ gallerySeeds, pairs, size }) => {
  const model = await import('./src/face-model.js');
  const router = await import('./src/render-router.js');
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  document.body.append(canvas);
  const presentations = ['masculine', 'feminine', 'neutral'];
  async function render(profile) {
    const result = await router.renderPortrait(canvas, profile, { style: 'sports/gnm-3d-player-v1', expressionMode: 'auto', camera: { yaw: 0.38, pitch: -0.06, distance: 1 } });
    if (result.fallback) throw new Error('fallback: ' + result.reason);
    const d = result.diagnostics;
    return { image: canvas.toDataURL('image/png'), diagnostics: { maxAbsIdentityCoefficient: d.maxAbsIdentityCoefficient, featureTargets: d.featureTargets, identityFeatureZ: d.identityFeatureZ, expression: d.expression, appearance: d.appearance } };
  }
  async function sheet(tiles, columns, labels) {
    const rows = Math.ceil(tiles.length / columns);
    const out = document.createElement('canvas');
    out.width = columns * size; out.height = rows * size + (labels ? rows * 26 : 0);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#0b1017'; ctx.fillRect(0, 0, out.width, out.height);
    for (let index = 0; index < tiles.length; index += 1) {
      const image = new Image();
      image.src = tiles[index];
      await image.decode();
      const x = (index % columns) * size;
      const y = Math.floor(index / columns) * (size + (labels ? 26 : 0));
      ctx.drawImage(image, x, y, size, size);
      if (labels) { ctx.fillStyle = '#e2e8f0'; ctx.font = '15px sans-serif'; ctx.fillText(labels[index], x + 8, y + size + 18); }
    }
    return out.toDataURL('image/png');
  }
  const gallery = [];
  for (let index = 0; index < gallerySeeds.length; index += 1) {
    const profile = model.createProfile({ seed: gallerySeeds[index], age: 18 + ((index * 5) % 19), presentation: presentations[index % 3] });
    const rendered = await render(profile);
    gallery.push({ seed: gallerySeeds[index], code: model.formatFaceCode(profile), image: rendered.image, ...rendered.diagnostics });
  }
  const pairTiles = [];
  const pairRecords = [];
  const pairLabels = [];
  for (const [trait, high, low, feature, label] of pairs) {
    const base = model.createProfile({ seed: `gnm3d-pair-${trait}`, age: 25, presentation: 'neutral' });
    const record = { trait, label, feature, high: {}, low: {} };
    for (const [key, value] of [['high', high], ['low', low]]) {
      const profile = model.setFeature(base, trait, value);
      const rendered = await render(profile);
      pairTiles.push(rendered.image);
      pairLabels.push(`${model.ASSET_CATALOGS[trait][value]}  z=${rendered.diagnostics.identityFeatureZ[feature].toFixed(2)}`);
      record[key] = { code: model.formatFaceCode(profile), asset: model.ASSET_CATALOGS[trait][value], realizedZ: rendered.diagnostics.identityFeatureZ[feature] };
    }
    pairRecords.push(record);
  }
  return {
    gallery: await sheet(gallery.map((item) => item.image), 4, null),
    pairs: await sheet(pairTiles, 4, pairLabels),
    records: gallery.map(({ image, ...rest }) => rest),
    pairRecords,
    userAgent: navigator.userAgent,
  };
}
"""


def decode(data_url: str) -> bytes:
    return base64.b64decode(data_url.split(",", 1)[1])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:8080/index.module.html")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--size", type=int, default=256)
    parser.add_argument("--chromium", default=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"))
    args = parser.parse_args(argv)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=args.chromium, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 900, "height": 700})
        page.route("**/favicon.ico", lambda route: route.fulfill(status=204, body=""))
        page.goto(args.url)
        page.wait_for_load_state("networkidle")
        result = page.evaluate(SCRIPT, {"gallerySeeds": list(GALLERY_SEEDS), "pairs": [list(pair) for pair in PAIRS], "size": args.size})
        browser.close()
    (args.output_dir / "gallery.png").write_bytes(decode(result["gallery"]))
    (args.output_dir / "label-pairs.png").write_bytes(decode(result["pairs"]))
    ordered = all((pair["high"]["realizedZ"] > pair["low"]["realizedZ"]) for pair in result["pairRecords"])
    manifest = {
        "schema": "sports-face-gnm-3d-player-evidence/v1",
        "renderer": "sports/gnm-3d-player-v1",
        "camera": {"yaw": 0.38, "pitch": -0.06, "distance": 1},
        "tileSize": args.size,
        "gallery": result["records"],
        "labelPairs": result["pairRecords"],
        "labelPairsOrdered": ordered,
        "note": "Qualitative evidence rendered with WebGL2 (SwiftShader in headless CI-like environments). Pixel output depends on the GPU/driver; the manifest values are deterministic.",
    }
    (args.output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{'PASS' if ordered else 'FAIL'} GNM 3D player evidence: {len(result['records'])} players, {len(result['pairRecords'])} label pairs -> {args.output_dir}")
    return 0 if ordered else 1


if __name__ == "__main__":
    raise SystemExit(main())
