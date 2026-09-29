/*
 * Sports Face GNM 3D player model (Phase 8)
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * DOM/WebGL-free logic for the GNM 3D player generator. It turns a
 * FaceDNA profile into official GNM Head v3.0 identity coefficients, an
 * appearance description and official expression preset weights, and
 * reconstructs vertices from the offline payload built by
 * tools/gnm/build_player_generator.py. GNM itself never runs here.
 *
 * Mapping v2 separates the seeded broad head identity from compact-support
 * feature edits. Cosmetic traits never enter the global prior or conditioning.
 * Local edits reuse official GNM directions, blended only inside their region.
 */

import { getFaceValues, hashSeed, Randomizer } from "./face-model.js";
import { deriveMicroExpressionProfile } from "./player-expression.js";

export const GNM_PLAYER_RENDER_STYLE = "sports/gnm-3d-player-v1";
export const GNM_PLAYER_PAYLOAD_URL = "./tools/gnm/work/gnm-player-generator.bin";
export const GNM_PLAYER_METADATA_URL = "./tools/gnm/work/gnm-player-generator.json";
export const GNM_PLAYER_SCHEMA = "sports-face-gnm-player-generator/v1";
export const GNM_PLAYER_MAPPING_VERSION = "gnm-player-mapping-v2-local";
export const GNM_PLAYER_MAX_BYTES = 6_815_744;
export const GNM_PLAYER_HEADER_BYTES = 64;
export const GNM_PLAYER_PRIOR_CLAMP = 3;
export const GNM_PLAYER_TARGET_CLAMP = 2;
export const GNM_PLAYER_TARGET_TAU = 0.3;

/** Labels supported by the geometry/grooming mapping; IDs retain their SF2 layout. */
export const GNM_PLAYER_GEOMETRIC_TRAITS = Object.freeze(["head", "jaw", "faceProportion", "nose", "eyes", "mouth", "brows", "earShape"]);

const target = (asset, targets = {}) => Object.freeze({ asset, targets: Object.freeze(targets) });

/**
 * FaceDNA catalog label -> target z-scores of measured features. Indexed by the
 * FaceDNA value, with the catalog asset id kept for review. Targets of all
 * traits are summed per feature and clamped to +/-GNM_PLAYER_TARGET_CLAMP.
 */
export const GNM_PLAYER_LABEL_TARGETS = Object.freeze({
  head: Object.freeze([
    target("head/oval"),
    target("head/broad", { faceWidth: 1.3, jawWidth: 0.6 }),
    target("head/long", { faceHeight: 1.3, faceWidth: -0.5 }),
    target("head/square", { jawWidth: 1.3, chinWidth: 1.0 }),
    target("head/round", { faceWidth: 0.9, faceHeight: -0.9, chinWidth: 0.4 }),
    target("head/tapered", { jawWidth: -1.3, chinWidth: -1.1, faceWidth: 0.4 }),
  ]),
  eyes: Object.freeze([
    target("eyes/almond", { eyeWidth: 0.8, eyeOpening: -0.4 }),
    target("eyes/round", { eyeOpening: 1.4, eyeWidth: -0.3 }),
    target("eyes/deep", { eyeDepth: 1.4 }),
    target("eyes/narrow", { eyeOpening: -1.4 }),
    target("eyes/upturned", { canthalTilt: 1.4 }),
    target("eyes/downturned", { canthalTilt: -1.4 }),
  ]),
  brows: Object.freeze([
    target("brows/soft"),
    target("brows/flat"),
    target("brows/arched"),
    target("brows/thick"),
    target("brows/short"),
    target("brows/angular"),
    target("brows/low"),
    target("brows/high"),
  ]),
  nose: Object.freeze([
    target("nose/straight"),
    target("nose/wide", { noseWidth: 1.4 }),
    target("nose/narrow", { noseWidth: -1.4 }),
    target("nose/short", { noseLength: -1.4 }),
    target("nose/long", { noseLength: 1.4 }),
    target("nose/aquiline", { bridgeHeight: 1.3, noseProjection: 0.8 }),
    target("nose/rounded", { noseWidth: 0.7, noseProjection: 0.3 }),
    target("nose/flat-bridge", { bridgeHeight: -1.4, noseProjection: -0.6 }),
  ]),
  mouth: Object.freeze([
    target("mouth/neutral"),
    target("mouth/wide", { mouthWidth: 1.4 }),
    target("mouth/narrow", { mouthWidth: -1.4 }),
    target("mouth/full", { lipThickness: 1.4 }),
    target("mouth/thin", { lipThickness: -1.4 }),
    target("mouth/upturned", { mouthCornerLift: 1.4 }),
    target("mouth/downturned", { mouthCornerLift: -1.4 }),
  ]),
  earShape: Object.freeze([
    target("ears/average"),
    target("ears/small", { earHeight: -1.4 }),
    target("ears/large", { earHeight: 1.4 }),
    target("ears/projecting", { earProjection: 1.6 }),
  ]),
  jaw: Object.freeze([
    target("jaw/very-narrow", { jawWidth: -1.6 }),
    target("jaw/narrow", { jawWidth: -0.8 }),
    target("jaw/average"),
    target("jaw/broad", { jawWidth: 0.8 }),
    target("jaw/very-broad", { jawWidth: 1.6 }),
    target("jaw/angular", { chinWidth: 0.9, jawWidth: 0.4 }),
  ]),
  faceProportion: Object.freeze([
    target("ratio/compact", { faceHeight: -1.4 }),
    target("ratio/short", { faceHeight: -0.7 }),
    target("ratio/average"),
    target("ratio/long", { faceHeight: 0.7 }),
    target("ratio/very-long", { faceHeight: 1.4 }),
    target("ratio/high-forehead", { foreheadHeight: 1.5 }),
  ]),
});

