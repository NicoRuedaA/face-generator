import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ASSET_CATALOGS,
  IDENTITY_VARS,
  APPEARANCE_VARS,
  createProfile,
  hashSeed,
  setFeature,
  setKit,
  setPresentation,
  ageProfile,
} from "../src/face-model.js";
import { deriveMicroExpressionProfile } from "../src/morphology.js";
import { parseWebglGlb } from "../src/webgl-renderer.js";
import {
  GNM_PLAYER_BEARD_STYLES,
  GNM_PLAYER_BROW_STYLES,
  GNM_PLAYER_EXPRESSION_WEIGHTS,
  GNM_PLAYER_GEOMETRIC_TRAITS,
  GNM_PLAYER_HAIR_COLORS,
  GNM_PLAYER_HAIR_STYLES,
  GNM_PLAYER_IRIS_COLORS,
  GNM_PLAYER_LABEL_TARGETS,
  GNM_PLAYER_PRIOR_SHARES,
  GNM_PLAYER_SKIN_TONES,
  GNM_PLAYER_TARGET_TAU,
  computeGnmPlayerNormals,
  describeGnmPlayerMapping,
  gnmPlayerAppearance,
  gnmPlayerExpression,
  gnmPlayerFeatureTargets,
  gnmPlayerFeatureZ,
  gnmPlayerHairCoverage,
  gnmPlayerHairThicknessMm,
  gnmPlayerPrior,
  measureGnmPlayerFeatures,
  parseGnmPlayerPayload,
  reconstructGnmPlayerPositions,
  sampleGnmPlayerIdentity,
} from "../src/gnm-player-model.js";
import { buildGnmPlayerBust, buildGnmPlayerCamera, buildGnmPlayerStatic, clampGnmPlayerCamera, computeGnmPlayerFrame } from "../src/gnm-player-renderer.js";

const work = new URL("../tools/gnm/work/", import.meta.url);
const read = (name) => {
  const buffer = fs.readFileSync(new URL(name, work));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};
const metadata = JSON.parse(fs.readFileSync(new URL("gnm-player-generator.json", work), "utf8"));
const model = parseGnmPlayerPayload(metadata, read("gnm-player-generator.bin"));
const asset = parseWebglGlb(read("gnm-official-head-render.glb"));
const staticData = buildGnmPlayerStatic(asset, model);
const resources = { model, asset, staticData };

// Payload parsing fails closed.
assert.throws(() => parseGnmPlayerPayload({ ...metadata, schema: "other" }, read("gnm-player-generator.bin")), /schema/);
assert.throws(() => parseGnmPlayerPayload({ ...metadata, semanticMapping: "disabled" }, read("gnm-player-generator.bin")), /safety/);
assert.throws(() => parseGnmPlayerPayload(metadata, read("gnm-player-generator.bin").slice(0, 1024)), /budget/);

// FaceDNA catalog parity: every geometric label, palette and style is covered.
const values = Object.fromEntries([...IDENTITY_VARS, ...APPEARANCE_VARS].map((variable) => [variable.key, variable.validValues]));
for (const trait of GNM_PLAYER_GEOMETRIC_TRAITS) {
  assert.equal(GNM_PLAYER_LABEL_TARGETS[trait].length, values[trait], `${trait} label table size`);
  GNM_PLAYER_LABEL_TARGETS[trait].forEach((entry, index) => {
    assert.equal(entry.asset, ASSET_CATALOGS[trait][index], `${trait}[${index}] catalog id`);
    for (const feature of Object.keys(entry.targets)) assert.ok(model.featureIndex.has(feature), `${feature} is a measured feature`);
  });
}
assert.ok(Math.abs(Object.values(GNM_PLAYER_PRIOR_SHARES).reduce((sum, share) => sum + share, 0) - 1) < 1e-12);
assert.equal(GNM_PLAYER_SKIN_TONES.length, values.skin);
assert.equal(GNM_PLAYER_IRIS_COLORS.length, values.eyeColor);
assert.equal(GNM_PLAYER_HAIR_COLORS.length, values.hairColor);
assert.deepEqual(GNM_PLAYER_HAIR_STYLES.map((style) => style.asset), ASSET_CATALOGS.hair);
assert.deepEqual(GNM_PLAYER_BEARD_STYLES.map((style) => style.asset), ASSET_CATALOGS.beard);
assert.deepEqual(GNM_PLAYER_BROW_STYLES.map((style) => style.asset), ASSET_CATALOGS.brows);

// Static render data covers every official triangle exactly once.
const triangleCount = asset.json.meshes[0].primitives.reduce((sum, primitive) => sum + asset.json.accessors[primitive.indices].count, 0);
const { ranges } = staticData;
assert.equal(ranges.skin.count + ranges.eye.count + ranges.cornea.count + ranges.teeth.count + ranges.tongue.count, triangleCount);
assert.equal(staticData.renderCount, metadata.dimensions.renderVertexCount);
assert.ok(ranges.cornea.count > 0 && ranges.hair.count > 0 && staticData.neckLoop.length >= 32);

