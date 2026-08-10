/*
 * Sports Face Morphology Lab v0.4.0
 * Deterministic 2D landmark and morphology layer for FaceDNA v2.
 *
 * The bundled family pack is an analytic, GNM-ready starter scaffold. It is
 * deliberately labelled as such: it is not claimed to be generated from GNM.
 * The offline tools in tools/gnm/ replace this scaffold with measured packs.
 */

import { getFaceValues, hashSeed } from "./face-model.js";

export const MORPH_RENDER_STYLE = "sports/morph-v1";
export const GNM_MORPH_RENDER_STYLE = "sports/morph-gnm-v1";
export const MORPHOLOGY_PACK_VERSION = "sports-face-morphology/1.0.0";
export const GNM_MORPHOLOGY_VERSION = "sports-face-morphology/gnm-v1";
export const GNM_MORPHOLOGY_SCHEMA = "sports-face-morphology-pack/v1";
export const GNM_MORPHOLOGY_FEATURES = Object.freeze([
  "craniumWidth", "cheekWidth", "jawWidth", "chinWidth", "faceHeight",
  "foreheadHeight", "eyeSpacing", "eyeWidth", "eyeHeight", "noseLength",
  "noseWidth", "mouthWidth", "earSpan", "templeSlope",
]);
export const GNM_FAMILY_SELECTION_VERSION = "face-dna-shape-v1";
export const GNM_FAMILY_SELECTION_INPUTS = Object.freeze(["head", "faceProportion"]);
export const GNM_FAMILY_SELECTION_RULES = Object.freeze([
  Object.freeze({ condition: "faceProportion === 5", familyId: "gnm-08-high-forehead" }),
  Object.freeze({ condition: "faceProportion <= 1 && head in {1, 4}", familyId: "gnm-02-compact-wide" }),
  Object.freeze({ condition: "otherwise and head === 0", familyId: "gnm-03-balanced" }),
  Object.freeze({ condition: "otherwise and head === 1", familyId: "gnm-06-broad" }),
  Object.freeze({ condition: "otherwise and head === 2", familyId: "gnm-07-long" }),
  Object.freeze({ condition: "otherwise and head === 3", familyId: "gnm-05-angular" }),
  Object.freeze({ condition: "otherwise and head === 4", familyId: "gnm-01-compact" }),
  Object.freeze({ condition: "otherwise and head === 5", familyId: "gnm-04-tapered" }),
]);
export const GNM_FAMILY_SELECTION_NOTE = "Reviewed semantic FaceDNA shape mapping aligned to the current GNM family labels.";
export const MICRO_EXPRESSION_VERSION = "micro-expression-v1";
export const MICRO_EXPRESSION_MODES = Object.freeze(["neutral", "alert", "soft", "focused"]);
export const EXPRESSION_MODES = Object.freeze(["auto", ...MICRO_EXPRESSION_MODES]);
export const MORPHOLOGY_SOURCE = Object.freeze({
  kind: "analytic-starter",
  gnmDerived: false,
  description: "Starter family metrics for validating the GNM-compatible 2D pipeline.",
});

const GNM_PACK_INJECTION = typeof gnmPack !== "undefined" && gnmPack != null
  ? gnmPack
  : (typeof globalThis !== "undefined" ? globalThis.sportsFaceGnmPack : undefined);