/** Official expression preset weights for the shared micro-expression modes. */
export const GNM_PLAYER_EXPRESSION_WEIGHTS = Object.freeze({
  neutral: Object.freeze({}),
  alert: Object.freeze({ surprise: 0.35 }),
  soft: Object.freeze({ happy: 0.24 }),
  focused: Object.freeze({ squint: 0.42 }),
});

/** sRGB albedo palettes keyed by FaceDNA catalog order (the renderer converts them to linear light). */
export const GNM_PLAYER_SKIN_TONES = Object.freeze([
  "#e6bc9e", "#dba684", "#cc9570", "#b67e5e",
  "#9b6546", "#7c4c33", "#5e3a27", "#44291d",
]);
export const GNM_PLAYER_IRIS_COLORS = Object.freeze(["#4a2c1a", "#7a5a31", "#4b7fae", "#4e7c55"]);
export const GNM_PLAYER_HAIR_COLORS = Object.freeze([
  "#1b1612", "#33231a", "#4f3524", "#7a5a3e",
  "#bca076", "#a47b48", "#743a27", "#8c8984",
]);
const GREY_HAIR = "#bdbab3";

/** Hair style parameters (mm on the scalp field). */
export const GNM_PLAYER_HAIR_STYLES = Object.freeze([
  Object.freeze({ asset: "hair/short-01", hairline: 0, thickness: 0.8, top: 0.4, fade: 0.0, back: 0, texture: 0.25, pattern: "plain" }),
  Object.freeze({ asset: "hair/short-02", hairline: -2, thickness: 2, top: 11, fade: 0.8, back: 0, texture: 0.3, pattern: "plain" }),
  Object.freeze({ asset: "hair/short-03", hairline: -8, thickness: 3, top: 4, fade: 0.35, back: 2, texture: 0.2, pattern: "plain" }),
  Object.freeze({ asset: "hair/short-04", hairline: 0, thickness: 3, top: 27, fade: 0.85, back: 3, texture: 0.4, pattern: "side-part" }),
  Object.freeze({ asset: "hair/medium-01", hairline: -3, thickness: 9, top: 8, fade: 0.0, back: -12, texture: 0.35, pattern: "plain" }),
  Object.freeze({ asset: "hair/medium-02", hairline: -4, thickness: 11, top: 19, fade: 0.0, back: -18, texture: 0.4, pattern: "center-part" }),
  Object.freeze({ asset: "hair/curly-01", hairline: -3, thickness: 16, top: 20, fade: 0.0, back: -8, texture: 1.0, pattern: "curly" }),
  Object.freeze({ asset: "hair/long-01", hairline: -3, thickness: 12, top: 9, fade: 0.0, back: -42, texture: 0.4, pattern: "plain" }),
  Object.freeze({ asset: "hair/long-02", hairline: -4, thickness: 14, top: 10, fade: 0.0, back: -54, texture: 0.45, pattern: "plain" }),
  Object.freeze({ asset: "hair/fade-01", hairline: 0, thickness: 1.5, top: 19, fade: 1.0, back: 4, texture: 0.3, pattern: "plain" }),
  Object.freeze({ asset: "hair/braids-01", hairline: -1, thickness: 6, top: 4, fade: 0.0, back: -16, texture: 0.5, pattern: "braids" }),
  Object.freeze({ asset: "hair/bun-01", hairline: -1, thickness: 4, top: 3, fade: 0.0, back: -6, texture: 0.3, pattern: "bun" }),
]);

/** Session-only prototype: never append to the seeded FaceDNA catalog. */
export const GNM_PLAYER_SIDE_PART = Object.freeze({ asset: "hair/prototype-side-part", hairline: 0, thickness: 3, top: 27, fade: 0.85, back: 3, texture: 0.4, pattern: "side-part" });

/** Beard style parameters (0 = none). */
export const GNM_PLAYER_BEARD_STYLES = Object.freeze([
  Object.freeze({ asset: "beard/none", full: 0, moustache: 0, goatee: 0, density: 0, reach: 0 }),
  Object.freeze({ asset: "beard/stubble", full: 1, moustache: 1, goatee: 1, density: 0.32, reach: 0 }),
  Object.freeze({ asset: "beard/short", full: 1, moustache: 1, goatee: 1, density: 0.72, reach: 2 }),
  Object.freeze({ asset: "beard/full", full: 1, moustache: 1, goatee: 1, density: 0.95, reach: 7 }),
  Object.freeze({ asset: "beard/goatee", full: 0, moustache: 1, goatee: 1, density: 0.9, reach: 2 }),
  Object.freeze({ asset: "beard/moustache", full: 0, moustache: 1, goatee: 0, density: 0.9, reach: 0 }),
]);