// Determinism and identity-only invariance.
const base = createProfile({ seed: hashSeed("gnm-player-base"), age: 24, presentation: "neutral" });
const identity = sampleGnmPlayerIdentity(base, model);
assert.deepEqual(sampleGnmPlayerIdentity(base, model).coefficients, identity.coefficients);
const sameIdentity = [
  ageProfile(base, 20),
  setPresentation(base, "feminine", { rerollAppearance: true }),
  setKit(base, "#123456", "#abcdef"),
  { ...base, seed: (base.seed + 99) >>> 0 },
  setFeature(base, "hair", 7),
  setFeature(base, "beard", 3),
  setFeature(base, "skin", (setFeature(base, "skin", 0).identityBits === base.identityBits ? 5 : 0)),
  setFeature(base, "eyeColor", 3),
  setFeature(base, "freckles", 1),
];
for (const variant of sameIdentity) assert.deepEqual(sampleGnmPlayerIdentity(variant, model).coefficients, identity.coefficients, "non-geometric changes must not alter identity");

// Editing one geometric trait keeps most of the compositional prior.
const priorBase = gnmPlayerPrior(base, model.priorCount);
const correlation = (a, b) => {
  let ab = 0; let aa = 0; let bb = 0;
  for (let index = 0; index < a.length; index += 1) { ab += a[index] * b[index]; aa += a[index] ** 2; bb += b[index] ** 2; }
  return ab / Math.sqrt(aa * bb);
};
const noseEdited = setFeature(base, "nose", (base.identityBits >>> 12) % 8 === 1 ? 2 : 1);
assert.ok(correlation(priorBase, gnmPlayerPrior(noseEdited, model.priorCount)) > 0.6, "single-trait edits keep the face recognisable");
let unrelated = 0;
for (let index = 0; index < 20; index += 1) unrelated += Math.abs(correlation(priorBase, gnmPlayerPrior(createProfile({ seed: hashSeed(`other:${index}`) }), model.priorCount)));
assert.ok(unrelated / 20 < 0.45, "different players are not correlated");

// Exact reconstruction: measured landmark features equal the linear prediction.
const positions = reconstructGnmPlayerPositions(model, staticData.template, identity);
const measuredZ = gnmPlayerFeatureZ(model, measureGnmPlayerFeatures(model, positions));
for (const feature of model.featureKeys) assert.ok(Math.abs(measuredZ[feature] - identity.realizedZ[feature]) < 2e-3, `${feature} reconstruction is exact`);
const template = gnmPlayerFeatureZ(model, measureGnmPlayerFeatures(model, staticData.template));
for (const feature of model.featureKeys) assert.ok(Math.abs(template[feature]) < 1e-3, `${feature} template z is zero`);

// FaceDNA labels move their measured features in the labelled direction.
const pairs = [
  ["nose", 1, 2, "noseWidth"],
  ["nose", 4, 3, "noseLength"],
  ["nose", 5, 7, "bridgeHeight"],
  ["mouth", 1, 2, "mouthWidth"],
  ["mouth", 3, 4, "lipThickness"],
  ["mouth", 5, 6, "mouthCornerLift"],
  ["eyes", 1, 3, "eyeOpening"],
  ["eyes", 4, 5, "canthalTilt"],
  ["jaw", 4, 0, "jawWidth"],
  ["faceProportion", 4, 0, "faceHeight"],
  ["brows", 7, 6, "browHeight"],
  ["earShape", 2, 1, "earHeight"],
];
const shrink = 1 / (1 + GNM_PLAYER_TARGET_TAU ** 2);
for (const [trait, high, low, feature] of pairs) {
  let wins = 0;
  let sumHigh = 0;
  const bases = 24;
  for (let index = 0; index < bases; index += 1) {
    const player = createProfile({ seed: hashSeed(`gnm-player-pair:${trait}:${index}`) });
    const zHigh = sampleGnmPlayerIdentity(setFeature(player, trait, high), model).realizedZ[feature];
    const zLow = sampleGnmPlayerIdentity(setFeature(player, trait, low), model).realizedZ[feature];
    if (zHigh > zLow) wins += 1;
    sumHigh += zHigh;
  }
  assert.ok(wins >= bases - 1, `${trait} ${high} vs ${low} orders ${feature} (${wins}/${bases})`);
  const expected = Math.min(2, GNM_PLAYER_LABEL_TARGETS[trait][high].targets[feature]) * shrink;
  assert.ok(Math.abs(sumHigh / bases - expected) < 0.45, `${trait} ${feature} mean z ${sumHigh / bases} near ${expected}`);
}

// Population bounds: official coefficients stay in a plausible range.
let maxCoefficient = 0;
for (let index = 0; index < 250; index += 1) {
  const player = createProfile({ seed: hashSeed(`gnm-player-population:${index}`) });
  const sample = sampleGnmPlayerIdentity(player, model);
  assert.ok(sample.coefficients.every(Number.isFinite));
  assert.equal(sample.coefficients.length, 170);
  maxCoefficient = Math.max(maxCoefficient, sample.maxAbsCoefficient);
  for (const [feature, z] of Object.entries(gnmPlayerFeatureTargets(player).targets)) assert.ok(Math.abs(z) <= 2, `${feature} target clamp`);
}
assert.ok(maxCoefficient < 4.6, `max |coefficient| ${maxCoefficient}`);