export const MORPHOLOGY_FAMILIES = Object.freeze([
  Object.freeze({
    id: "oval-balanced", label: "Oval equilibrada",
    craniumWidth: 1.00, cheekWidth: 0.99, jawWidth: 0.94, chinWidth: 0.92,
    faceHeight: 1.00, foreheadHeight: 1.00, eyeSpacing: 1.00,
    eyeWidth: 1.00, eyeHeight: 1.00, noseLength: 1.00, noseWidth: 0.98,
    mouthWidth: 1.00, earScale: 1.00, templeSlope: 1.00,
  }),
  Object.freeze({
    id: "broad-square", label: "Ancha y cuadrada",
    craniumWidth: 1.08, cheekWidth: 1.08, jawWidth: 1.12, chinWidth: 1.10,
    faceHeight: 0.96, foreheadHeight: 0.95, eyeSpacing: 1.05,
    eyeWidth: 1.02, eyeHeight: 0.96, noseLength: 0.97, noseWidth: 1.08,
    mouthWidth: 1.06, earScale: 1.02, templeSlope: 0.92,
  }),
  Object.freeze({
    id: "long-narrow", label: "Larga y estrecha",
    craniumWidth: 0.93, cheekWidth: 0.92, jawWidth: 0.90, chinWidth: 0.88,
    faceHeight: 1.10, foreheadHeight: 1.03, eyeSpacing: 0.94,
    eyeWidth: 0.96, eyeHeight: 1.00, noseLength: 1.10, noseWidth: 0.91,
    mouthWidth: 0.94, earScale: 1.00, templeSlope: 1.06,
  }),
  Object.freeze({
    id: "angular-athletic", label: "Angular atlética",
    craniumWidth: 1.01, cheekWidth: 1.06, jawWidth: 1.08, chinWidth: 0.94,
    faceHeight: 1.02, foreheadHeight: 0.96, eyeSpacing: 1.02,
    eyeWidth: 0.99, eyeHeight: 0.94, noseLength: 1.03, noseWidth: 1.01,
    mouthWidth: 1.02, earScale: 0.99, templeSlope: 0.90,
  }),
  Object.freeze({
    id: "compact-round", label: "Compacta y redonda",
    craniumWidth: 1.06, cheekWidth: 1.08, jawWidth: 1.00, chinWidth: 1.02,
    faceHeight: 0.90, foreheadHeight: 0.96, eyeSpacing: 1.00,
    eyeWidth: 1.04, eyeHeight: 1.08, noseLength: 0.91, noseWidth: 1.04,
    mouthWidth: 1.00, earScale: 0.95, templeSlope: 0.96,
  }),
  Object.freeze({
    id: "tapered-heart", label: "Cónica / corazón",
    craniumWidth: 1.05, cheekWidth: 1.03, jawWidth: 0.87, chinWidth: 0.78,
    faceHeight: 1.01, foreheadHeight: 1.02, eyeSpacing: 1.02,
    eyeWidth: 1.02, eyeHeight: 1.01, noseLength: 1.00, noseWidth: 0.94,
    mouthWidth: 0.96, earScale: 0.98, templeSlope: 1.05,
  }),
  Object.freeze({
    id: "high-forehead", label: "Frente alta",
    craniumWidth: 0.99, cheekWidth: 0.98, jawWidth: 0.94, chinWidth: 0.91,
    faceHeight: 1.08, foreheadHeight: 1.18, eyeSpacing: 0.99,
    eyeWidth: 0.99, eyeHeight: 1.00, noseLength: 1.04, noseWidth: 0.97,
    mouthWidth: 0.98, earScale: 1.00, templeSlope: 1.08,
  }),
  Object.freeze({
    id: "low-wide", label: "Baja y ancha",
    craniumWidth: 1.10, cheekWidth: 1.09, jawWidth: 1.05, chinWidth: 1.03,
    faceHeight: 0.91, foreheadHeight: 0.86, eyeSpacing: 1.07,
    eyeWidth: 1.03, eyeHeight: 0.97, noseLength: 0.92, noseWidth: 1.09,
    mouthWidth: 1.05, earScale: 1.04, templeSlope: 0.90,
  }),
]);

const FAMILY_BY_ID = new Map(MORPHOLOGY_FAMILIES.map((family) => [family.id, family]));
const ANALYTIC_FAMILY_IDS = Object.freeze({
  highForehead: "high-forehead",
  compactWide: "low-wide",
  byHead: Object.freeze([
    "oval-balanced", "broad-square", "long-narrow", "angular-athletic",
    "compact-round", "tapered-heart",
  ]),
});
const GNM_FAMILY_IDS = Object.freeze({
  highForehead: "gnm-08-high-forehead",
  compactWide: "gnm-02-compact-wide",
  byHead: Object.freeze([
    "gnm-03-balanced", "gnm-06-broad", "gnm-07-long", "gnm-05-angular",
    "gnm-01-compact", "gnm-04-tapered",
  ]),
});

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function round(value, places = 3) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}
function unitNoise(seed, key) {
  return (hashSeed(`morph:${seed}:${key}`) / 0xffffffff) * 2 - 1;
}
function point(x, y) { return Object.freeze({ x: round(x), y: round(y) }); }