/** Eyebrow shapes on the official (browT, browD) fields: where the strand brows root (see gnm-player-facial-hair.js). */
export const GNM_PLAYER_BROW_STYLES = Object.freeze([
  Object.freeze({ asset: "brows/soft", thickness: 5.0, arch: 1.6, peak: 0.55, length: 1.0, density: 0.8 }),
  Object.freeze({ asset: "brows/flat", thickness: 5.0, arch: 0.2, peak: 0.55, length: 1.0, density: 0.85 }),
  Object.freeze({ asset: "brows/arched", thickness: 4.4, arch: 3.6, peak: 0.55, length: 1.0, density: 0.85 }),
  Object.freeze({ asset: "brows/thick", thickness: 7.5, arch: 1.4, peak: 0.55, length: 1.05, density: 0.95 }),
  Object.freeze({ asset: "brows/short", thickness: 5.0, arch: 1.0, peak: 0.5, length: 0.75, density: 0.85 }),
  Object.freeze({ asset: "brows/angular", angular: true, thickness: 5.0, arch: 3.2, peak: 0.68, length: 1.0, density: 0.9 }),
  Object.freeze({ asset: "brows/low", offset: -3, thickness: 5.2, arch: 1.2, peak: 0.55, length: 1.0, density: 0.85 }),
  Object.freeze({ asset: "brows/high", offset: 3, thickness: 4.8, arch: 2.0, peak: 0.55, length: 1.0, density: 0.8 }),
]);

function fail(message) { throw new Error(message); }

/** Deterministic approximately-normal draw (Irwin-Hall, n = 12): only +/* on exact dyadic floats. */
export function irwinHall(randomizer) {
  let sum = 0;
  for (let index = 0; index < 12; index += 1) sum += randomizer.nextFloat();
  return sum - 6;
}

function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }

/** Sum and clamp FaceDNA label targets per feature; also report contributing labels. */
export function gnmPlayerFeatureTargets(profile) {
  const values = getFaceValues(profile);
  const sums = new Map();
  const sources = new Map();
  for (const trait of GNM_PLAYER_GEOMETRIC_TRAITS) {
    const entry = GNM_PLAYER_LABEL_TARGETS[trait][values[trait]];
    if (!entry) fail(`GNM player label missing for ${trait}=${values[trait]}`);
    for (const [feature, z] of Object.entries(entry.targets)) {
      sums.set(feature, (sums.get(feature) || 0) + z);
      if (!sources.has(feature)) sources.set(feature, []);
      sources.get(feature).push(`${trait}:${values[trait]}`);
    }
  }
  const features = [...sums.keys()].sort();
  return {
    targets: Object.fromEntries(features.map((feature) => [feature, clamp(sums.get(feature), -GNM_PLAYER_TARGET_CLAMP, GNM_PLAYER_TARGET_CLAMP)])),
    sources: Object.fromEntries(features.map((feature) => [feature, sources.get(feature)])),
  };
}

/** Seed-stable unit Gaussian prior over the first `count` head components. */
export function gnmPlayerPrior(profile, count) {
  const prior = new Float64Array(count);
  const randomizer = new Randomizer(hashSeed(`gnm-player:base:${profile.seed >>> 0}`));
  for (let index = 0; index < count; index += 1) prior[index] = clamp(irwinHall(randomizer), -GNM_PLAYER_PRIOR_CLAMP, GNM_PLAYER_PRIOR_CLAMP);
  return prior;
}

function choleskySolve(matrix, size, rhs) {
  const lower = new Float64Array(size * size);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let sum = matrix[row * size + column];
      for (let k = 0; k < column; k += 1) sum -= lower[row * size + k] * lower[column * size + k];
      if (row === column) {
        if (!(sum > 0)) fail("GNM player conditioning matrix is not positive definite");
        lower[row * size + column] = Math.sqrt(sum);
      } else {
        lower[row * size + column] = sum / lower[column * size + column];
      }
    }
  }
  const forward = new Float64Array(size);
  for (let row = 0; row < size; row += 1) {
    let sum = rhs[row];
    for (let k = 0; k < row; k += 1) sum -= lower[row * size + k] * forward[k];
    forward[row] = sum / lower[row * size + row];
  }
  const solution = new Float64Array(size);
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = forward[row];
    for (let k = row + 1; k < size; k += 1) sum -= lower[k * size + row] * solution[k];
    solution[row] = sum / lower[row * size + row];
  }
  return solution;
}

/**
 * Condition the official GNM identity for a profile: stable seeded prior on the
 * first K head components, then Matheron conditioning on the label targets.
 * Returns the full 170-coefficient head identity vector plus runtime weights.
 */
