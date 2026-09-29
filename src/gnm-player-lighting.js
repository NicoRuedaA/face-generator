/*
 * Sports Face GNM 3D player lighting model
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * DOM/WebGL-free lighting data shared by the WebGL2 renderer and the tests:
 *
 * - a procedural, camera-mounted studio environment made of spherical
 *   Gaussian (SG) lobes, projected to L2 spherical harmonics for diffuse
 *   irradiance and integrated analytically against a roughness lobe for
 *   specular;
 * - the pre-integrated skin diffusion LUT (Penner & Borshukov 2011) built
 *   from the six-Gaussian skin profile published by d'Eon & Luebke (2007);
 * - per-vertex mean curvature and the local cavity term;
 * - the fixed world-space light volume and projections shared by the key
 *   light shadow map and the multi-direction ambient-occlusion bake;
 * - seed-stable regional skin variation.
 *
 * Everything is generated in code: no textures, HDRIs or downloaded assets.
 */

import { getFaceValues, hashSeed, Randomizer } from "./face-model.js";
import { GNM_PLAYER_SKIN_TONES } from "./gnm-player-model.js";

function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}
function freezeVector(vector) { return Object.freeze(vector.map((value) => Number(value.toFixed(6)))); }

/* ------------------------------------------------------------------------ */
/* Studio rig                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Camera-mounted (view-space) studio. The key and rim lights are shadowed
 * direct lights; the fill softbox, floor bounce, ceiling, rim strips and the
 * dark surroundings form the environment. Colors are linear radiance scales.
 */
export const GNM_PLAYER_STUDIO = Object.freeze({
  space: "view",
  key: Object.freeze({ direction: freezeVector(normalize([-0.45, 0.62, 0.64])), color: Object.freeze([1.28, 1.2, 1.1]), angularRadiusTan: 0.14 }),
  rim: Object.freeze({ direction: freezeVector(normalize([0.35, 0.55, -0.76])), color: Object.freeze([0.52, 0.55, 0.58]) }),
  environment: Object.freeze({
    ambient: Object.freeze([0.02, 0.021, 0.025]),
    lobes: Object.freeze([
      Object.freeze({ name: "fill-softbox", axis: freezeVector(normalize([0.78, 0.1, 0.62])), sharpness: 4.5, color: Object.freeze([0.7, 0.74, 0.84]) }),
      Object.freeze({ name: "ceiling", axis: freezeVector(normalize([0, 1, 0.2])), sharpness: 1.6, color: Object.freeze([0.16, 0.165, 0.18]) }),
      Object.freeze({ name: "floor-bounce", axis: freezeVector(normalize([0, -1, 0.45])), sharpness: 2.2, color: Object.freeze([0.12, 0.095, 0.075]) }),
      Object.freeze({ name: "rim-strip-left", axis: freezeVector(normalize([-0.8, 0.25, -0.55])), sharpness: 9, color: Object.freeze([0.3, 0.315, 0.34]) }),
      Object.freeze({ name: "rim-strip-right", axis: freezeVector(normalize([0.82, 0.3, -0.5])), sharpness: 9, color: Object.freeze([0.3, 0.315, 0.34]) }),
    ]),
  }),
});

/** Spherical Gaussian value: color * exp(sharpness * (dot(axis, direction) - 1)). */
export function sphericalGaussian(lobe, direction) {
  const cosine = lobe.axis[0] * direction[0] + lobe.axis[1] * direction[1] + lobe.axis[2] * direction[2];
  const weight = Math.exp(lobe.sharpness * (cosine - 1));
  return [lobe.color[0] * weight, lobe.color[1] * weight, lobe.color[2] * weight];
}

/** Radiance of the procedural studio environment towards a unit (view-space) direction. */
export function studioEnvironmentRadiance(direction, environment = GNM_PLAYER_STUDIO.environment) {
  const result = [...environment.ambient];
  for (const lobe of environment.lobes) {
    const value = sphericalGaussian(lobe, direction);
    result[0] += value[0]; result[1] += value[1]; result[2] += value[2];
  }
  return result;
}