// Official expression presets follow the shared micro-expression modes.
for (const mode of ["neutral", "alert", "soft", "focused"]) assert.deepEqual(gnmPlayerExpression(base, mode).weights, { ...GNM_PLAYER_EXPRESSION_WEIGHTS[mode] });
assert.equal(gnmPlayerExpression(base, "auto").mode, deriveMicroExpressionProfile(base, "auto").mode);
const neutralFeatures = measureGnmPlayerFeatures(model, positions);
const soft = measureGnmPlayerFeatures(model, reconstructGnmPlayerPositions(model, staticData.template, identity, { happy: 0.6 }));
const focused = measureGnmPlayerFeatures(model, reconstructGnmPlayerPositions(model, staticData.template, identity, { squint: 0.6 }));
const alert = measureGnmPlayerFeatures(model, reconstructGnmPlayerPositions(model, staticData.template, identity, { surprise: 0.6 }));
assert.ok(soft.mouthCornerLift > neutralFeatures.mouthCornerLift + 1, "official HAPPY preset lifts the mouth corners");
assert.ok(focused.eyeOpening < neutralFeatures.eyeOpening - 1, "official SQUINT preset narrows the eyes");
assert.ok(alert.browHeight > neutralFeatures.browHeight + 0.5, "official SURPRISE preset raises the brows");
assert.throws(() => reconstructGnmPlayerPositions(model, staticData.template, identity, { unknown: 1 }), /preset/);

// Appearance: pigments by catalog label, age greying, painted styles.
const young = gnmPlayerAppearance(setFeature(setFeature(base, "hairColor", 0), "hairVisible", 1));
const old = gnmPlayerAppearance(ageProfile(setFeature(setFeature(base, "hairColor", 0), "hairVisible", 1), 36));
assert.ok(old.hair.reduce((sum, value) => sum + value, 0) > young.hair.reduce((sum, value) => sum + value, 0), "hair greys with age");
const blue = gnmPlayerAppearance(setFeature(base, "eyeColor", 2));
assert.ok(blue.iris[2] > blue.iris[0], "eye/blue iris is blue");
assert.equal(gnmPlayerAppearance(setFeature(base, "hairVisible", 0)).hairStyle, null);

// Hair shell helpers mirror the shader: zero below the hairline, positive above.
const style = GNM_PLAYER_HAIR_STYLES[4];
assert.equal(gnmPlayerHairThicknessMm(style, -20, 1), 0);
assert.ok(gnmPlayerHairThicknessMm(style, 40, 1) > style.thickness);
assert.ok(gnmPlayerHairCoverage(style, 10, 1) > 0.99 && gnmPlayerHairCoverage(style, -10, 1) < 0.01);
assert.equal(gnmPlayerHairThicknessMm(null, 40, 1), 0);

// Normals are unit length and outward on the scalp.
const normals = computeGnmPlayerNormals(positions, staticData.sourceTriangles, model.vertexCount);
for (let vertex = 0; vertex < model.vertexCount; vertex += 97) {
  const length = Math.hypot(normals[vertex * 3], normals[vertex * 3 + 1], normals[vertex * 3 + 2]);
  assert.ok(Math.abs(length - 1) < 1e-4);
}
const top = metadata.fixedVertices.foreheadTop;
assert.ok(normals[top * 3 + 2] > 0.5, "forehead normal faces forward");

// Full CPU frame and camera/bust helpers stay finite and bounded.
const frame = computeGnmPlayerFrame(resources, base, { expressionMode: "soft" });
assert.ok(frame.renderPositions.every(Number.isFinite) && frame.renderNormals.every(Number.isFinite));
assert.ok(frame.shell.positions.every(Number.isFinite));
const bust = buildGnmPlayerBust(staticData.neckLoop, positions);
assert.ok(bust.vertices.every(Number.isFinite) && bust.indices.length > 0);
const camera = buildGnmPlayerCamera({ yaw: 99, pitch: -99, distance: 99 }, 1);
assert.deepEqual(camera.camera, clampGnmPlayerCamera({ yaw: 99, pitch: -99, distance: 99 }));
assert.ok(camera.view.every(Number.isFinite) && camera.projection.every(Number.isFinite));

const description = describeGnmPlayerMapping(base, { expressionMode: "focused" });
assert.equal(description.identity.identityOnly, true);
assert.equal(description.semanticMapping, "measured-landmark-features-v1");
assert.equal(description.officialTexturesIncluded, false);
assert.equal(description.expression.mode, "focused");

console.log(`PASS GNM 3D player tests: payload parse, catalog parity, identity-only invariance, compositional edits, exact reconstruction, ${pairs.length} label/feature orderings, bounds (max |c| ${maxCoefficient.toFixed(2)}), official expression presets, appearance, hair shell, normals, frame`);