function freezeExpressionFeature(feature) {
  return Object.freeze({
    offsetX: round(feature.offsetX, 4),
    offsetY: round(feature.offsetY, 4),
    scaleX: round(feature.scaleX, 4),
    scaleY: round(feature.scaleY, 4),
  });
}

export function deriveMicroExpressionProfile(profile, requestedMode = "auto") {
  const values = getFaceValues(profile);
  const autoMode = MICRO_EXPRESSION_MODES[(values.eyes * 5 + values.brows * 3 + values.mouth * 7) % MICRO_EXPRESSION_MODES.length];
  const resolvedRequestedMode = EXPRESSION_MODES.includes(requestedMode) ? requestedMode : "auto";
  const mode = resolvedRequestedMode === "auto" ? autoMode : resolvedRequestedMode;
  const modeIndex = MICRO_EXPRESSION_MODES.indexOf(mode);
  const eyeSignal = values.eyes - 2.5;
  const browSignal = values.brows - 3.5;
  const mouthSignal = values.mouth - 3;
  const modeNudges = {
    neutral: { eyesY: 0, browsY: 0, mouthY: 0, eyesSY: 0, browsSY: 0, mouthSY: 0 },
    alert: { eyesY: -0.7, browsY: -0.9, mouthY: -0.2, eyesSY: 0.006, browsSY: 0.004, mouthSY: 0 },
    soft: { eyesY: 0.6, browsY: 0.6, mouthY: 0.5, eyesSY: -0.004, browsSY: -0.003, mouthSY: 0.004 },
    focused: { eyesY: 0.9, browsY: 1.0, mouthY: -0.3, eyesSY: -0.007, browsSY: -0.005, mouthSY: -0.002 },
  }[mode];
  const parameters = Object.freeze({
    eyes: freezeExpressionFeature({
      offsetX: mouthSignal * 0.18,
      offsetY: modeNudges.eyesY + browSignal * 0.16,
      scaleX: 1 + eyeSignal * 0.0012,
      scaleY: 1 + modeNudges.eyesSY + mouthSignal * 0.0012,
    }),
    brows: freezeExpressionFeature({
      offsetX: eyeSignal * 0.16,
      offsetY: modeNudges.browsY + browSignal * 0.14,
      scaleX: 1 + browSignal * 0.0008,
      scaleY: 1 + modeNudges.browsSY + eyeSignal * 0.001,
    }),
    mouth: freezeExpressionFeature({
      offsetX: eyeSignal * 0.12,
      offsetY: modeNudges.mouthY + mouthSignal * 0.16,
      scaleX: 1 + mouthSignal * 0.001,
      scaleY: 1 + modeNudges.mouthSY + browSignal * 0.0008,
    }),
  });
  return Object.freeze({
    version: MICRO_EXPRESSION_VERSION,
    requestedMode: resolvedRequestedMode,
    mode,
    modeIndex,
    inputs: Object.freeze({ eyes: values.eyes, brows: values.brows, mouth: values.mouth }),
    parameters,
  });
}

function selectFamilyIdFromFaceDna(values, familyIds) {
  if (values.faceProportion === 5) return familyIds.highForehead;
  if (values.faceProportion <= 1 && [1, 4].includes(values.head)) return familyIds.compactWide;
  return familyIds.byHead[values.head];
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function packError(path, message) {
  throw new TypeError(`Invalid GNM morphology pack at ${path}: ${message}`);
}

function cloneAndFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze));
  if (!isRecord(value)) return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item)])));
}