/** Integral over the sphere of a spherical Gaussian with unit amplitude. */
export function sphericalGaussianIntegral(sharpness) {
  return (2 * Math.PI / sharpness) * (1 - Math.exp(-2 * sharpness));
}

/* ------------------------------------------------------------------------ */
/* Spherical harmonics                                                      */
/* ------------------------------------------------------------------------ */

const SH_C0 = 0.282095;
const SH_C1 = 0.488603;
const SH_C2 = 1.092548;
const SH_C3 = 0.315392;
const SH_C4 = 0.546274;
/** Cosine-lobe convolution per band (Ramamoorthi & Hanrahan 2001). */
export const SH_COSINE_BANDS = Object.freeze([Math.PI, (2 * Math.PI) / 3, Math.PI / 4]);
const SH_BAND = Object.freeze([0, 1, 1, 1, 2, 2, 2, 2, 2]);

/** Real L2 spherical-harmonic basis (9 values) for a unit direction. */
export function shBasis9(direction) {
  const [x, y, z] = direction;
  return [SH_C0, SH_C1 * y, SH_C1 * z, SH_C1 * x, SH_C2 * x * y, SH_C2 * y * z, SH_C3 * (3 * z * z - 1), SH_C2 * x * z, SH_C4 * (x * x - y * y)];
}

/** Deterministic, near-uniform unit directions (spherical Fibonacci lattice, y is the polar axis). */
export function fibonacciSphere(count) {
  if (!Number.isInteger(count) || count < 1) throw new Error("fibonacciSphere needs a positive integer count");
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: count }, (_, index) => {
    const y = 1 - (2 * index + 1) / count;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = index * golden;
    return [radius * Math.cos(angle), y, radius * Math.sin(angle)];
  });
}

/** Project an RGB radiance function to L2 SH (27 values, coefficient-major RGB). */
export function projectRadianceToSh9(radiance, sampleCount = 8192) {
  const coefficients = new Float64Array(27);
  const weight = (4 * Math.PI) / sampleCount;
  for (const direction of fibonacciSphere(sampleCount)) {
    const value = radiance(direction);
    const basis = shBasis9(direction);
    for (let index = 0; index < 9; index += 1) {
      for (let channel = 0; channel < 3; channel += 1) coefficients[index * 3 + channel] += value[channel] * basis[index] * weight;
    }
  }
  return coefficients;
}

/** Convolve radiance SH with the clamped cosine lobe: the result evaluates to irradiance. */
export function convolveShIrradiance(coefficients) {
  return Float64Array.from(coefficients, (value, index) => value * SH_COSINE_BANDS[SH_BAND[Math.floor(index / 3)]]);
}

/** Evaluate SH (27 values) in a unit direction. */
export function evaluateSh9(coefficients, direction) {
  const basis = shBasis9(direction);
  const result = [0, 0, 0];
  for (let index = 0; index < 9; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) result[channel] += coefficients[index * 3 + channel] * basis[index];
  }
  return result;
}

/**
 * Shader-ready diffuse SH: irradiance / pi (so `albedo * value` is outgoing
 * radiance) with the basis constants folded in, in the GLSL evaluation order
 * c0 + c1 y + c2 z + c3 x + c4 xy + c5 yz + c6 (3z^2 - 1) + c7 xz + c8 (x^2 - y^2).
 */
export function shaderShDiffuse(coefficients) {
  const constants = [SH_C0, SH_C1, SH_C1, SH_C1, SH_C2, SH_C2, SH_C3, SH_C2, SH_C4];
  const irradiance = convolveShIrradiance(coefficients);
  return Float32Array.from(irradiance, (value, index) => (value * constants[Math.floor(index / 3)]) / Math.PI);
}

let studioCache = null;

