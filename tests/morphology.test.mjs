import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ageProfile,
  createProfile,
  formatFaceCode,
  getFaceValues,
  hashSeed,
  setFeature,
  setKit,
  setPresentation,
} from "../src/face-model.js";
import {
  WEBGL_MORPH_RENDER_STYLE,
  WEBGL_MORPH_WEIGHT_LIMIT,
  DEFAULT_WEBGL_CAMERA,
  buildWebglProjection,
  buildWebglCameraMatrix,
  clampWebglCamera,
  describeWebglMapping,
  describeOfficialWebglMapping,
  expandWebglBounds,
  mapWebglWeights,
  parseWebglGlb,
} from "../src/webgl-renderer.js";
import {
  GNM_MORPH_RENDER_STYLE,
  GNM_MORPHOLOGY_ADAPTER,
  GNM_MORPHOLOGY_SCHEMA,
  GNM_MORPHOLOGY_VERSION,
  GNM_FAMILY_SELECTION_INPUTS,
  GNM_FAMILY_SELECTION_NOTE,
  GNM_FAMILY_SELECTION_RULES,
  GNM_FAMILY_SELECTION_VERSION,
  EXPRESSION_MODES,
  MICRO_EXPRESSION_MODES,
  MICRO_EXPRESSION_VERSION,
  MORPHOLOGY_FAMILIES,
  MORPHOLOGY_SOURCE,
  buildHeadPath,
  buildGnmMorphology,
  buildGnmRuntimeMetrics,
  buildMorphology,
  createGnmMorphologyAdapter,
  deriveMicroExpressionProfile,
  morphologyIdentitySignature,
  selectGnmMorphologyFamily,
} from "../src/morphology.js";
import {
  MORPH_RENDER_STYLE,
  buildGnmMorphSvg,
  buildMorphSvg,
  describeMorphMapping,
} from "../src/morph-renderer.js";
import {
  RENDER_STYLES,
  describeRender,
  isRenderStyle,
} from "../src/render-router.js";

assert.equal(MORPHOLOGY_FAMILIES.length, 8);
assert.equal(new Set(MORPHOLOGY_FAMILIES.map((item) => item.id)).size, 8);
assert.equal(MORPHOLOGY_SOURCE.gnmDerived, false);
assert.equal(GNM_MORPHOLOGY_SCHEMA, "sports-face-morphology-pack/v1");

const gnmPack = JSON.parse(fs.readFileSync(new URL("../tools/gnm/work/gnm-morphology-pack.json", import.meta.url), "utf8"));
const officialGlb = fs.readFileSync(new URL("../tools/gnm/work/gnm-official-head.glb", import.meta.url));
const officialAsset = parseWebglGlb(officialGlb.buffer.slice(officialGlb.byteOffset, officialGlb.byteOffset + officialGlb.byteLength));
assert.equal(officialAsset.official, true);
assert.deepEqual(officialAsset.primitives.map((primitive) => primitive.name), ["skin", "left_eye", "right_eye", "upper_teeth_and_gums", "lower_teeth_and_gums", "tongue"]);
assert.equal(officialAsset.primitives.length, 6);
assert.equal(describeOfficialWebglMapping().mapping.applied, false);
const gnmAdapter = createGnmMorphologyAdapter(gnmPack);
assert.equal(GNM_MORPHOLOGY_ADAPTER, null);
globalThis.sportsFaceGnmPack = gnmPack;
const globalFallbackMorphology = await import("../src/morphology.js?global-fallback");
assert.ok(globalFallbackMorphology.GNM_MORPHOLOGY_ADAPTER);
delete globalThis.sportsFaceGnmPack;
assert.equal(gnmAdapter.families.length, 8);
assert.deepEqual(gnmAdapter.features, [
  "craniumWidth", "cheekWidth", "jawWidth", "chinWidth", "faceHeight",
  "foreheadHeight", "eyeSpacing", "eyeWidth", "eyeHeight", "noseLength",
  "noseWidth", "mouthWidth", "earSpan", "templeSlope",
]);