export function createGnmMorphologyAdapter(pack) {
  if (!isRecord(pack)) packError("pack", "expected an object");
  if (pack.schema !== GNM_MORPHOLOGY_SCHEMA) packError("schema", `expected ${GNM_MORPHOLOGY_SCHEMA}`);
  if (!isRecord(pack.source)) packError("source", "expected an object");
  if (pack.source.gnmDerived !== true) packError("source.gnmDerived", "must be true for the explicit GNM runtime");
  if (!isRecord(pack.clustering)) packError("clustering", "expected an object");
  if (pack.clustering.families !== 8) packError("clustering.families", "expected exactly 8");
  if (!Array.isArray(pack.clustering.features) || pack.clustering.features.length !== GNM_MORPHOLOGY_FEATURES.length) {
    packError("clustering.features", `expected exactly ${GNM_MORPHOLOGY_FEATURES.length} features`);
  }
  if (pack.clustering.features.some((feature, index) => feature !== GNM_MORPHOLOGY_FEATURES[index])) {
    packError("clustering.features", `expected ${GNM_MORPHOLOGY_FEATURES.join(", ")}`);
  }
  if (!Array.isArray(pack.families) || pack.families.length !== 8) packError("families", "expected exactly 8 families");

  const ids = new Set();
  const means = Object.fromEntries(GNM_MORPHOLOGY_FEATURES.map((feature) => [feature, 0]));
  for (const [familyIndex, family] of pack.families.entries()) {
    if (!isRecord(family)) packError(`families[${familyIndex}]`, "expected an object");
    if (typeof family.id !== "string" || family.id.length === 0) packError(`families[${familyIndex}].id`, "expected a non-empty string");
    if (ids.has(family.id)) packError(`families[${familyIndex}].id`, `duplicate id ${family.id}`);
    ids.add(family.id);
    if (typeof family.label !== "string" || family.label.length === 0) packError(`families[${familyIndex}].label`, "expected a non-empty string");
    if (!isRecord(family.centroid)) packError(`families[${familyIndex}].centroid`, "expected an object");
    const centroidKeys = Object.keys(family.centroid);
    if (centroidKeys.length !== GNM_MORPHOLOGY_FEATURES.length || GNM_MORPHOLOGY_FEATURES.some((feature) => !centroidKeys.includes(feature))) {
       packError(`families[${familyIndex}].centroid`, `expected the fourteen features ${GNM_MORPHOLOGY_FEATURES.join(", ")}`);
    }
    for (const feature of GNM_MORPHOLOGY_FEATURES) {
      const value = family.centroid[feature];
      if (!Number.isFinite(value) || value <= 0) packError(`families[${familyIndex}].centroid.${feature}`, "expected a finite positive number");
      means[feature] += value;
    }
  }
  for (const feature of GNM_MORPHOLOGY_FEATURES) {
    means[feature] /= pack.families.length;
    if (!Number.isFinite(means[feature]) || means[feature] <= 0) packError(`means.${feature}`, "could not calculate a positive finite mean");
  }

  const frozenPack = cloneAndFreeze(pack);
  return Object.freeze({
    schema: frozenPack.schema,
    source: frozenPack.source,
    features: GNM_MORPHOLOGY_FEATURES,
    families: frozenPack.families,
    means: Object.freeze(means),
    pack: frozenPack,
  });
}

export const GNM_MORPHOLOGY_ADAPTER = GNM_PACK_INJECTION == null
  ? null
  : createGnmMorphologyAdapter(GNM_PACK_INJECTION);

export function selectMorphologyFamily(profile) {
  const values = getFaceValues(profile);
  return FAMILY_BY_ID.get(selectFamilyIdFromFaceDna(values, ANALYTIC_FAMILY_IDS));
}

export function morphologyIdentitySignature(profile) {
  const values = getFaceValues(profile);
  return `${profile.seed >>> 0}:${values.head}:${values.jaw}:${values.faceProportion}:${values.earShape}:${values.eyes}:${values.brows}:${values.nose}:${values.mouth}`;
}

const GNM_RUNTIME_BOUNDS = Object.freeze({
  craniumWidth: [0.88, 1.16], cheekWidth: [0.88, 1.16], jawWidth: [0.74, 1.23], chinWidth: [0.68, 1.18],
  faceHeight: [0.84, 1.18], foreheadHeight: [0.82, 1.28], eyeSpacing: [0.89, 1.12], eyeWidth: [0.90, 1.12],
  eyeHeight: [0.88, 1.14], noseLength: [0.84, 1.18], noseWidth: [0.82, 1.18], mouthWidth: [0.82, 1.16],
  earScale: [0.82, 1.28], templeSlope: [0.84, 1.14],
});

function requireGnmAdapter(adapter) {
  if (adapter == null) {
    throw new Error("GNM morphology is unavailable: inject the generated pack or run build:offline; analytic sports/morph-v1 remains the default.");
  }
  return adapter;
}

export function selectGnmMorphologyFamily(profile, adapter = GNM_MORPHOLOGY_ADAPTER) {
  const resolvedAdapter = requireGnmAdapter(adapter);
  const values = getFaceValues(profile);
  const familyId = selectFamilyIdFromFaceDna(values, GNM_FAMILY_IDS);
  const family = resolvedAdapter.families.find((candidate) => candidate.id === familyId);
  if (!family) throw new Error(`GNM morphology pack is missing mapped family ${familyId}`);
  return family;
}