/** Cached shader inputs for the studio rig (SH diffuse, SG lobes, direct lights). */
export function gnmPlayerStudioLighting() {
  if (!studioCache) {
    const environment = GNM_PLAYER_STUDIO.environment;
    const sh = projectRadianceToSh9((direction) => studioEnvironmentRadiance(direction, environment));
    studioCache = Object.freeze({
      shDiffuse: shaderShDiffuse(sh),
      shRadiance: sh,
      lobeAxes: Float32Array.from(environment.lobes.flatMap((lobe) => [...lobe.axis, lobe.sharpness])),
      lobeColors: Float32Array.from(environment.lobes.flatMap((lobe) => lobe.color)),
      ambient: Float32Array.from(environment.ambient),
      key: GNM_PLAYER_STUDIO.key,
      rim: GNM_PLAYER_STUDIO.rim,
    });
  }
  return studioCache;
}

/* ------------------------------------------------------------------------ */
/* Pre-integrated skin diffusion                                            */
/* ------------------------------------------------------------------------ */

/**
 * Six-Gaussian skin diffusion profile (variance in mm^2, RGB weights), from
 * d'Eon & Luebke, "Advanced Techniques for Realistic Real-Time Skin
 * Rendering", GPU Gems 3 (2007). Each Gaussian is 2D-normalized.
 */
export const GNM_PLAYER_SKIN_PROFILE = Object.freeze([
  Object.freeze({ variance: 0.0064, weights: Object.freeze([0.233, 0.455, 0.649]) }),
  Object.freeze({ variance: 0.0484, weights: Object.freeze([0.1, 0.336, 0.344]) }),
  Object.freeze({ variance: 0.187, weights: Object.freeze([0.118, 0.198, 0]) }),
  Object.freeze({ variance: 0.567, weights: Object.freeze([0.113, 0.007, 0.007]) }),
  Object.freeze({ variance: 1.99, weights: Object.freeze([0.358, 0.004, 0]) }),
  Object.freeze({ variance: 7.41, weights: Object.freeze([0.078, 0, 0]) }),
]);
/** LUT layout: u = N.L * 0.5 + 0.5, v = curvature / maxCurvature (1/mm), sqrt-encoded RGBA8. */
export const GNM_PLAYER_SKIN_LUT = Object.freeze({ size: 64, maxCurvaturePerMm: 1.0, encoding: "sqrt-rgba8", samples: 96 });

function ringKernels(curvature, samples, profile) {
  // One quadrature per Gaussian over x in [-X, X], where the ring distance
  // 2 r sin(x / 2) stays below ~6 sigma (or the whole ring).
  const radius = 1 / curvature;
  return profile.map(({ variance }) => {
    const sigma = Math.sqrt(variance);
    const extent = Math.min(Math.PI, 6 * sigma * curvature * 1.05);
    const step = (2 * extent) / (samples - 1);
    const cosines = new Float64Array(samples);
    const sines = new Float64Array(samples);
    const kernel = new Float64Array(samples);
    let normalization = 0;
    for (let index = 0; index < samples; index += 1) {
      const x = -extent + index * step;
      const distance = 2 * radius * Math.sin(Math.abs(x) / 2);
      const trapezoid = index === 0 || index === samples - 1 ? 0.5 : 1;
      kernel[index] = (trapezoid * step * Math.exp((-distance * distance) / (2 * variance))) / (2 * Math.PI * variance);
      cosines[index] = Math.cos(x);
      sines[index] = Math.sin(x);
      normalization += kernel[index];
    }
    return { cosines, sines, kernel, normalization };
  });
}

function integrateRing(kernels, cosTheta, sinTheta, profile) {
  const result = [0, 0, 0];
  const normalization = [0, 0, 0];
  kernels.forEach((entry, gaussian) => {
    let integral = 0;
    for (let index = 0; index < entry.kernel.length; index += 1) {
      const cosine = cosTheta * entry.cosines[index] - sinTheta * entry.sines[index];
      if (cosine > 0) integral += entry.kernel[index] * cosine;
    }
    for (let channel = 0; channel < 3; channel += 1) {
      const weight = profile[gaussian].weights[channel];
      result[channel] += weight * integral;
      normalization[channel] += weight * entry.normalization;
    }
  });
  return result.map((value, channel) => (normalization[channel] > 0 ? value / normalization[channel] : Math.max(cosTheta, 0)));
}