function sampleConditionedIdentity(profile, model, targets, sources) {
  const priorCount = model.priorCount;
  const headCount = model.headIdentityCount;
  const prior = gnmPlayerPrior(profile, priorCount);
  const active = Object.keys(targets).map((feature) => {
    const index = model.featureIndex.get(feature);
    if (index === undefined) fail(`Unknown GNM player feature ${feature}`);
    return index;
  });
  const size = active.length;
  const coefficients = new Float64Array(headCount);
  coefficients.set(prior);
  const featureWeights = new Float64Array(model.featureCount);
  if (size > 0) {
    const gram = new Float64Array(size * size);
    const rhs = new Float64Array(size);
    for (let row = 0; row < size; row += 1) {
      const a = active[row];
      for (let column = 0; column < size; column += 1) {
        const b = active[column];
        let dot = 0;
        for (let k = 0; k < headCount; k += 1) dot += model.gradients[a * headCount + k] * model.gradients[b * headCount + k];
        gram[row * size + column] = dot + (row === column ? GNM_PLAYER_TARGET_TAU * GNM_PLAYER_TARGET_TAU : 0);
      }
      const feature = model.featureKeys[a];
      const noise = new Randomizer(hashSeed(`gnm-player:target:${feature}:${sources[feature].join(",")}`));
      let projection = 0;
      for (let k = 0; k < priorCount; k += 1) projection += model.gradients[a * headCount + k] * prior[k];
      rhs[row] = targets[feature] + GNM_PLAYER_TARGET_TAU * irwinHall(noise) - projection;
    }
    const weights = choleskySolve(gram, size, rhs);
    for (let row = 0; row < size; row += 1) {
      const a = active[row];
      featureWeights[a] = weights[row];
      for (let k = 0; k < headCount; k += 1) coefficients[k] += weights[row] * model.gradients[a * headCount + k];
    }
  }
  const realized = {};
  for (let feature = 0; feature < model.featureCount; feature += 1) {
    let z = 0;
    for (let k = 0; k < headCount; k += 1) z += model.gradients[feature * headCount + k] * coefficients[k];
    realized[model.featureKeys[feature]] = z;
  }
  let maxAbsCoefficient = 0;
  for (const value of coefficients) maxAbsCoefficient = Math.max(maxAbsCoefficient, Math.abs(value));
  return { prior, coefficients, featureWeights, targets, sources, realizedZ: realized, maxAbsCoefficient };
}

/** Keep broad head identity separate from independently editable anatomical regions. */
export function sampleGnmPlayerIdentity(profile, model) {
  const values = getFaceValues(profile);
  const targets = {}, sources = {};
  for (const trait of ["head", "jaw", "faceProportion"]) {
    for (const [feature, value] of Object.entries(GNM_PLAYER_LABEL_TARGETS[trait][values[trait]].targets)) {
      targets[feature] = clamp((targets[feature] || 0) + value, -GNM_PLAYER_TARGET_CLAMP, GNM_PLAYER_TARGET_CLAMP);
      (sources[feature] ||= []).push(`${trait}:${values[trait]}`);
    }
  }
  const base = sampleConditionedIdentity(profile, model, targets, sources);
  base.localEdits = {};
  for (const trait of ["eyes", "nose", "mouth", "earShape"]) {
    const local = GNM_PLAYER_LABEL_TARGETS[trait][values[trait]].targets;
    if (Object.keys(local).length === 0) continue;
    const localSources = Object.fromEntries(Object.keys(local).map(key => [key, [`${trait}:${values[trait]}`]]));
    base.localEdits[trait] = sampleConditionedIdentity(profile, model, { ...targets, ...local }, { ...sources, ...localSources });
  }
  const labels = gnmPlayerFeatureTargets(profile);
  base.targets = labels.targets;
  base.sources = labels.sources;
  return base;
}

/** Compact support in template space: changing one region cannot move the skull or collar. */
export function gnmPlayerLocalMask(trait, position) {
  const [x, y, z] = position;
  const box = (dx, dy, dz) => (1 - smoothstep(0.68, 1, Math.abs(dx))) * (1 - smoothstep(0.68, 1, Math.abs(dy))) * (1 - smoothstep(0.68, 1, Math.abs(dz)));
  if (trait === "eyes") return box((Math.abs(x) - 0.0311) / 0.025, (y - 0.2995) / 0.021, (z - 0.108) / 0.04);
  if (trait === "nose") return box(x / 0.034, (y - 0.280) / 0.040, (z - 0.132) / 0.04);
  if (trait === "mouth") return box(x / 0.041, (y - 0.231) / 0.031, (z - 0.119) / 0.046);
  if (trait === "earShape") return box((Math.abs(x) - 0.084) / 0.026, (y - 0.271) / 0.044, (z - 0.018) / 0.038);
  return 0;
}

