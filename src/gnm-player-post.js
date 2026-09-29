/*
 * Sports Face GNM 3D player photographic post-processing
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * DOM/WebGL-free parameters of the final image pass, shared by the WebGL2
 * renderer and the tests:
 *
 * - thin-lens depth of field focused on the eyes (between the corneal apexes,
 *   weighted towards the nearer eye), scaled with the image height and
 *   disabled for thumbnails;
 * - deterministic, luminance-dependent film grain (an integer PCG hash of the
 *   pixel, the profile seed and the camera; the GLSL mirrors it exactly);
 * - a gentle vignette;
 * - the seamless studio-paper backdrop tinted by the kit colour.
 *
 * Nothing is random at run time: the same profile and camera always give the
 * same pixels.
 */

function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function smoothstep(edge0, edge1, value) { const t = clamp((value - edge0) / (edge1 - edge0), 0, 1); return t * t * (3 - 2 * t); }

export const GNM_PLAYER_POST = Object.freeze({
  version: "photographic-post-v1",
  /**
   * Blur radius in pixels is `blurScale * height * (1 - focus / distance)`:
   * about a 60 mm portrait lens at f/6.5 on a 24 mm-high sensor. Canvases
   * smaller than `minCanvas` (thumbnails) skip depth of field.
   */
  depthOfField: Object.freeze({ blurScale: 0.015, maxCocFraction: 0.006, minCanvas: 321, sharpCoc: 0.45, fullCoc: 1.25, taps: 24 }),
  /** Grain amplitude in display (sRGB) units at mid-tones; thumbnails keep only a dither-level grain. */
  grain: Object.freeze({ amplitude: 0.018, thumbnailAmplitude: 0.006, thumbnailCanvas: 320 }),
  vignette: Object.freeze({ strength: 0.2, power: 2.4 }),
  backdrop: Object.freeze({ model: "seamless-studio-paper", saturation: 0.25, minLuminance: 0.015, maxLuminance: 0.06 }),
});

/**
 * Signed circle-of-confusion radius in pixels (negative in front of the
 * focal plane), clamped to +/- maxCocPx.
 */
export function gnmPlayerCircleOfConfusion(distance, focusDistance, blurPx, maxCocPx) {
  if (!(distance > 0) || !(focusDistance > 0)) return 0;
  return clamp(blurPx * (1 - focusDistance / distance), -maxCocPx, maxCocPx);
}

/** Depth-of-field settings for a drawing buffer (pixels) focused at `focusDistance` (metres). */
export function gnmPlayerDepthOfField({ width, height, focusDistance, enabled = true }) {
  const config = GNM_PLAYER_POST.depthOfField;
  const active = Boolean(enabled) && Math.min(width, height) >= config.minCanvas && focusDistance > 0;
  return {
    enabled: active,
    focusDistance: active ? focusDistance : 0,
    blurPx: active ? config.blurScale * height : 0,
    maxCocPx: active ? config.maxCocFraction * height : 0,
  };
}

/** 32-bit PCG hash (Jarzynski & Olano 2020); the composite shader uses the same function. */
export function gnmPlayerPcgHash(value) {
  const state = (Math.imul(value >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/** Grain seed from the profile seed and the camera (rounded), so an orbit changes the grain but a redraw never does. */
export function gnmPlayerGrainSeed(seed, camera) {
  let hash = gnmPlayerPcgHash(seed >>> 0);
  for (const value of [camera.yaw, camera.pitch, camera.distance]) hash = gnmPlayerPcgHash((hash ^ (Math.round(value * 10000) | 0)) >>> 0);
  return hash >>> 0;
}

/** Triangular grain value in (-1, 1) for pixel (x, y); exact in float32, as in GLSL. */
export function gnmPlayerGrainValue(x, y, seed) {
  const first = gnmPlayerPcgHash((x + gnmPlayerPcgHash((y + seed) >>> 0)) >>> 0);
  const second = gnmPlayerPcgHash(first);
  return ((first >>> 8) + (second >>> 8)) / 16777216 - 1;
}

/** Grain weight for a display luminance: strongest in mid-tones, reduced in deep shadows and highlights. */
export function gnmPlayerGrainWeight(luminance) {
  return smoothstep(0, 0.18, luminance) * (1 - 0.75 * smoothstep(0.55, 1, luminance));
}

/** Grain amplitude for a drawing buffer: dither-level for thumbnails. */
export function gnmPlayerGrainAmplitude(width, height, enabled = true) {
  if (!enabled) return 0;
  const config = GNM_PLAYER_POST.grain;
  return Math.min(width, height) <= config.thumbnailCanvas ? config.thumbnailAmplitude : config.amplitude;
}

/** Vignette factor (linear light) for normalized coordinates u, v in [0, 1]. */
export function gnmPlayerVignette(u, v, aspect = 1, { strength, power } = GNM_PLAYER_POST.vignette) {
  const x = (u - 0.5) * aspect, y = v - 0.5;
  const radius = Math.hypot(x, y) / Math.hypot(0.5 * aspect, 0.5);
  return 1 - strength * radius ** power;
}

function srgbToLinear(value) { return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; }

/**
 * Linear albedo-like tint of the studio paper from the kit primary (sRGB 0..1):
 * the same colour family, desaturated and kept within a photographic
 * luminance range so white or black kits still give a lit, readable paper.
 */
export function gnmPlayerBackdropPaper(kitPrimary) {
  const { saturation, minLuminance, maxLuminance } = GNM_PLAYER_POST.backdrop;
  const linear = kitPrimary.map(srgbToLinear);
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  const tinted = linear.map((value) => luminance + (value - luminance) * saturation);
  const target = clamp(luminance, minLuminance, maxLuminance);
  const tintedLuminance = 0.2126 * tinted[0] + 0.7152 * tinted[1] + 0.0722 * tinted[2];
  // A black kit has no hue to keep: it gets a dark neutral paper.
  if (tintedLuminance < 1e-5) return [target, target, target].map((value) => Number(value.toFixed(6)));
  const scale = target / tintedLuminance;
  return tinted.map((value) => Number(Math.max(value * scale, 0).toFixed(6)));
}