/**
 * Pre-integrated diffuse falloff D(theta, r) = int cos+(theta + x) R(2 r sin(x/2)) dx
 * / int R(2 r sin(x/2)) dx for a ring of curvature 1/r (1/mm). Curvature 0 is
 * exactly the Lambert term.
 */
export function preintegratedSkinDiffuse(cosTheta, curvaturePerMm, { samples = GNM_PLAYER_SKIN_LUT.samples, profile = GNM_PLAYER_SKIN_PROFILE } = {}) {
  const cosine = clamp(cosTheta, -1, 1);
  if (!(curvaturePerMm > 1e-6)) return [Math.max(cosine, 0), Math.max(cosine, 0), Math.max(cosine, 0)];
  return integrateRing(ringKernels(curvaturePerMm, samples, profile), cosine, Math.sqrt(1 - cosine * cosine), profile);
}

/** Build the skin LUT (size x size RGBA8, sqrt-encoded) indexed by N.L (u) and curvature (v). */
export function buildGnmPlayerSkinLut({ size = GNM_PLAYER_SKIN_LUT.size, maxCurvaturePerMm = GNM_PLAYER_SKIN_LUT.maxCurvaturePerMm, samples = GNM_PLAYER_SKIN_LUT.samples } = {}) {
  const data = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    const curvature = (row / (size - 1)) * maxCurvaturePerMm;
    const kernels = curvature > 1e-6 ? ringKernels(curvature, samples, GNM_PLAYER_SKIN_PROFILE) : null;
    for (let column = 0; column < size; column += 1) {
      const cosine = (column / (size - 1)) * 2 - 1;
      const value = kernels
        ? integrateRing(kernels, cosine, Math.sqrt(Math.max(0, 1 - cosine * cosine)), GNM_PLAYER_SKIN_PROFILE)
        : [Math.max(cosine, 0), Math.max(cosine, 0), Math.max(cosine, 0)];
      const offset = (row * size + column) * 4;
      for (let channel = 0; channel < 3; channel += 1) data[offset + channel] = Math.round(Math.sqrt(clamp(value[channel], 0, 1)) * 255);
      data[offset + 3] = 255;
    }
  }
  return { size, maxCurvaturePerMm, encoding: GNM_PLAYER_SKIN_LUT.encoding, data };
}

let skinLutCache = null;
/** The default LUT, generated once per page. */
export function gnmPlayerSkinLut() {
  if (!skinLutCache) skinLutCache = buildGnmPlayerSkinLut();
  return skinLutCache;
}

/* ------------------------------------------------------------------------ */
/* Surface curvature                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Per-vertex surface terms from one pass over triangle edges:
 * - `cavity`: the bounded normal-projected edge average (scale invariant,
 *   0 on planar/convex surfaces) used for fine crease occlusion;
 * - `curvature`: signed mean curvature in 1/m (positive when convex), from
 *   -2 (e . n) / |e|^2 per incident edge, smoothed once over the 1-ring.
 */