/** Resolve the shared micro-expression mode to official GNM preset weights. */
export function gnmPlayerExpression(profile, expressionMode = "auto") {
  const micro = deriveMicroExpressionProfile(profile, expressionMode);
  return { mode: micro.mode, requestedMode: micro.requestedMode, weights: { ...GNM_PLAYER_EXPRESSION_WEIGHTS[micro.mode] } };
}

function hexToRgb(value) {
  return [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16) / 255);
}

function mixRgb(a, b, t) { return a.map((value, index) => value + (b[index] - value) * t); }

/** Appearance for the 3D player: pigments, painted styles and age effects. */
export function gnmPlayerAppearance(profile, options = {}) {
  if (options.hairstylePrototype !== undefined && !["original", "side-part"].includes(options.hairstylePrototype)) throw new Error("Unsupported hairstyle prototype");
  const values = getFaceValues(profile);
  const age = profile.age;
  const skinJitter = new Randomizer(hashSeed(`gnm-player:skin:${values.skin}:${profile.seed >>> 0}`));
  const skinBase = hexToRgb(GNM_PLAYER_SKIN_TONES[values.skin]);
  const tint = 1 + (skinJitter.nextFloat() - 0.5) * 0.06;
  const warmth = (skinJitter.nextFloat() - 0.5) * 0.04;
  const skin = [clamp(skinBase[0] * tint + warmth, 0, 1), clamp(skinBase[1] * tint, 0, 1), clamp(skinBase[2] * tint - warmth, 0, 1)];
  const hairBase = hexToRgb(GNM_PLAYER_HAIR_COLORS[values.hairColor]);
  const grey = hexToRgb(GREY_HAIR);
  const hairGrey = clamp((age - 34) / 30, 0, 0.75);
  const beardGrey = clamp((age - 30) / 32, 0, 0.8);
  const browGrey = clamp((age - 46) / 30, 0, 0.5);
  const hairVisible = values.hairVisible === 1;
  const hairStyle = options.hairstylePrototype === "side-part" ? GNM_PLAYER_SIDE_PART : GNM_PLAYER_HAIR_STYLES[values.hair];
  const recession = hairVisible ? clamp((age - 30) / 30, 0, 1) * ((profile.seed >>> 0) % 3 === 0 ? 9 : 3) : 0;
  return {
    skin,
    lip: mixRgb(skin, [0.62, 0.30, 0.30], 0.38),
    iris: hexToRgb(GNM_PLAYER_IRIS_COLORS[values.eyeColor]),
    hair: mixRgb(hairBase, grey, hairGrey),
    // Strand hair greys as a fraction of grey strands whose mean is `hair`.
    hairPigment: hairBase,
    hairGreyColor: grey,
    hairGrey,
    beard: mixRgb(hairBase.map((value) => value * 0.86), grey, beardGrey),
    brow: mixRgb(hairBase.map((value) => value * 0.68), grey, browGrey),
    // Beard and brow strands grey the same way: a fraction of grey strands
    // (hairGreyColor) whose mean is `beard` / `brow`.
    beardPigment: hairBase.map((value) => value * 0.86),
    beardGrey,
    browPigment: hairBase.map((value) => value * 0.68),
    browGrey,
    hairVisible,
    hairStyle: hairVisible ? { ...hairStyle, hairline: hairStyle.hairline + recession } : null,
    beardStyle: GNM_PLAYER_BEARD_STYLES[values.beard],
    browStyle: GNM_PLAYER_BROW_STYLES[values.brows],
    freckles: values.freckles === 1,
    scar: values.scar === 1,
    glasses: values.glasses === 1,
    ageShading: clamp((age - 28) / 32, 0, 1),
    kit: { primary: hexToRgb(profile.kit.primary), secondary: hexToRgb(profile.kit.secondary) },
  };
}

function headerValue(view, index) { return view.getUint32(8 + index * 4, true); }