function assertInvalidPack(mutator, message) {
  const malformed = JSON.parse(JSON.stringify(gnmPack));
  mutator(malformed);
  assert.throws(() => createGnmMorphologyAdapter(malformed), new RegExp(message));
}

assertInvalidPack((pack) => { pack.schema = "wrong"; }, "schema");
assertInvalidPack((pack) => { pack.families.pop(); }, "families");
assertInvalidPack((pack) => { pack.clustering.features.pop(); }, "features");
assertInvalidPack((pack) => { delete pack.families[0].centroid.jawWidth; }, "centroid");
assertInvalidPack((pack) => { pack.families[0].centroid.jawWidth = "wide"; }, "jawWidth");

let gnmProfile = createProfile({ seed: hashSeed("gnm-runtime"), age: 22, presentation: "neutral" });
gnmProfile = setFeature(gnmProfile, "head", 2);
gnmProfile = setFeature(gnmProfile, "faceProportion", 2);
const gnmFamily = selectGnmMorphologyFamily(gnmProfile, gnmAdapter);
assert.equal(gnmFamily.id, "gnm-07-long");
assert.equal(selectGnmMorphologyFamily(gnmProfile, gnmAdapter).id, gnmFamily.id);
const changedSeed = { ...gnmProfile, seed: (gnmProfile.seed + 1) >>> 0 };
const changedAppearance = setFeature(gnmProfile, "hair", 3);
const changedAge = ageProfile(gnmProfile, 9);
const changedKit = setKit(gnmProfile, "#ff0000", "#00ff00");
for (const variant of [changedSeed, changedAppearance, changedAge, changedKit]) {
  assert.equal(selectGnmMorphologyFamily(variant, gnmAdapter).id, gnmFamily.id);
}

const gnmFamilyProbes = [
  [0, 5, "gnm-08-high-forehead"],
  [1, 0, "gnm-02-compact-wide"],
  [4, 1, "gnm-02-compact-wide"],
  [0, 2, "gnm-03-balanced"],
  [1, 2, "gnm-06-broad"],
  [2, 2, "gnm-07-long"],
  [3, 2, "gnm-05-angular"],
  [4, 2, "gnm-01-compact"],
  [5, 2, "gnm-04-tapered"],
];
const reachedGnm = new Set();
for (const [head, proportion, expected] of gnmFamilyProbes) {
  let profile = createProfile({ seed: hashSeed(`gnm-family:${expected}:${head}:${proportion}`), age: 24, presentation: "neutral" });
  profile = setFeature(profile, "head", head);
  profile = setFeature(profile, "faceProportion", proportion);
  assert.equal(selectGnmMorphologyFamily(profile, gnmAdapter).id, expected);
  reachedGnm.add(selectGnmMorphologyFamily(profile, gnmAdapter).id);
}
assert.deepEqual([...reachedGnm].sort(), gnmAdapter.families.map((family) => family.id).sort());
const changedHead = setFeature(gnmProfile, "head", 1);
const changedProportion = setFeature(gnmProfile, "faceProportion", 5);
assert.notEqual(selectGnmMorphologyFamily(changedHead, gnmAdapter).id, gnmFamily.id);
assert.notEqual(selectGnmMorphologyFamily(changedProportion, gnmAdapter).id, gnmFamily.id);