export function computeGnmPlayerSurfaceTerms(positions, normals, triangles) {
  const count = positions.length / 3;
  const cavitySum = new Float64Array(count);
  const curvatureSum = new Float64Array(count);
  const weights = new Uint32Array(count);
  for (let index = 0; index < triangles.length; index += 3) {
    for (let edge = 0; edge < 3; edge += 1) {
      const a = triangles[index + edge], b = triangles[index + (edge + 1) % 3];
      const x = positions[b * 3] - positions[a * 3];
      const y = positions[b * 3 + 1] - positions[a * 3 + 1];
      const z = positions[b * 3 + 2] - positions[a * 3 + 2];
      const lengthSquared = x * x + y * y + z * z;
      if (lengthSquared < 1e-18) continue;
      const length = Math.sqrt(lengthSquared);
      const alongA = x * normals[a * 3] + y * normals[a * 3 + 1] + z * normals[a * 3 + 2];
      const alongB = x * normals[b * 3] + y * normals[b * 3 + 1] + z * normals[b * 3 + 2];
      cavitySum[a] += alongA / length;
      cavitySum[b] -= alongB / length;
      curvatureSum[a] -= (2 * alongA) / lengthSquared;
      curvatureSum[b] += (2 * alongB) / lengthSquared;
      weights[a] += 1; weights[b] += 1;
    }
  }
  const cavity = new Float32Array(count);
  const raw = new Float64Array(count);
  for (let vertex = 0; vertex < count; vertex += 1) {
    const weight = Math.max(weights[vertex], 1);
    cavity[vertex] = clamp((cavitySum[vertex] / weight - 0.015) * 3.0, 0, 1);
    raw[vertex] = curvatureSum[vertex] / weight;
  }
  const curvature = new Float32Array(smoothVertexValues(raw, triangles, 1));
  return { cavity, curvature };
}

/** Uniform 1-ring averaging (vertex plus edge neighbours), `iterations` times. */
export function smoothVertexValues(values, triangles, iterations = 1) {
  let current = Float64Array.from(values);
  const count = current.length;
  for (let pass = 0; pass < iterations; pass += 1) {
    const sum = Float64Array.from(current);
    const weight = new Float64Array(count).fill(1);
    for (let index = 0; index < triangles.length; index += 3) {
      for (let edge = 0; edge < 3; edge += 1) {
        const a = triangles[index + edge], b = triangles[index + (edge + 1) % 3];
        if (a === b) continue;
        sum[a] += current[b]; weight[a] += 1;
        sum[b] += current[a]; weight[b] += 1;
      }
    }
    for (let vertex = 0; vertex < count; vertex += 1) sum[vertex] /= weight[vertex];
    current = sum;
  }
  return current;
}

/* ------------------------------------------------------------------------ */
/* Fixed light volume, shadow and ambient-occlusion projections             */
/* ------------------------------------------------------------------------ */

/**
 * World-space sphere that bounds every visible caster/receiver (head, hair,
 * glasses, bun and the upper bust) for all profiles. It is profile
 * independent, so local edits only change shadows/AO where geometry changes.
 */
export const GNM_PLAYER_LIGHT_VOLUME = Object.freeze({ center: Object.freeze([0, 0.2, 0]), radius: 0.36 });
/** Key-light shadow map and ambient-occlusion bake parameters. */
export const GNM_PLAYER_SHADOW = Object.freeze({ technique: "pcss-pcf-depth-map", size: 2048, smallCanvasSize: 1024, filter: "pcss: 8-tap blocker search, 16/32-tap rotated bilinear PCF, 2x2 quad average" });
export const GNM_PLAYER_AMBIENT_OCCLUSION = Object.freeze({ technique: "gpu-multi-direction-depth-maps", directions: 32, size: 192, targetWidth: 256, strandRootFactor: 0.55 });

/** Branchless orthonormal basis around a unit vector (Duff et al. 2017); mirrored in GLSL. */
export function orthonormalBasis(normal) {
  const [x, y, z] = normal;
  const sign = z >= 0 ? 1 : -1;
  const a = -1 / (sign + z);
  const b = x * y * a;
  return { tangent: [1 + sign * x * x * a, sign * b, -sign * x], bitangent: [b, sign + y * y * a, -y] };
}

/**
 * Orthographic light clip matrix (column-major) for a unit direction pointing
 * from the scene towards the light. Clip xy spans the light volume; clip z
 * grows away from the light, so stored depth = 0.5 - 0.5 * dot(p - c, L) / R.
 */