/** Validate and index the generator payload. Throws on any schema/format mismatch. */
export function parseGnmPlayerPayload(metadata, payload) {
  if (!metadata || metadata.schema !== GNM_PLAYER_SCHEMA) fail("GNM player metadata schema is invalid");
  if (metadata.semanticMapping !== "measured-landmark-features-v1" || metadata.runtimeBasisLoaded !== true || metadata.officialTexturesIncluded !== false) fail("GNM player safety metadata is invalid");
  const buffer = payload instanceof ArrayBuffer ? payload : payload?.buffer;
  if (!(buffer instanceof ArrayBuffer)) fail("GNM player payload must be an ArrayBuffer");
  const byteOffset = payload instanceof ArrayBuffer ? 0 : payload.byteOffset;
  const byteLength = payload.byteLength;
  if (byteLength > GNM_PLAYER_MAX_BYTES || byteLength !== metadata.payload?.sizeBytes || metadata.budget?.maxBytes !== GNM_PLAYER_MAX_BYTES) fail("GNM player payload exceeds its byte budget");
  const view = new DataView(buffer, byteOffset, byteLength);
  const magic = new TextDecoder().decode(new Uint8Array(buffer, byteOffset, 8));
  if (magic !== "SFGNMPL1") fail("GNM player payload magic is invalid");
  const [version, headerBytes, vertexCount, priorCount, featureCount, expressionCount, fieldCount, scaleOffset, vectorOffset, vectorBytes, fieldOffset, fieldBytes, totalBytes] = Array.from({ length: 13 }, (_, index) => headerValue(view, index));
  const dims = metadata.dimensions || {};
  const vectorCount = priorCount + featureCount + expressionCount;
  if (version !== 1 || headerBytes !== GNM_PLAYER_HEADER_BYTES || totalBytes !== byteLength) fail("GNM player header is invalid");
  if (vertexCount !== dims.sourceVertexCount || priorCount !== dims.identityPriorCount || featureCount !== dims.featureCount || expressionCount !== dims.expressionPresetCount || fieldCount !== dims.fieldCount || vectorCount !== dims.vectorCount) fail("GNM player dimensions do not match metadata");
  if (scaleOffset !== headerBytes || vectorOffset !== scaleOffset + vectorCount * 4 || vectorBytes !== vectorCount * vertexCount * 6 || fieldOffset !== vectorOffset + vectorBytes || fieldBytes !== fieldCount * vertexCount || fieldOffset + fieldBytes !== totalBytes) fail("GNM player payload layout is invalid");
  const scales = new Float32Array(vectorCount);
  for (let index = 0; index < vectorCount; index += 1) {
    scales[index] = view.getFloat32(scaleOffset + index * 4, true);
    if (!(Number.isFinite(scales[index]) && scales[index] > 0)) fail("GNM player vector scale is invalid");
  }
  const vectors = new Int16Array(vectorCount * vertexCount * 3);
  for (let index = 0; index < vectors.length; index += 1) vectors[index] = view.getInt16(vectorOffset + index * 2, true);
  const fields = new Uint8Array(buffer.slice(byteOffset + fieldOffset, byteOffset + fieldOffset + fieldBytes));
  const headIdentityCount = dims.headIdentityCount;
  const features = metadata.features;
  if (!Array.isArray(features) || features.length !== featureCount) fail("GNM player feature metadata is invalid");
  const gradients = new Float64Array(featureCount * headIdentityCount);
  features.forEach((feature, row) => {
    if (!Array.isArray(feature.normalizedGradient) || feature.normalizedGradient.length !== headIdentityCount) fail(`GNM player gradient for ${feature.key} is invalid`);
    feature.normalizedGradient.forEach((value, column) => { gradients[row * headIdentityCount + column] = Math.fround(value); });
    if (feature.tailVectorIndex !== priorCount + row) fail("GNM player tail vector order is invalid");
  });
  const presets = new Map(metadata.expressionPresets.map((preset, index) => {
    if (preset.vectorIndex !== priorCount + featureCount + index) fail("GNM player expression vector order is invalid");
    return [preset.key, preset.vectorIndex];
  }));
  const fieldIndex = new Map(metadata.fields.map((field, index) => {
    if (field.index !== index) fail("GNM player field order is invalid");
    return [field.key, field];
  }));
  const definitions = metadata.landmarks?.definitions;
  if (!Array.isArray(definitions) || definitions.length !== 68) fail("GNM player landmark definitions are invalid");
  const landmarkIndices = new Int32Array(68 * 3);
  const landmarkWeights = new Float64Array(68 * 3);
  definitions.forEach((row, landmark) => {
    for (let corner = 0; corner < 3; corner += 1) {
      landmarkIndices[landmark * 3 + corner] = row[corner * 2];
      landmarkWeights[landmark * 3 + corner] = row[corner * 2 + 1];
    }
  });
  return {
    metadata,
    vertexCount,
    priorCount,
    featureCount,
    expressionCount,
    fieldCount,
    headIdentityCount,
    scales,
    vectors,
    fields,
    gradients,
    featureKeys: features.map((feature) => feature.key),
    featureIndex: new Map(features.map((feature, index) => [feature.key, index])),
    features,
    presets,
    fieldIndex,
    landmarkIndices,
    landmarkWeights,
    fixedVertices: metadata.fixedVertices,
  };
}

/** Decoded value of one appearance field for one source vertex. */
export function gnmPlayerFieldValue(model, key, vertex) {
  const field = model.fieldIndex.get(key);
  if (!field) fail(`Unknown GNM player field ${key}`);
  return field.min + (model.fields[field.index * model.vertexCount + vertex] / 255) * (field.max - field.min);
}

function addVector(model, out, vectorIndex, coefficient) {
  if (!coefficient) return;
  const factor = coefficient * model.scales[vectorIndex];
  const offset = vectorIndex * model.vertexCount * 3;
  const count = model.vertexCount * 3;
  for (let index = 0; index < count; index += 1) out[index] += factor * model.vectors[offset + index];
}

/**
 * Reconstruct source-vertex positions (meters): template + identity prior
 * directions + feature tails + official expression presets.
 */