const gnmMetrics = buildGnmRuntimeMetrics(gnmAdapter, gnmFamily);
const runtimeMetricNames = [
  "craniumWidth", "cheekWidth", "jawWidth", "chinWidth", "faceHeight", "foreheadHeight",
  "eyeSpacing", "eyeWidth", "eyeHeight", "noseLength", "noseWidth", "mouthWidth", "earScale", "templeSlope",
];
assert.deepEqual(Object.keys(gnmMetrics).sort(), runtimeMetricNames.sort());
assert.equal(gnmMetrics.earScale, gnmFamily.centroid.earSpan / gnmAdapter.means.earSpan);
const runtimeBounds = {
  craniumWidth: [0.88, 1.16], cheekWidth: [0.88, 1.16], jawWidth: [0.74, 1.23], chinWidth: [0.68, 1.18],
  faceHeight: [0.84, 1.18], foreheadHeight: [0.82, 1.28], eyeSpacing: [0.89, 1.12], eyeWidth: [0.90, 1.12],
  eyeHeight: [0.88, 1.14], noseLength: [0.84, 1.18], noseWidth: [0.82, 1.18], mouthWidth: [0.82, 1.16],
  earScale: [0.82, 1.28], templeSlope: [0.84, 1.14],
};
for (const feature of ["chinWidth", "eyeWidth", "eyeHeight", "templeSlope"]) {
  const expected = gnmFamily.centroid[feature] / gnmAdapter.means[feature];
  const [min, max] = runtimeBounds[feature];
  assert.equal(gnmMetrics[feature], Math.max(min, Math.min(max, expected)));
}
assert.ok(
  ["chinWidth", "eyeWidth", "eyeHeight", "templeSlope"].some((feature) =>
    gnmAdapter.families.some((family) => family.centroid[feature] !== gnmAdapter.means[feature])),
  "GNM-derived runtime features must vary across family centroids",
);
for (const family of gnmAdapter.families) {
  const metrics = buildGnmRuntimeMetrics(gnmAdapter, family);
  for (const [name, value] of Object.entries(metrics)) {
    assert.ok(value >= runtimeBounds[name][0] && value <= runtimeBounds[name][1], `${family.id}:${name} outside runtime bounds`);
  }
}

const gnmMorph = buildGnmMorphology(gnmProfile, gnmAdapter);
const gnmAnalyticExpression = buildMorphology(gnmProfile).expression;
assert.throws(() => buildGnmMorphology(gnmProfile), /inject the generated pack/);
assert.deepEqual(buildGnmMorphology(gnmProfile, gnmAdapter), gnmMorph);
assert.deepEqual(gnmMorph.expression, gnmAnalyticExpression);
assert.equal(gnmMorph.version, GNM_MORPHOLOGY_VERSION);
assert.equal(gnmMorph.source.gnmDerived, true);
assert.equal(gnmMorph.familySelection.method, "face-dna-semantic-shape");
assert.equal(gnmMorph.familySelection.semantic, true);
assert.deepEqual(gnmMorph.familySelection.inputs, GNM_FAMILY_SELECTION_INPUTS);
assert.equal(gnmMorph.familySelection.version, GNM_FAMILY_SELECTION_VERSION);
assert.deepEqual(gnmMorph.familySelection.rules, GNM_FAMILY_SELECTION_RULES);
assert.equal(gnmMorph.familySelection.note, GNM_FAMILY_SELECTION_NOTE);
const gnmJawNarrow = setFeature(gnmProfile, "jaw", 0);
const gnmJawBroad = setFeature(gnmProfile, "jaw", 5);
assert.equal(selectGnmMorphologyFamily(gnmJawNarrow, gnmAdapter).id, gnmFamily.id);
assert.equal(selectGnmMorphologyFamily(gnmJawBroad, gnmAdapter).id, gnmFamily.id);
assert.notEqual(
  buildGnmMorphology(gnmJawNarrow, gnmAdapter).metrics.jawWidth,
  buildGnmMorphology(gnmJawBroad, gnmAdapter).metrics.jawWidth,
);
const gnmSvg = buildGnmMorphSvg(gnmProfile, { gnmAdapter });
assert.match(gnmSvg, new RegExp(`data-renderer="${GNM_MORPH_RENDER_STYLE}"`));
assert.match(gnmSvg, new RegExp(`data-micro-expression-mode="${gnmMorph.expression.mode}"`));
assert.match(gnmSvg, /GNM-derived runtime morphology pack/);
assert.ok(!gnmSvg.includes("NaN"));
assert.equal(describeMorphMapping(gnmProfile).source.gnmDerived, false);

