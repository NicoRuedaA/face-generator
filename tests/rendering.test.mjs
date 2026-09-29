import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createProfile } from "../src/face-model.js";
import { DEFAULT_RENDER_STYLE, GNM_PLAYER_RENDER_STYLE, RENDER_STYLES, describeRender, isRenderStyle, renderPortrait, renderPortraitThumbnail } from "../src/render-router.js";
import { sha256Bytes, parseWebglGlb } from "../src/gnm-assets.js";

assert.equal(DEFAULT_RENDER_STYLE, GNM_PLAYER_RENDER_STYLE);
assert.equal(RENDER_STYLES.length, 1);
assert.equal(RENDER_STYLES[0].label, "Sports GNM 3D Player v1");
const profile = createProfile({ seed: 42 });
assert.equal(describeRender(profile).renderer, GNM_PLAYER_RENDER_STYLE);
for (const style of ["sports/default-v2", "sports/toon-prototype", "sports/morph-v1", "sports/morph-gnm-v1", "sports/morph-webgl-v1", "sports/morph-webgl-official-v1", "sports/morph-webgl-official-basis-lab-v1"]) {
  assert.equal(isRenderStyle(style), false);
  assert.throws(() => renderPortrait(null, profile, { style }), /Unsupported renderer/);
}
await assert.rejects(renderPortrait(null, profile), /WebGL canvas is unavailable/);
const contexts = [];
await assert.rejects(renderPortrait({ getContext(type) { contexts.push(type); return null; } }, profile), /WebGL2 context is unavailable/);
assert.deepEqual(contexts, ["webgl2"], "no hidden 2D fallback");
await assert.rejects(renderPortraitThumbnail(null, profile), /document is unavailable/);
assert.throws(() => parseWebglGlb(new ArrayBuffer(0)), /header/);
const bytes = new TextEncoder().encode("3D player asset integrity");
const expected = createHash("sha256").update(bytes).digest("hex");
assert.equal(await sha256Bytes(bytes), expected);
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
try {
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  assert.equal(await sha256Bytes(bytes), expected);
} finally {
  if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
}
for (const entry of ["index.html", "index.module.html"]) {
  const html = fs.readFileSync(new URL(`../${entry}`, import.meta.url), "utf8");
  assert.equal((html.match(/<canvas /g) || []).length, 1);
  assert.ok(!html.includes('id="render-style"'));
  assert.ok(html.includes('id="render-status"'));
}
console.log("3D-only routing, unavailable-state, integrity and entrypoint tests passed");