export function reconstructGnmPlayerPositions(model, template, identity, expressionWeights = {}, out = null) {
  const count = model.vertexCount * 3;
  if (!(template instanceof Float32Array) || template.length !== count) fail("GNM player template must be a Float32Array of source positions");
  const positions = out && out.length === count ? out : new Float64Array(count);
  for (let index = 0; index < count; index += 1) positions[index] = template[index];
  for (let k = 0; k < model.priorCount; k += 1) addVector(model, positions, k, identity.coefficients[k]);
  for (let feature = 0; feature < model.featureCount; feature += 1) addVector(model, positions, model.priorCount + feature, identity.featureWeights[feature]);
  if (identity.localEdits) {
    const base = new Float64Array(positions);
    for (const [trait, local] of Object.entries(identity.localEdits)) {
      const edited = reconstructGnmPlayerPositions(model, template, local);
      for (let vertex = 0; vertex < model.vertexCount; vertex += 1) {
        const offset = vertex * 3;
        const mask = gnmPlayerLocalMask(trait, template.subarray(offset, offset + 3));
        if (mask === 0) continue;
        for (let axis = 0; axis < 3; axis += 1) positions[offset + axis] += mask * (edited[offset + axis] - base[offset + axis]);
      }
    }
  }
  for (const [key, weight] of Object.entries(expressionWeights)) {
    const vectorIndex = model.presets.get(key);
    if (vectorIndex === undefined) fail(`Unknown GNM player expression preset ${key}`);
    addVector(model, positions, vectorIndex, weight);
  }
  return positions;
}

/** Official 68 sparse landmarks (meters) from source-vertex positions. */
export function gnmPlayerLandmarks(model, positions) {
  const result = new Float64Array(68 * 3);
  for (let landmark = 0; landmark < 68; landmark += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = model.landmarkIndices[landmark * 3 + corner];
      const weight = model.landmarkWeights[landmark * 3 + corner];
      for (let axis = 0; axis < 3; axis += 1) result[landmark * 3 + axis] += weight * positions[vertex * 3 + axis];
    }
  }
  return result;
}

const AXIS = { x: 0, y: 1, z: 2 };

/** Measure every metadata feature (mm) exactly as the offline builder defines it. */
export function measureGnmPlayerFeatures(model, positions) {
  const landmarks = gnmPlayerLandmarks(model, positions);
  const result = {};
  for (const feature of model.features) {
    let value = 0;
    for (const term of feature.terms) {
      const axis = AXIS[term.axis];
      const coordinate = term.landmark !== undefined
        ? landmarks[term.landmark * 3 + axis]
        : positions[model.fixedVertices[term.vertex] * 3 + axis];
      value += term.weight * coordinate;
    }
    result[feature.key] = value * 1000;
  }
  return result;
}

/** Realized z-scores relative to the official template/prior statistics. */
export function gnmPlayerFeatureZ(model, measuredMm) {
  return Object.fromEntries(model.features.map((feature) => [feature.key, (measuredMm[feature.key] - feature.templateValueMm) / feature.stdDevMm]));
}

/** Source-space template positions from render positions and source ids. */
export function buildGnmPlayerTemplate(vertexCount, renderPositions, sourceIds) {
  const template = new Float32Array(vertexCount * 3);
  const seen = new Uint8Array(vertexCount);
  for (let index = 0; index < sourceIds.length; index += 1) {
    const source = sourceIds[index];
    if (source >= vertexCount) fail("GNM player source id is out of range");
    if (seen[source]) continue;
    seen[source] = 1;
    template[source * 3] = renderPositions[index * 3];
    template[source * 3 + 1] = renderPositions[index * 3 + 1];
    template[source * 3 + 2] = renderPositions[index * 3 + 2];
  }
  if (!seen.every(Boolean)) fail("GNM player render mapping does not cover every source vertex");
  return template;
}

/** Area-weighted smooth normals per source vertex (consistent official winding). */
export function computeGnmPlayerNormals(positions, sourceTriangles, vertexCount, out = null) {
  const normals = out && out.length === vertexCount * 3 ? out.fill(0) : new Float32Array(vertexCount * 3);
  for (let index = 0; index < sourceTriangles.length; index += 3) {
    const a = sourceTriangles[index] * 3;
    const b = sourceTriangles[index + 1] * 3;
    const c = sourceTriangles[index + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const vertex of [a, b, c]) {
      normals[vertex] += nx;
      normals[vertex + 1] += ny;
      normals[vertex + 2] += nz;
    }
  }
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 3;
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]);
    if (length > 0) {
      normals[offset] /= length;
      normals[offset + 1] /= length;
      normals[offset + 2] /= length;
    } else {
      normals[offset + 2] = 1;
    }
  }
  return normals;
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Hairline threshold (mm on the scalp field) for a style. `front` is the
 * scalpFront field (cosine of the head azimuth). Mirrors the GLSL exactly.
 */
export function gnmPlayerHairThreshold(style, front) {
  const frontWeight = smoothstep(0.15, 0.85, front);
  const backWeight = smoothstep(0.05, 0.75, -front);
  return style.hairline * frontWeight + style.back * backWeight;
}

