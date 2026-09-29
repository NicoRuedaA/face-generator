import assert from "node:assert/strict";
import fs from "node:fs";
import {
  GNM_PLAYER_POST,
  gnmPlayerBackdropPaper,
  gnmPlayerCircleOfConfusion,
  gnmPlayerDepthOfField,
  gnmPlayerGrainAmplitude,
  gnmPlayerGrainSeed,
  gnmPlayerGrainValue,
  gnmPlayerGrainWeight,
  gnmPlayerPcgHash,
  gnmPlayerVignette,
} from "../src/gnm-player-post.js";

const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected} (+/-${tolerance})`);

// --- Circle of confusion (thin lens): signed, monotonic, clamped, resolution-scaled. ---
const focus = 0.62;
assert.equal(gnmPlayerCircleOfConfusion(focus, focus, 40, 16), 0, "zero at the focal plane");
assert.ok(gnmPlayerCircleOfConfusion(0.6, focus, 40, 16) < 0, "negative in front of the focal plane");
assert.ok(gnmPlayerCircleOfConfusion(0.7, focus, 40, 16) > 0, "positive behind the focal plane");
let previous = -Infinity;
for (let distance = 0.5; distance <= 3; distance += 0.01) {
  const coc = gnmPlayerCircleOfConfusion(distance, focus, 40, 16);
  assert.ok(coc >= previous - 1e-12, "circle of confusion grows with distance");
  assert.ok(Math.abs(coc) <= 16, "clamped to the maximum radius");
  previous = coc;
}
assert.equal(gnmPlayerCircleOfConfusion(100, focus, 40, 16), 16, "the far backdrop takes the maximum blur");
assert.equal(gnmPlayerCircleOfConfusion(0, focus, 40, 16), 0, "degenerate depth is ignored");
near(gnmPlayerCircleOfConfusion(0.7, focus, 80, 1e9) / gnmPlayerCircleOfConfusion(0.7, focus, 40, 1e9), 2, 1e-12, "blur scales linearly with the blur scale");

// --- Depth-of-field settings: scale with resolution; off for thumbnails. ---
const { depthOfField } = GNM_PLAYER_POST;
const thumbnail = gnmPlayerDepthOfField({ width: 256, height: 256, focusDistance: focus });
assert.equal(thumbnail.enabled, false, "256 px thumbnails have no depth of field");
assert.equal(thumbnail.blurPx, 0);
const portrait = gnmPlayerDepthOfField({ width: 512, height: 512, focusDistance: focus });
const large = gnmPlayerDepthOfField({ width: 2048, height: 2048, focusDistance: focus });
assert.ok(portrait.enabled && large.enabled);
near(large.blurPx / portrait.blurPx, 4, 1e-12, "blur radius scales with the image height");
near(large.maxCocPx / portrait.maxCocPx, 4, 1e-12, "maximum radius scales with the image height");
assert.equal(gnmPlayerDepthOfField({ width: 512, height: 512, focusDistance: focus, enabled: false }).enabled, false, "capture switch disables it");
// Restraint at 512 px: face sharp, ears/back of the head slightly soft.
const coc512 = (depthOffset) => Math.abs(gnmPlayerCircleOfConfusion(focus + depthOffset, focus, portrait.blurPx, portrait.maxCocPx));
assert.ok(coc512(0.012) < depthOfField.sharpCoc && coc512(-0.02) < depthOfField.sharpCoc, "eyes, cheeks and nose tip stay sharp at 512 px");
assert.ok(coc512(0.09) > depthOfField.sharpCoc && coc512(0.09) < 2, "ears are only slightly soft at 512 px");
assert.ok(portrait.maxCocPx <= 0.01 * 512, "maximum blur is restrained");

// --- Grain: deterministic integer hash mirrored in GLSL, triangular, luminance-dependent. ---
assert.deepEqual([0, 1, 2, 12345, 0xffffffff].map(gnmPlayerPcgHash), [0, 1, 2, 12345, 0xffffffff].map(gnmPlayerPcgHash), "hash is pure");
assert.equal(gnmPlayerPcgHash(0), 129708002, "PCG hash reference value (must match the shader)");
assert.equal(gnmPlayerPcgHash(1), 2831084092, "PCG hash reference value (must match the shader)");
const camera = { yaw: 0.38, pitch: -0.06, distance: 1 };
const seed = gnmPlayerGrainSeed(12345, camera);
assert.equal(gnmPlayerGrainSeed(12345, { ...camera }), seed, "same profile seed and camera give the same grain");
assert.notEqual(gnmPlayerGrainSeed(12346, camera), seed, "another player gets another grain");
assert.notEqual(gnmPlayerGrainSeed(12345, { ...camera, yaw: 0.39 }), seed, "an orbit changes the grain");
let sum = 0, sumSquares = 0, minimum = Infinity, maximum = -Infinity;
const count = 256 * 256;
for (let y = 0; y < 256; y += 1) {
  for (let x = 0; x < 256; x += 1) {
    const value = gnmPlayerGrainValue(x, y, seed);
    assert.equal(value, gnmPlayerGrainValue(x, y, seed));
    sum += value; sumSquares += value * value;
    minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
  }
}
near(sum / count, 0, 0.01, "grain is zero-mean");
near(sumSquares / count, 1 / 6, 0.01, "triangular distribution (variance 1/6)");
assert.ok(minimum > -1 && maximum < 1, "grain stays within (-1, 1)");
let neighbours = 0;
for (let x = 0; x < 255; x += 1) neighbours += gnmPlayerGrainValue(x, 7, seed) * gnmPlayerGrainValue(x + 1, 7, seed);
assert.ok(Math.abs(neighbours / 255) < 0.03, "neighbouring pixels are uncorrelated");
assert.equal(gnmPlayerGrainWeight(0), 0, "no grain in pure black");
assert.ok(gnmPlayerGrainWeight(0.4) === 1 && gnmPlayerGrainWeight(0.95) < 0.35, "strongest in mid-tones, reduced in highlights");
assert.equal(gnmPlayerGrainAmplitude(256, 256), GNM_PLAYER_POST.grain.thumbnailAmplitude, "thumbnails keep dither-level grain");
assert.equal(gnmPlayerGrainAmplitude(512, 512), GNM_PLAYER_POST.grain.amplitude);
assert.equal(gnmPlayerGrainAmplitude(512, 512, false), 0);
assert.ok(GNM_PLAYER_POST.grain.amplitude < 0.03, "grain stays fine (under ~8 code values at mid-tones)");

// --- Vignette: gentle, radial, 1 at the centre. ---
assert.equal(gnmPlayerVignette(0.5, 0.5), 1);
near(gnmPlayerVignette(0, 0), 1 - GNM_PLAYER_POST.vignette.strength, 1e-12, "corner darkening equals the strength");
assert.ok(GNM_PLAYER_POST.vignette.strength <= 0.25, "vignette is gentle");
assert.ok(gnmPlayerVignette(0.5, 0.9) > gnmPlayerVignette(0.1, 0.9), "falls off towards the corners");
near(gnmPlayerVignette(0.2, 0.5, 2), gnmPlayerVignette(0.8, 0.5, 2), 1e-12, "symmetric");

// --- Studio paper: kit colour family, photographic luminance range. ---
const luminance = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
const { backdrop } = GNM_PLAYER_POST;
for (const kit of ["#27405f", "#b91c1c", "#16a34a", "#1d4ed8", "#ffffff", "#000000", "#f59e0b"]) {
  const srgb = [1, 3, 5].map((offset) => Number.parseInt(kit.slice(offset, offset + 2), 16) / 255);
  const paper = gnmPlayerBackdropPaper(srgb);
  assert.ok(paper.every((value) => Number.isFinite(value) && value >= 0), `${kit}: finite paper`);
  near(luminance(paper), Math.min(Math.max(luminance(srgb.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))), backdrop.minLuminance), backdrop.maxLuminance), 1e-4, `${kit}: paper luminance`);
  const dominant = srgb.indexOf(Math.max(...srgb));
  if (Math.max(...srgb) - Math.min(...srgb) > 0.2) assert.equal(paper.indexOf(Math.max(...paper)), dominant, `${kit}: same colour family`);
}
const grey = gnmPlayerBackdropPaper([1, 1, 1]);
assert.ok(Math.max(...grey) - Math.min(...grey) < 1e-6, "a white kit gives a neutral grey paper");

// --- Shader wiring: the renderer mirrors the pure helpers. ---
const source = fs.readFileSync(new URL("../src/gnm-player-renderer.js", import.meta.url), "utf8");
for (const constant of ["747796405u", "2891336453u", "277803737u"]) assert.ok(source.split(constant).length >= 3, `GLSL PCG constant ${constant} in the composite and lash-shadow shaders`);
assert.ok(source.includes("smoothstep(0.0, 0.18, luminance) * (1.0 - 0.75 * smoothstep(0.55, 1.0, luminance))"), "composite grain weight mirrors gnmPlayerGrainWeight");
assert.ok(source.includes("float radius = length((uv - 0.5) * vec2(aspect, 1.0)) / length(vec2(0.5 * aspect, 0.5));"), "composite vignette mirrors gnmPlayerVignette");
assert.ok(/const COMPOSITE_FRAGMENT[\s\S]*toSrgb\(tonemap\(scene\)\)/.test(source), "tone mapping and sRGB live in the final composite");
assert.ok(/uniform int uSceneEncoding;[\s\S]*vec3 encodeScene\(vec3 radiance\)/.test(source), "scene shaders output linear radiance through encodeScene");
assert.ok(!/color = vec4\(toSrgb\(tonemap\(/.test(source.split("const COMPOSITE_FRAGMENT")[0].split("const MESH_FRAGMENT")[1]), "the mesh shader no longer tone-maps its output directly");

console.log("PASS post: thin-lens CoC (sign, monotonic, clamp, resolution scaling, 512 px restraint, thumbnails off), deterministic triangular PCG grain mirrored in GLSL, vignette, studio paper colour family and luminance range");