export function buildGnmRuntimeMetrics(adapter, family) {
  const resolvedAdapter = requireGnmAdapter(adapter);
  const metrics = {};
  for (const feature of resolvedAdapter.features) {
    const runtimeFeature = feature === "earSpan" ? "earScale" : feature;
    const [min, max] = GNM_RUNTIME_BOUNDS[runtimeFeature];
    metrics[runtimeFeature] = clamp(family.centroid[feature] / resolvedAdapter.means[feature], min, max);
  }
  return Object.freeze(metrics);
}

export function buildMorphology(profile, overrides = {}) {
  const values = getFaceValues(profile);
  const family = overrides.family ?? selectMorphologyFamily(profile);
  const seed = profile.seed >>> 0;
  const baseMetrics = overrides.metricBase ?? family;
  const expression = deriveMicroExpressionProfile(profile, overrides.expressionMode);

  const headWidthDelta = [0, 0.035, -0.03, 0.015, 0.03, -0.015][values.head] ?? 0;
  const jawDelta = [-0.105, -0.055, 0, 0.05, 0.095, 0.125][values.jaw] ?? 0;
  const ratioDelta = [-0.075, -0.04, 0, 0.038, 0.075, 0.105][values.faceProportion] ?? 0;
  const micro = (key, amount) => unitNoise(seed, key) * amount;

  const metrics = overrides.metrics ?? Object.freeze({
    craniumWidth: clamp(baseMetrics.craniumWidth + headWidthDelta + micro("cranium", 0.018), 0.88, 1.16),
    cheekWidth: clamp(baseMetrics.cheekWidth + headWidthDelta * 0.55 + micro("cheek", 0.016), 0.88, 1.16),
    jawWidth: clamp(baseMetrics.jawWidth + jawDelta + micro("jaw", 0.012), 0.74, 1.23),
    chinWidth: clamp(baseMetrics.chinWidth + jawDelta * 0.52 + micro("chin", 0.014), 0.68, 1.18),
    faceHeight: clamp(baseMetrics.faceHeight + ratioDelta + micro("height", 0.012), 0.84, 1.18),
    foreheadHeight: clamp(baseMetrics.foreheadHeight + (values.faceProportion === 5 ? 0.08 : 0) + micro("forehead", 0.012), 0.82, 1.28),
    eyeSpacing: clamp(baseMetrics.eyeSpacing + micro("eye-spacing", 0.018), 0.89, 1.12),
    eyeWidth: clamp(baseMetrics.eyeWidth + micro("eye-width", 0.02), 0.90, 1.12),
    eyeHeight: clamp(baseMetrics.eyeHeight + micro("eye-height", 0.018), 0.88, 1.14),
    noseLength: clamp(baseMetrics.noseLength + ([0, .02, -.02, -.06, .07, .08, .015, -.03][values.nose] ?? 0), 0.84, 1.18),
    noseWidth: clamp(baseMetrics.noseWidth + ([0, .09, -.07, -.02, .02, .01, .05, .08][values.nose] ?? 0), 0.82, 1.18),
    mouthWidth: clamp(baseMetrics.mouthWidth + ([0, .09, -.08, .02, -.04, .04, .01][values.mouth] ?? 0), 0.82, 1.16),
    earScale: clamp(baseMetrics.earScale + ([0, -.12, .14, .22][values.earShape] ?? 0), 0.82, 1.28),
    templeSlope: clamp(baseMetrics.templeSlope + micro("temple", 0.018), 0.84, 1.14),
  });

  const centerX = 384;
  const topY = 137 - (metrics.foreheadHeight - 1) * 50;
  const faceHeight = 452 * metrics.faceHeight;
  const chinY = topY + faceHeight;
  const craniumHalf = 188 * metrics.craniumWidth;
  const templeHalf = craniumHalf * (0.93 + (metrics.templeSlope - 1) * 0.25);
  const cheekHalf = 171 * metrics.cheekWidth;
  const jawHalf = 148 * metrics.jawWidth;
  const chinHalf = 58 * metrics.chinWidth;
  const foreheadBand = faceHeight * (0.25 + (metrics.foreheadHeight - 1) * 0.05);

  const browY = topY + faceHeight * 0.435;
  const eyeY = topY + faceHeight * 0.585;
  const noseBridgeY = eyeY + faceHeight * 0.018;
  const noseTipY = topY + faceHeight * 0.725;
  const mouthY = topY + faceHeight * 0.825;
  const earY = topY + faceHeight * 0.59;
  const hairlineY = topY + foreheadBand;
  const eyeHalfDistance = 69.5 * metrics.eyeSpacing;
  const eyeWidth = 82 * metrics.eyeWidth;
  const eyeHeight = 41 * metrics.eyeHeight;
  const mouthHalf = 55 * metrics.mouthWidth;
  const noseHalf = 18 * metrics.noseWidth;
  const earWidth = 35 * metrics.earScale;
  const earHeight = 72 * metrics.earScale;

  const landmarks = Object.freeze({
    top: point(centerX, topY),
    upperLeft: point(centerX - craniumHalf * 0.68, topY + faceHeight * 0.045),
    upperRight: point(centerX + craniumHalf * 0.68, topY + faceHeight * 0.045),
    templeLeft: point(centerX - templeHalf, topY + faceHeight * 0.275),
    templeRight: point(centerX + templeHalf, topY + faceHeight * 0.275),
    cheekLeft: point(centerX - cheekHalf, topY + faceHeight * 0.575),
    cheekRight: point(centerX + cheekHalf, topY + faceHeight * 0.575),
    jawLeft: point(centerX - jawHalf, topY + faceHeight * 0.79),
    jawRight: point(centerX + jawHalf, topY + faceHeight * 0.79),
    chinLeft: point(centerX - chinHalf, topY + faceHeight * 0.945),
    chinRight: point(centerX + chinHalf, topY + faceHeight * 0.945),
    chin: point(centerX, chinY),
    earLeft: point(centerX - Math.max(cheekHalf, templeHalf) - earWidth * 0.33, earY),
    earRight: point(centerX + Math.max(cheekHalf, templeHalf) + earWidth * 0.33, earY),
    browLeft: point(centerX - eyeHalfDistance, browY),
    browRight: point(centerX + eyeHalfDistance, browY),
    eyeLeft: point(centerX - eyeHalfDistance, eyeY),
    eyeRight: point(centerX + eyeHalfDistance, eyeY),
    noseBridge: point(centerX, noseBridgeY),
    noseTip: point(centerX, noseTipY),
    noseLeft: point(centerX - noseHalf, noseTipY - 2),
    noseRight: point(centerX + noseHalf, noseTipY - 2),
    mouthLeft: point(centerX - mouthHalf, mouthY),
    mouthRight: point(centerX + mouthHalf, mouthY),
    mouthCenter: point(centerX, mouthY),
    hairlineLeft: point(centerX - craniumHalf * 0.69, hairlineY + faceHeight * 0.025),
    hairlineCenter: point(centerX, hairlineY),
    hairlineRight: point(centerX + craniumHalf * 0.69, hairlineY + faceHeight * 0.025),
  });

  const transforms = Object.freeze({
    eyes: Object.freeze({
      cx: round(centerX + expression.parameters.eyes.offsetX),
      cy: round(eyeY + expression.parameters.eyes.offsetY),
      sx: round((eyeHalfDistance * 2) / 139 * expression.parameters.eyes.scaleX),
      sy: round(eyeHeight / 41 * expression.parameters.eyes.scaleY),
      originX: 130.5, originY: 39,
    }),
    brows: Object.freeze({
      cx: round(centerX + expression.parameters.brows.offsetX),
      cy: round(browY + expression.parameters.brows.offsetY),
      sx: round((eyeHalfDistance * 2.08) / 150 * expression.parameters.brows.scaleX),
      sy: round((0.92 + (metrics.foreheadHeight - 1) * 0.12) * expression.parameters.brows.scaleY),
      originX: 119, originY: 52,
    }),
    mouth: Object.freeze({
      cx: round(centerX + expression.parameters.mouth.offsetX),
      cy: round(mouthY + expression.parameters.mouth.offsetY),
      sx: round(mouthHalf / 55 * expression.parameters.mouth.scaleX),
      sy: round((0.98 + micro("mouth-height", 0.04)) * expression.parameters.mouth.scaleY),
      originX: 58.5, originY: 27,
    }),
    nose: Object.freeze({
      cx: centerX, cy: (noseBridgeY + noseTipY) / 2,
      sx: round(metrics.noseWidth), sy: round(metrics.noseLength),
      originX: 384, originY: 444,
    }),
    glasses: Object.freeze({
      cx: centerX, cy: eyeY,
      sx: round(clamp((eyeHalfDistance * 2) / 139, 0.90, 1.12)),
      sy: round(clamp(eyeHeight / 41, 0.91, 1.10)),
      originX: 384, originY: 405,
    }),
    hairFront: Object.freeze({
      cx: centerX, cy: topY - 140,
      sx: round(craniumHalf / 188),
      sy: round(clamp(0.96 + (metrics.faceHeight - 1) * 0.36, 0.92, 1.08)),
      originX: 226, originY: 0,
    }),
    hairRear: Object.freeze({
      cx: centerX, cy: topY + faceHeight * 0.44,
      sx: round(craniumHalf / 188),
      sy: round(clamp(metrics.faceHeight, 0.90, 1.12)),
      originX: 224, originY: 0,
    }),
    beard: Object.freeze({
      cx: centerX, cy: mouthY - 111,
      sx: round(clamp(jawHalf / 148, 0.82, 1.20)),
      sy: round(clamp(metrics.faceHeight, 0.92, 1.12)),
      originX: 160, originY: 0,
    }),
  });

  const morphology = Object.freeze({
    version: overrides.version ?? MORPHOLOGY_PACK_VERSION,
    source: overrides.source ?? MORPHOLOGY_SOURCE,
    identitySignature: morphologyIdentitySignature(profile),
    family: Object.freeze({ id: family.id, label: family.label }),
    expression,
    metrics,
    bounds: Object.freeze({
      left: round(centerX - Math.max(craniumHalf, cheekHalf)),
      right: round(centerX + Math.max(craniumHalf, cheekHalf)),
      top: round(topY), bottom: round(chinY),
      width: round(Math.max(craniumHalf, cheekHalf) * 2), height: round(faceHeight),
    }),
    dimensions: Object.freeze({
      centerX, topY: round(topY), chinY: round(chinY), faceHeight: round(faceHeight),
      craniumHalf: round(craniumHalf), templeHalf: round(templeHalf), cheekHalf: round(cheekHalf),
      jawHalf: round(jawHalf), chinHalf: round(chinHalf), earWidth: round(earWidth), earHeight: round(earHeight),
      eyeHalfDistance: round(eyeHalfDistance), eyeWidth: round(eyeWidth), eyeHeight: round(eyeHeight),
      noseHalf: round(noseHalf), mouthHalf: round(mouthHalf), hairlineY: round(hairlineY),
    }),
    landmarks,
    transforms,
  });
  return overrides.familySelection
    ? Object.freeze({ ...morphology, familySelection: overrides.familySelection })
    : morphology;
}