export function gnmPlayerHairCoverage(style, scalpMm, front) {
  if (!style) return 0;
  const threshold = gnmPlayerHairThreshold(style, front);
  const fade = 1 - style.fade * (1 - smoothstep(0.15, 0.85, front)) * (1 - smoothstep(0, 45, scalpMm - threshold));
  return smoothstep(threshold - 1.2, threshold + 1.2, scalpMm) * fade;
}

/** Volumetric shell thickness (mm): ramps from the hairline, fuller on the crown, thinner on fades. */
export function gnmPlayerHairThicknessMm(style, scalpMm, front) {
  if (!style) return 0;
  const above = scalpMm - gnmPlayerHairThreshold(style, front);
  if (above <= 0) return 0;
  const volume = style.thickness + style.top * smoothstep(18, 60, above);
  const fade = 1 - style.fade * (1 - smoothstep(0.15, 0.85, front)) * (1 - smoothstep(8, 38, above));
  return volume * fade * smoothstep(0, 6, above);
}

/** Low-frequency clumps break up the silhouette without changing the scalp mesh. */
export function gnmPlayerHairSurfaceOffset(style, scalpMm, front, position) {
  const base = gnmPlayerHairThicknessMm(style, scalpMm, front);
  if (base <= 0) return 0;
  const [x, y, z] = position;
  if (style.pattern === "side-part") {
    // The crown and carved part define the silhouette, without embossed waves.
    const above = scalpMm - gnmPlayerHairThreshold(style, front);
    const crown = smoothstep(16, 58, above);
    const partX = 0.026 + z * 0.045;
    const sweptSide = 1 - smoothstep(partX - 0.004, partX + 0.008, x);
    const part = 1 - Math.exp(-(((x - partX) / 0.007) ** 2));
    const crest = Math.exp(-(((x + 0.018) / 0.055) ** 2));
    return (2.5 + crown * (4 + 25 * sweptSide * crest) * (0.35 + 0.65 * smoothstep(-0.4, 0.65, front))) * (0.42 + 0.58 * part) * smoothstep(0, 6, above);
  }
  if (style.pattern === "center-part") {
    const groove = 0.38 + 0.62 * smoothstep(0.001, 0.013, Math.abs(x));
    return base * groove * (0.9 + 0.25 * smoothstep(-0.2, 0.8, front));
  }
  const curl = style.pattern === "curly";
  const wave = Math.sin(x * (curl ? 420 : 190) + z * 120) * Math.sin(y * (curl ? 350 : 110) - z * 230);
  const clump = curl ? 1.0 + 0.2 * wave : 1.0 + 0.075 * wave;
  return base * clump;
}

/** Offset skin render vertices along their normals to form the hair shell. */
export function gnmPlayerHairShell(style, staticData, renderPositions, renderNormals) {
  const positions = new Float32Array(renderPositions);
  if (!style) return { positions, triangleEstimate: 0 };
  for (let vertex = 0; vertex < staticData.renderCount; vertex += 1) {
    if (!staticData.skinVertex[vertex]) continue;
    const thickness = gnmPlayerHairSurfaceOffset(style, staticData.scalp[vertex], staticData.front[vertex], renderPositions.subarray(vertex * 3, vertex * 3 + 3)) / 1000;
    if (thickness <= 0) continue;
    for (let axis = 0; axis < 3; axis += 1) positions[vertex * 3 + axis] += renderNormals[vertex * 3 + axis] * thickness;
  }
  return { positions, triangleEstimate: staticData.ranges.hair.count / 3 };
}

/** Stable diagnostics shared by describeRender and the WebGL renderer. */
export function describeGnmPlayerMapping(profile, options = {}) {
  const expression = gnmPlayerExpression(profile, options.expressionMode);
  const { targets, sources } = gnmPlayerFeatureTargets(profile);
  const appearance = gnmPlayerAppearance(profile, options);
  return {
    renderer: GNM_PLAYER_RENDER_STYLE,
    prototype: true,
    mappingVersion: GNM_PLAYER_MAPPING_VERSION,
    source: "official GNM Head v3.0 seeded identity + compact-support local feature conditioning + official expression presets",
    semanticMapping: "measured-landmark-features-v1",
    officialTexturesIncluded: false,
    identity: {
      identityOnly: true,
      geometricTraits: [...GNM_PLAYER_GEOMETRIC_TRAITS],
      priorSource: "stable-profile-seed",
      localRegions: ["eyes", "nose", "mouth", "earShape"],
      featureTargets: targets,
      featureTargetSources: sources,
      note: "The seed defines the stable base. Local shape edits use compact-support deltas; grooming, pigments and expression do not change base geometry.",
    },
    expression,
    appearance: {
      hairStyle: appearance.hairStyle?.asset ?? "hair/hidden",
      beardStyle: appearance.beardStyle.asset,
      browStyle: appearance.browStyle.asset,
      freckles: appearance.freckles,
      scar: appearance.scar,
      glasses: appearance.glasses ? "procedural-frames" : false,
      painted: "procedural fields over official regions; not official textures",
    },
  };
}