function rootJoinOffset(svg) {
  const match = svg.match(/data-morphology-root="[^"]+" transform="translate\(0 ([^)]*)\)"/);
  assert.ok(match, "morphology root must declare its join translation");
  return Number(match[1]);
}

let shortProfile = createProfile({ seed: hashSeed("morph-short-face"), age: 24, presentation: "neutral" });
shortProfile = setFeature(shortProfile, "head", 1);
shortProfile = setFeature(shortProfile, "faceProportion", 0);
const shortMorph = buildMorphology(shortProfile);
const shortSvg = buildMorphSvg(shortProfile, { showLandmarks: true });
assert.ok(shortMorph.bounds.bottom < 556);
assert.equal(rootJoinOffset(shortSvg), Math.round((556 - shortMorph.bounds.bottom) * 10000) / 10000);
assert.match(shortSvg, /data-morphology-overlay="true"/);
assert.match(shortSvg, /<linearGradient id="morphRightShadeGradient" gradientUnits="userSpaceOnUse" x1="384" y1="0" x2="768" y2="0">[\s\S]*<stop offset="0" stop-color="#000" stop-opacity="0"\/>[\s\S]*<stop offset="\.3" stop-color="#000" stop-opacity="0"\/>[\s\S]*<stop offset="\.7" stop-color="#000" stop-opacity="\.012"\/>[\s\S]*<stop offset="1" stop-color="#000" stop-opacity="\.035"\/>[\s\S]*<\/linearGradient>/);
assert.match(shortSvg, /<path d="[^"]+" fill="url\(#morphRightShadeGradient\)"\/>/);
assert.doesNotMatch(shortSvg, /<path d="[^"]+" fill="#000" opacity="\.(?:095|035)"\/>/);

let normalProfile = createProfile({ seed: hashSeed("morph-normal-face"), age: 24, presentation: "neutral" });
normalProfile = setFeature(normalProfile, "head", 0);
normalProfile = setFeature(normalProfile, "faceProportion", 2);
const normalSvg = buildMorphSvg(normalProfile);
assert.equal(rootJoinOffset(normalSvg), 0);
let tallProfile = createProfile({ seed: hashSeed("morph-tall-face"), age: 24, presentation: "neutral" });
tallProfile = setFeature(tallProfile, "faceProportion", 5);
assert.equal(rootJoinOffset(buildMorphSvg(tallProfile)), 0);

const shortGnmSvg = buildGnmMorphSvg(shortProfile, { gnmAdapter, showLandmarks: true });
assert.match(shortGnmSvg, new RegExp(`data-renderer="${GNM_MORPH_RENDER_STYLE}"`));
assert.match(shortGnmSvg, /^<svg[\s\S]*<\/svg>$/);
assert.ok(!shortGnmSvg.includes("NaN"));

assert.ok(RENDER_STYLES.some((style) => style.id === GNM_MORPH_RENDER_STYLE));
assert.equal(isRenderStyle(GNM_MORPH_RENDER_STYLE), true);
assert.equal(describeRender(gnmProfile, GNM_MORPH_RENDER_STYLE, { gnmAdapter }).renderer, GNM_MORPH_RENDER_STYLE);
assert.equal(isRenderStyle(WEBGL_MORPH_RENDER_STYLE), true);
assert.equal(describeRender(gnmProfile, WEBGL_MORPH_RENDER_STYLE).renderer, WEBGL_MORPH_RENDER_STYLE);
const webglWeights = mapWebglWeights(gnmProfile);
assert.equal(webglWeights.length, 16);
assert.ok(webglWeights.every((value) => value >= -WEBGL_MORPH_WEIGHT_LIMIT && value <= WEBGL_MORPH_WEIGHT_LIMIT));
assert.deepEqual(mapWebglWeights(gnmProfile), webglWeights, "WebGL weights must be deterministic");
const webglDescription = describeWebglMapping(gnmProfile);
assert.equal(webglDescription.targetSemantics, "neutral PCA components; not anatomical controls");
assert.equal(webglDescription.gnmRuntimeDependency, false);
assert.equal(webglDescription.mapping.identityOnly, true);
assert.deepEqual(webglDescription.mapping.inputs, [
  "head", "skin", "eyes", "brows", "nose", "mouth", "freckles", "eyeColor", "earShape", "jaw", "faceProportion",
]);

// WebGL geometry is a permanent-identity projection. Mutable profile state and
// render options must not alter its PCA weights.
const webglStable = createProfile({ seed: hashSeed("webgl-identity-contract"), age: 19, presentation: "neutral" });
const webglStableWeights = mapWebglWeights(webglStable);
const appearanceRanges = { hair: 12, beard: 6, hairColor: 8, hairVisible: 2, glasses: 2, scar: 2 };
const stableValues = getFaceValues(webglStable);
for (const [feature, range] of Object.entries(appearanceRanges)) {
  const changed = setFeature(webglStable, feature, (stableValues[feature] + 1) % range);
  assert.notEqual(getFaceValues(changed)[feature], stableValues[feature], `${feature} test did not change appearance`);
  assert.deepEqual(mapWebglWeights(changed), webglStableWeights, `${feature} changed WebGL geometry`);
}
assert.deepEqual(mapWebglWeights(ageProfile(webglStable, 31)), webglStableWeights, "age changed WebGL geometry");
assert.deepEqual(mapWebglWeights(setPresentation(webglStable, "feminine")), webglStableWeights, "presentation changed WebGL geometry");
assert.deepEqual(mapWebglWeights(setKit(webglStable, "#ff0000", "#00ff00")), webglStableWeights, "kit changed WebGL geometry");
for (const mode of EXPRESSION_MODES) {
  assert.deepEqual(
    describeWebglMapping(webglStable, { expressionMode: mode }).weights,
    webglStableWeights,
    `${mode} changed WebGL geometry`,
  );
}
const sameIdentityDifferentSeed = { ...webglStable, seed: (webglStable.seed + 1) >>> 0 };
assert.equal(sameIdentityDifferentSeed.identityBits, webglStable.identityBits);
assert.deepEqual(mapWebglWeights(sameIdentityDifferentSeed), webglStableWeights, "seed changed weights with identical identityBits");
assert.deepEqual(expandWebglBounds({ min: [-1, 0, -2], max: [1, 2, 2] }, [0.1, 0.2, 0.3]), {
  min: [-1.1, -0.2, -2.3],
  max: [1.1, 2.2, 2.3],
});
const projection = buildWebglProjection({ min: [-1, 0, -2], max: [1, 2, 2] }, 1, [0.1, 0.2, 0.3]);
assert.equal(projection.length, 16);
assert.ok([...projection].every(Number.isFinite));
assert.equal(projection[14], 0);
assert.deepEqual(DEFAULT_WEBGL_CAMERA, { yaw: 0, pitch: 0, distance: 1 });
assert.deepEqual(clampWebglCamera({ yaw: 99, pitch: -99, distance: 0 }), { yaw: Math.PI, pitch: -1.15, distance: 0.72 });
assert.deepEqual(clampWebglCamera({ yaw: -99, pitch: 99, distance: 99 }), { yaw: -Math.PI, pitch: 1.15, distance: 1.65 });
assert.deepEqual(clampWebglCamera({ yaw: "invalid", pitch: null, distance: NaN }), DEFAULT_WEBGL_CAMERA);
assert.deepEqual([...buildWebglCameraMatrix({ min: [-1, 0, -2], max: [1, 2, 2] }, 1, DEFAULT_WEBGL_CAMERA, [0.1, 0.2, 0.3])], [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);
assert.notDeepEqual(
  [...buildWebglCameraMatrix({ min: [-1, 0, -2], max: [1, 2, 2] }, 1, { yaw: 0.3, pitch: -0.2, distance: 1.2 }, [0.1, 0.2, 0.3])],
  [...buildWebglCameraMatrix({ min: [-1, 0, -2], max: [1, 2, 2] }, 1, DEFAULT_WEBGL_CAMERA, [0.1, 0.2, 0.3])],
);
assert.throws(() => buildWebglProjection({ min: [0, 0], max: [1, 1] }, 1), /three axes/);
assert.throws(() => buildWebglProjection({ min: [0, 0, 0], max: [1, 1, 1] }, 0), /positive/);
assert.throws(() => parseWebglGlb(new ArrayBuffer(20)), /header/);

const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const moduleIndexHtml = fs.readFileSync(new URL("../index.module.html", import.meta.url), "utf8");
const morphGlbBuffer = fs.readFileSync(new URL("../tools/gnm/work/head-morph.glb", import.meta.url));
const morphGlbArrayBuffer = morphGlbBuffer.buffer.slice(morphGlbBuffer.byteOffset, morphGlbBuffer.byteOffset + morphGlbBuffer.byteLength);
assert.equal(parseWebglGlb(morphGlbArrayBuffer).targets.length, 16);
for (const html of [indexHtml, moduleIndexHtml]) {
  assert.match(html, /id="expression-mode-field"/);
  assert.match(html, /id="expression-mode"/);
  for (const mode of EXPRESSION_MODES) assert.match(html, new RegExp(`value="${mode}"`));
  for (const label of ["Automática", "Neutral", "Alerta", "Relajada", "Concentrada"]) assert.match(html, new RegExp(label));
  assert.match(html, /id="portrait-webgl"/);
  assert.match(html, /id="webgl-camera-controls"/);
  assert.match(html, /id="reset-webgl-camera"/);
  assert.match(html, /arrastra para orbitar/);
}

const familyProbes = [
  [0, 2, "oval-balanced"],
  [1, 2, "broad-square"],
  [2, 2, "long-narrow"],
  [3, 2, "angular-athletic"],
  [4, 2, "compact-round"],
  [5, 2, "tapered-heart"],
  [0, 5, "high-forehead"],
  [1, 0, "low-wide"],
];

const reached = new Set();
for (const [head, proportion, expected] of familyProbes) {
  let profile = createProfile({ seed: hashSeed(`family:${expected}`), age: 24, presentation: "neutral" });
  profile = setFeature(profile, "head", head);
  profile = setFeature(profile, "faceProportion", proportion);
  const morph = buildMorphology(profile);
  assert.equal(morph.family.id, expected);
  assert.match(buildHeadPath(morph), /^M/);
  reached.add(morph.family.id);
}
assert.equal(reached.size, 8);

const baseline = JSON.parse(fs.readFileSync(new URL("../baseline/visual-baseline.json", import.meta.url), "utf8"));
for (const entry of baseline.entries) {
  const before = formatFaceCode(entry.profile);
  const firstMorph = buildMorphology(entry.profile);
  const secondMorph = buildMorphology(entry.profile);
  const firstSvg = buildMorphSvg(entry.profile);
  const secondSvg = buildMorphSvg(entry.profile);
  const mapping = describeMorphMapping(entry.profile);

  assert.deepEqual(firstMorph, secondMorph, `${entry.id}: morphology is not deterministic`);
  assert.equal(firstSvg, secondSvg, `${entry.id}: morph SVG is not deterministic`);
  assert.equal(formatFaceCode(entry.profile), before, `${entry.id}: morph renderer changed FaceDNA`);
  assert.equal(mapping.renderer, MORPH_RENDER_STYLE);
  assert.equal(mapping.morphVersion, "0.4.0");
  assert.equal(mapping.localDeformation, true);
  assert.equal(mapping.gnmRuntimeDependency, false);
  assert.equal(mapping.source.gnmDerived, false);
  assert.match(firstSvg, /data-morphology-family=/);
  assert.match(firstSvg, /data-morph-feature="eyes"/);
  assert.match(firstSvg, /data-morph-feature="brows"/);
  assert.match(firstSvg, /data-morph-feature="mouth"/);
  assert.match(firstSvg, /Starter morphology pack is analytic and GNM-ready, not GNM-derived/);
  assert.ok(!firstSvg.includes("undefined"), `${entry.id}: undefined in SVG`);
  assert.ok(!firstSvg.includes("NaN"), `${entry.id}: NaN in SVG`);

  for (const [name, landmark] of Object.entries(firstMorph.landmarks)) {
    assert.ok(Number.isFinite(landmark.x) && Number.isFinite(landmark.y), `${entry.id}:${name} invalid`);
    assert.ok(landmark.x > 80 && landmark.x < 688, `${entry.id}:${name}.x out of portrait`);
    assert.ok(landmark.y > 70 && landmark.y < 680, `${entry.id}:${name}.y out of portrait`);
  }
}

// Age and mutable appearance must not alter permanent morphology.
let stable = createProfile({ seed: hashSeed("morph-stability"), age: 19, presentation: "neutral" });
const stableSignature = morphologyIdentitySignature(stable);
const stableMorph = buildMorphology(stable);
const aged = ageProfile(stable, 31);
assert.equal(morphologyIdentitySignature(aged), stableSignature);
assert.deepEqual(buildMorphology(aged).landmarks, stableMorph.landmarks);

const hairChanged = setFeature(stable, "hair", (3 + 1) % 12);
assert.equal(morphologyIdentitySignature(hairChanged), stableSignature);
assert.deepEqual(buildMorphology(hairChanged).landmarks, stableMorph.landmarks);

const kitChanged = setKit(stable, "#ff0000", "#00ff00");
assert.equal(morphologyIdentitySignature(kitChanged), stableSignature);
assert.deepEqual(buildMorphology(kitChanged).landmarks, stableMorph.landmarks);

// Permanent variables must produce a geometric change.
const jawChanged = setFeature(stable, "jaw", 5);
assert.notEqual(buildHeadPath(buildMorphology(jawChanged)), buildHeadPath(stableMorph));
const proportionChanged = setFeature(stable, "faceProportion", 5);
assert.notEqual(buildHeadPath(buildMorphology(proportionChanged)), buildHeadPath(stableMorph));

const overlaySvg = buildMorphSvg(stable, { showLandmarks: true, landmarkLabels: true });
assert.match(overlaySvg, /data-morphology-overlay="true"/);
assert.match(overlaySvg, />eyeLeft</);

// Microexpressions are identity-derived, subtle, coordinated, and outside FaceDNA.
const stableCode = formatFaceCode(stable);
const stableExpression = deriveMicroExpressionProfile(stable);
assert.deepEqual(EXPRESSION_MODES, ["auto", "neutral", "alert", "soft", "focused"]);
assert.equal(stableExpression.version, MICRO_EXPRESSION_VERSION);
assert.equal(stableExpression.requestedMode, "auto");
assert.ok(MICRO_EXPRESSION_MODES.includes(stableExpression.mode));
assert.deepEqual(stableExpression, deriveMicroExpressionProfile(stable));
assert.deepEqual(stableExpression, deriveMicroExpressionProfile(ageProfile(stable, 12)));
assert.deepEqual(stableExpression, deriveMicroExpressionProfile(setFeature(stable, "hair", 7)));
assert.deepEqual(stableExpression, deriveMicroExpressionProfile(setKit(stable, "#123456", "#abcdef")));
assert.deepEqual(stableExpression, deriveMicroExpressionProfile(setPresentation(stable, "feminine")));
for (const feature of Object.values(stableExpression.parameters)) {
  for (const [name, value] of Object.entries(feature)) {
    assert.ok(Number.isFinite(value), `${name} must be finite`);
    if (name.startsWith("offset")) assert.ok(value >= -2 && value <= 2, `${name} outside micro-expression bounds`);
    if (name.startsWith("scale")) assert.ok(value >= 0.98 && value <= 1.02, `${name} outside micro-expression bounds`);
  }
}
assert.equal(formatFaceCode(stable), stableCode);
assert.deepEqual(buildMorphology(stable).expression, stableExpression);
assert.match(overlaySvg, new RegExp(`data-micro-expression-mode="${stableExpression.mode}"`));
assert.match(overlaySvg, /data-expression-mode="neutral-portrait"/);
assert.match(overlaySvg, /data-expression-mode-requested="auto"/);

// Explicit modes override only the expression profile and unknown values fall back to auto.
for (const mode of MICRO_EXPRESSION_MODES) {
  const explicitExpression = deriveMicroExpressionProfile(stable, mode);
  const explicitMorph = buildMorphology(stable, { expressionMode: mode });
  assert.equal(explicitExpression.requestedMode, mode);
  assert.equal(explicitExpression.mode, mode);
  assert.equal(explicitMorph.expression.mode, mode);
  assert.equal(formatFaceCode(stable), stableCode);
  assert.deepEqual(explicitMorph.family, stableMorph.family);
  assert.deepEqual(explicitMorph.metrics, stableMorph.metrics);
  assert.deepEqual(explicitMorph.landmarks, stableMorph.landmarks);
  assert.match(buildMorphSvg(stable, { expressionMode: mode }), new RegExp(`data-expression-mode-requested="${mode}"`));
  const mapping = describeMorphMapping(stable, { expressionMode: mode });
  assert.equal(mapping.expressionMode.requested, mode);
  assert.equal(mapping.expressionMode.selected, mode);
  assert.equal(buildGnmMorphology(gnmProfile, gnmAdapter, { expressionMode: mode }).expression.mode, mode);
  assert.match(buildGnmMorphSvg(gnmProfile, { gnmAdapter, expressionMode: mode }), new RegExp(`data-expression-mode-requested="${mode}"`));
}
const autoFallback = deriveMicroExpressionProfile(stable, "unknown-mode");
assert.deepEqual(autoFallback, stableExpression);
assert.deepEqual(buildMorphology(stable, { expressionMode: "unknown-mode" }).expression, stableExpression);
assert.equal(describeRender(stable, MORPH_RENDER_STYLE, { expressionMode: "unknown-mode" }).expressionMode.requested, "auto");

const expressionModes = new Set();
const expressionProfiles = new Set();
for (let eyes = 0; eyes < 6; eyes += 1) {
  for (let brows = 0; brows < 8; brows += 1) {
    for (let mouth = 0; mouth < 7; mouth += 1) {
      let profile = createProfile({ seed: hashSeed(`expression:${eyes}:${brows}:${mouth}`), age: 24, presentation: "neutral" });
      profile = setFeature(profile, "eyes", eyes);
      profile = setFeature(profile, "brows", brows);
      profile = setFeature(profile, "mouth", mouth);
      const expression = deriveMicroExpressionProfile(profile);
      expressionModes.add(expression.mode);
      expressionProfiles.add(JSON.stringify(expression.parameters));
    }
  }
}
assert.deepEqual([...expressionModes].sort(), [...MICRO_EXPRESSION_MODES].sort());
assert.ok(expressionProfiles.size > MICRO_EXPRESSION_MODES.length, "identity combinations should vary expression parameters");

const distribution = new Map();
for (let index = 0; index < 1000; index += 1) {
  const profile = createProfile({
    seed: hashSeed(`morph-test:${index}`),
    age: 16 + (index % 45),
    presentation: ["masculine", "feminine", "neutral"][index % 3],
  });
  const code = formatFaceCode(profile);
  const morph = buildMorphology(profile);
  const svg = buildMorphSvg(profile, { showAge: index % 2 === 0, showLandmarks: index % 101 === 0 });
  distribution.set(morph.family.id, (distribution.get(morph.family.id) ?? 0) + 1);
  assert.equal(formatFaceCode(profile), code);
  assert.ok(svg.length > 5000);
  assert.ok(morph.bounds.width > 300 && morph.bounds.width < 460);
  assert.ok(morph.bounds.height > 360 && morph.bounds.height < 550);
}
assert.equal(distribution.size, 8, `Expected all eight families, got ${[...distribution.keys()].join(", ")}`);

console.log(`Morph Lab tests passed: 8 families, 100 frozen identities and 1,000 generated profiles (${JSON.stringify(Object.fromEntries(distribution))}).`);