export function buildGnmMorphology(profile, adapter = GNM_MORPHOLOGY_ADAPTER, overrides = {}) {
  const resolvedAdapter = requireGnmAdapter(adapter);
  const family = selectGnmMorphologyFamily(profile, resolvedAdapter);
  return buildMorphology(profile, {
    family,
    metricBase: buildGnmRuntimeMetrics(resolvedAdapter, family),
    expressionMode: overrides.expressionMode,
    version: GNM_MORPHOLOGY_VERSION,
    source: resolvedAdapter.source,
    familySelection: Object.freeze({
      method: "face-dna-semantic-shape",
      semantic: true,
      inputs: GNM_FAMILY_SELECTION_INPUTS,
      version: GNM_FAMILY_SELECTION_VERSION,
      rules: GNM_FAMILY_SELECTION_RULES,
      note: GNM_FAMILY_SELECTION_NOTE,
    }),
  });
}

function p(landmark) { return `${round(landmark.x, 2)} ${round(landmark.y, 2)}`; }

export function buildHeadPath(morphology) {
  const l = morphology.landmarks;
  const d = morphology.dimensions;
  const leftUpperControl = point(l.top.x - d.craniumHalf * 0.54, l.top.y - 2);
  const rightUpperControl = point(l.top.x + d.craniumHalf * 0.54, l.top.y - 2);
  return [
    `M${p(l.top)}`,
    `C${p(rightUpperControl)} ${p(l.upperRight)} ${p(l.templeRight)}`,
    `C${round(l.templeRight.x + 10, 2)} ${round(l.templeRight.y + d.faceHeight * .12, 2)} ${round(l.cheekRight.x + 6, 2)} ${round(l.cheekRight.y - d.faceHeight * .06, 2)} ${p(l.cheekRight)}`,
    `C${round(l.cheekRight.x - 2, 2)} ${round(l.cheekRight.y + d.faceHeight * .10, 2)} ${round(l.jawRight.x + 10, 2)} ${round(l.jawRight.y - d.faceHeight * .04, 2)} ${p(l.jawRight)}`,
    `C${round(l.jawRight.x - 4, 2)} ${round(l.jawRight.y + d.faceHeight * .10, 2)} ${round(l.chinRight.x + 16, 2)} ${round(l.chinRight.y - d.faceHeight * .02, 2)} ${p(l.chinRight)}`,
    `C${round(l.chinRight.x - 12, 2)} ${round(l.chinRight.y + d.faceHeight * .05, 2)} ${round(l.chin.x + d.chinHalf * .44, 2)} ${round(l.chin.y, 2)} ${p(l.chin)}`,
    `C${round(l.chin.x - d.chinHalf * .44, 2)} ${round(l.chin.y, 2)} ${round(l.chinLeft.x + 12, 2)} ${round(l.chinLeft.y + d.faceHeight * .05, 2)} ${p(l.chinLeft)}`,
    `C${round(l.chinLeft.x - 16, 2)} ${round(l.chinLeft.y - d.faceHeight * .02, 2)} ${round(l.jawLeft.x + 4, 2)} ${round(l.jawLeft.y + d.faceHeight * .10, 2)} ${p(l.jawLeft)}`,
    `C${round(l.jawLeft.x - 10, 2)} ${round(l.jawLeft.y - d.faceHeight * .04, 2)} ${round(l.cheekLeft.x + 2, 2)} ${round(l.cheekLeft.y + d.faceHeight * .10, 2)} ${p(l.cheekLeft)}`,
    `C${round(l.cheekLeft.x - 6, 2)} ${round(l.cheekLeft.y - d.faceHeight * .06, 2)} ${round(l.templeLeft.x - 10, 2)} ${round(l.templeLeft.y + d.faceHeight * .12, 2)} ${p(l.templeLeft)}`,
    `C${p(l.upperLeft)} ${p(leftUpperControl)} ${p(l.top)}Z`,
  ].join(" ");
}