export function buildGnmPlayerLightMatrix(direction, volume = GNM_PLAYER_LIGHT_VOLUME) {
  const light = normalize(direction);
  const { tangent, bitangent } = orthonormalBasis(light);
  const [cx, cy, cz] = volume.center;
  const scale = 1 / volume.radius;
  const row = (axis, sign) => [axis[0] * scale * sign, axis[1] * scale * sign, axis[2] * scale * sign, -sign * (axis[0] * cx + axis[1] * cy + axis[2] * cz) * scale];
  const rows = [row(tangent, 1), row(bitangent, 1), row(light, -1), [0, 0, 0, 1]];
  const matrix = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) for (let r = 0; r < 4; r += 1) matrix[column * 4 + r] = rows[r][column];
  return matrix;
}

/** Transform a view-space direction to world space with a column-major view matrix (rotation only). */
export function viewDirectionToWorld(view, direction) {
  // The view rotation is orthonormal: world = transpose(R) * viewDirection.
  return normalize([
    view[0] * direction[0] + view[1] * direction[1] + view[2] * direction[2],
    view[4] * direction[0] + view[5] * direction[1] + view[6] * direction[2],
    view[8] * direction[0] + view[9] * direction[1] + view[10] * direction[2],
  ]);
}

/** The fixed, world-space ambient-occlusion directions (uniform over the sphere). */
export function gnmPlayerAoDirections(count = GNM_PLAYER_AMBIENT_OCCLUSION.directions) {
  return fibonacciSphere(count);
}

/**
 * Cosine-weighted visibility from per-direction visibilities (0..1): the
 * CPU reference of the GPU gather, used by the tests.
 */
export function cosineWeightedVisibility(normal, directions, visibility) {
  let sum = 0;
  let weight = 0;
  directions.forEach((direction, index) => {
    const cosine = normal[0] * direction[0] + normal[1] * direction[1] + normal[2] * direction[2];
    if (cosine <= 0) return;
    sum += cosine * clamp(visibility[index], 0, 1);
    weight += cosine;
  });
  return weight > 0 ? sum / weight : 1;
}

/* ------------------------------------------------------------------------ */
/* Regional skin variation                                                  */
/* ------------------------------------------------------------------------ */

function srgbChannelToLinear(value) { return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; }

/**
 * Seed-stable regional skin variation. It depends only on the seed, skin
 * tone, age and presentation, never on unrelated trait controls. Strengths are
 * scaled by tone: redness is less visible on darker skin, while periorbital
 * darkening stays subtle on every tone.
 */
export function gnmPlayerSkinRegions(profile) {
  const values = getFaceValues(profile);
  const hex = GNM_PLAYER_SKIN_TONES[values.skin];
  const linear = [1, 3, 5].map((index) => srgbChannelToLinear(Number.parseInt(hex.slice(index, index + 2), 16) / 255));
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  const lightness = clamp((Math.cbrt(luminance) - 0.28) / (0.8 - 0.28), 0, 1);
  const random = new Randomizer(hashSeed(`gnm-player:skin-regions:${profile.seed >>> 0}`));
  const jitter = () => random.nextFloat() * 2 - 1;
  const ageFactor = clamp((profile.age - 16) / 44, 0, 1);
  const rednessJitter = jitter();
  const periorbitalJitter = jitter();
  const beardJitter = jitter();
  const oilJitter = jitter();
  // Offset of the blood-flow mottling pattern in template space (per seed).
  const mottleOffset = Object.freeze([jitter(), jitter(), jitter()].map((value) => Number((value * 50).toFixed(3))));
  const masculine = profile.presentation === "masculine";
  const round = (value) => Number(value.toFixed(4));
  return Object.freeze({
    lightness: round(lightness),
    redness: round(clamp((0.8 + 0.18 * rednessJitter + 0.15 * ageFactor) * (0.3 + 0.7 * lightness), 0, 1.2)),
    periorbital: round(clamp(0.55 + 0.15 * periorbitalJitter + 0.3 * ageFactor, 0, 1)),
    beardShadow: round(masculine ? clamp((0.7 + 0.2 * beardJitter) * (profile.age < 18 ? 0.35 : 1), 0, 1) : 0),
    oiliness: round(clamp(0.55 + 0.3 * oilJitter - 0.2 * ageFactor, 0, 1)),
    mottleOffset,
  });
}