export function buildMorphologySvgOverlay(morphology, { labels = false } = {}) {
  const points = Object.entries(morphology.landmarks).map(([name, value]) => {
    const text = labels ? `<text x="${value.x + 6}" y="${value.y - 6}" font-size="10" fill="#d9fff4">${name}</text>` : "";
    return `<g><circle cx="${value.x}" cy="${value.y}" r="3.4" fill="#34f5b5" stroke="#052d25" stroke-width="1.2"/>${text}</g>`;
  }).join("");
  const l = morphology.landmarks;
  const guides = [
    `M${l.top.x} ${l.top.y}L${l.chin.x} ${l.chin.y}`,
    `M${l.eyeLeft.x} ${l.eyeLeft.y}L${l.eyeRight.x} ${l.eyeRight.y}`,
    `M${l.mouthLeft.x} ${l.mouthLeft.y}L${l.mouthRight.x} ${l.mouthRight.y}`,
    `M${l.hairlineLeft.x} ${l.hairlineLeft.y}Q${l.hairlineCenter.x} ${l.hairlineCenter.y - 8} ${l.hairlineRight.x} ${l.hairlineRight.y}`,
  ].map((d) => `<path d="${d}" fill="none" stroke="#34f5b5" stroke-width="1.5" stroke-dasharray="6 5" opacity=".78"/>`).join("");
  return `<g data-morphology-overlay="true" pointer-events="none">${guides}${points}<rect x="18" y="694" width="350" height="48" rx="14" fill="#071018" opacity=".88"/><text x="38" y="724" fill="#e6fff8" font-size="18" font-family="system-ui,sans-serif" font-weight="700">${morphology.family.label} · ${morphology.family.id}</text></g>`;
}
