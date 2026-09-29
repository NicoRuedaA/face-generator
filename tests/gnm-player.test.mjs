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
import { deriveMicroExpressionProfile } from "../src/player-expression.js";
import { parseWebglGlb } from "../src/gnm-assets.js";
import {
  GNM_PLAYER_BEARD_STYLES,
  GNM_PLAYER_BROW_STYLES,
  GNM_PLAYER_EXPRESSION_WEIGHTS,
  GNM_PLAYER_GEOMETRIC_TRAITS,
  GNM_PLAYER_HAIR_COLORS,
  GNM_PLAYER_HAIR_STYLES,
  GNM_PLAYER_IRIS_COLORS,
  GNM_PLAYER_LABEL_TARGETS,
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
  setFeature(base, "hair", 7),
  setFeature(base, "beard", 3),
  setFeature(base, "skin", (setFeature(base, "skin", 0).identityBits === base.identityBits ? 5 : 0)),
  setFeature(base, "eyeColor", 3),
  setFeature(base, "freckles", 1),
];
for (const variant of sameIdentity) assert.deepEqual(sampleGnmPlayerIdentity(variant, model).coefficients, identity.coefficients, "non-geometric changes must not alter identity");

// The seed defines the stable prior; local trait edits do not rerandomize it.
const priorBase = gnmPlayerPrior(base, model.priorCount);
const correlation = (a, b) => {
  let ab = 0; let aa = 0; let bb = 0;
  for (let index = 0; index < a.length; index += 1) { ab += a[index] * b[index]; aa += a[index] ** 2; bb += b[index] ** 2; }
  return ab / Math.sqrt(aa * bb);
};
const noseEdited = setFeature(base, "nose", (base.identityBits >>> 12) % 8 === 1 ? 2 : 1);
assert.deepEqual(priorBase, gnmPlayerPrior(noseEdited, model.priorCount), "local edits preserve the exact prior");
let unrelated = 0;
for (let index = 0; index < 20; index += 1) unrelated += Math.abs(correlation(priorBase, gnmPlayerPrior(createProfile({ seed: hashSeed(`other:${index}`) }), model.priorCount)));
assert.ok(unrelated / 20 < 0.45, "different players are not correlated");

// Reconstruction includes compact-support deltas; unmasked linear projections no longer describe local geometry.
const positions = reconstructGnmPlayerPositions(model, staticData.template, identity);
const measuredZ = gnmPlayerFeatureZ(model, measureGnmPlayerFeatures(model, positions));
for (const feature of model.featureKeys) assert.ok(Number.isFinite(measuredZ[feature]), `${feature} localized reconstruction is finite`);
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
  ["earShape", 2, 1, "earHeight"],
];
const shrink = 1 / (1 + GNM_PLAYER_TARGET_TAU ** 2);
for (const [trait, high, low, feature] of pairs) {
  let wins = 0;
  let sumHigh = 0;
  const bases = 24;
  for (let index = 0; index < bases; index += 1) {
    const player = createProfile({ seed: hashSeed(`gnm-player-pair:${trait}:${index}`) });
    const zHigh = gnmPlayerFeatureZ(model, measureGnmPlayerFeatures(model, reconstructGnmPlayerPositions(model, staticData.template, sampleGnmPlayerIdentity(setFeature(player, trait, high), model))))[feature];
    const zLow = gnmPlayerFeatureZ(model, measureGnmPlayerFeatures(model, reconstructGnmPlayerPositions(model, staticData.template, sampleGnmPlayerIdentity(setFeature(player, trait, low), model))))[feature];
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
const bust = buildGnmPlayerBust(staticData.neckLoop, positions, staticData.skinTriangles);
assert.ok(bust.vertices.every(Number.isFinite) && bust.indices.length > 0);
const camera = buildGnmPlayerCamera({ yaw: 99, pitch: -99, distance: 99 }, 1);
assert.deepEqual(camera.camera, clampGnmPlayerCamera({ yaw: 99, pitch: -99, distance: 99 }));
assert.ok(camera.view.every(Number.isFinite) && camera.projection.every(Number.isFinite));

const description = describeGnmPlayerMapping(base, { expressionMode: "focused" });
assert.equal(description.identity.identityOnly, true);
assert.equal(description.semanticMapping, "measured-landmark-features-v1");
assert.equal(description.officialTexturesIncluded, false);
assert.equal(description.expression.mode, "focused");

console.log(`PASS GNM 3D player tests: payload parse, catalog parity, identity-only invariance, stable base, localized reconstruction, ${pairs.length} label/feature orderings, bounds (max |c| ${maxCoefficient.toFixed(2)}), official expression presets, appearance, hair shell, normals, frame`);

// Geometric cavity only attenuates concave features, independent of world scale.
const { computeGnmPlayerCavity } = await import("../src/gnm-player-renderer.js");
const patchTriangles = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]);
const patchNormals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
const patch = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0]);
assert.ok(computeGnmPlayerCavity(patch, patchNormals, patchTriangles).every((value) => value === 0));
patch[2] = -0.2;
const concave = computeGnmPlayerCavity(patch, patchNormals, patchTriangles);
assert.ok(concave[0] > 0.4 && concave[0] < 0.7);
const translated = Float32Array.from(patch, (value) => value * 3 + 4);
const shiftedCavity = computeGnmPlayerCavity(translated, patchNormals, patchTriangles);
assert.ok(Math.abs(concave[0] - shiftedCavity[0]) < 1e-6);
patch[2] = 0.2;
assert.equal(computeGnmPlayerCavity(patch, patchNormals, patchTriangles)[0], 0);
assert.ok(computeGnmPlayerCavity(patch, patchNormals, new Uint32Array([0, 0, 0])).every((value) => value === 0));
assert.equal(frame.renderCavity.length, staticData.renderCount);
assert.ok(frame.renderCavity.every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
assert.ok(frame.renderCavity.some((value) => value > 0.1), "actual concave features receive cavity shading");
assert.deepEqual(frame.renderCavity, computeGnmPlayerFrame(resources, base, { expressionMode: "soft" }).renderCavity);
console.log("PASS geometric cavity: planar/convex preservation, concavity, scale/translation invariance, degenerate edges, deterministic finite real mesh");

// The crew neck is a closed fitted section above the original wide torso cut.
assert.equal(frame.bust.collarVertexCount, 128);
const collarHeight = frame.bust.collarPlane[0];
const boundaryTop = Math.max(...Array.from(staticData.neckLoop, (vertex) => positions[vertex * 3 + 1]));
assert.ok(collarHeight > boundaryTop + 0.01);
for (let vertex = 0; vertex < frame.bust.collarVertexCount; vertex += 1) {
  const signed = frame.bust.vertices[vertex * 3 + 1] + 0.12 * (frame.bust.vertices[vertex * 3 + 2] - frame.bust.collarPlane[1]) - collarHeight;
  assert.ok(Math.abs(signed) < 0.002, "top ring fits the clipping plane without a broad open scoop");
}
assert.ok(frame.bust.indices.includes(127) && frame.bust.indices.includes(0));
const { buildGnmPlayerGroom } = await import("../src/gnm-player-renderer.js");
let groomProfile = createProfile({ seed: 42, age: 30 });
for (const [key, value] of Object.entries({ hairVisible: 1, hair: 6, beard: 3, brows: 3 })) groomProfile = setFeature(groomProfile, key, value);
const groomed = computeGnmPlayerFrame(resources, groomProfile, { expressionMode: "neutral" });
// Beard and brows are strand-based (gnm-player-facial-hair.js): bounded strands, two vertices per point.
for (const [key, maximum] of [["beard", 16000], ["brow", 4000]]) {
  const mesh = groomed.groom[key];
  assert.ok(mesh.strandCount > 0 && mesh.strandCount <= maximum, `${key} has bounded geometric strands`);
  assert.equal(mesh.indices.length, (mesh.pointCount - mesh.strandCount) * 6);
  assert.ok(mesh.vertices.every(Number.isFinite) && mesh.normals.every(Number.isFinite));
}
// Scalp hair is strand-based (gnm-player-hair.js): bounded strands of any length, two vertices per point.
const hairMesh = groomed.groom.hair;
assert.ok(hairMesh.strandCount > 1000 && hairMesh.strandCount <= 16000, "hair has bounded geometric strands");
assert.equal(hairMesh.indices.length, (hairMesh.pointCount - hairMesh.strandCount) * 6);
assert.ok(hairMesh.vertices.every(Number.isFinite) && hairMesh.normals.every(Number.isFinite));
const repeatedGroom = buildGnmPlayerGroom(staticData, groomed.renderPositions, groomed.renderNormals, groomed.appearance, { seed: groomProfile.seed, collarPlane: groomed.bust.collarPlane });
assert.equal(repeatedGroom.hair.strandCount, 0, "the beard/brow groom never includes scalp hair");
assert.deepEqual(repeatedGroom.beard, groomed.groom.beard);
assert.deepEqual(repeatedGroom.brow, groomed.groom.brow);
assert.deepEqual(computeGnmPlayerFrame(resources, groomProfile, { expressionMode: "neutral" }).groom.hair, hairMesh, "hair strands are deterministic");
const shaved = computeGnmPlayerFrame(resources, setFeature(setFeature(groomProfile, "hairVisible", 0), "beard", 0), { expressionMode: "neutral" });
assert.equal(shaved.groom.hair.strandCount, 0);
assert.equal(shaved.groom.beard.strandCount, 0);
const ageFrames = [22, 40, 60].map((age) => computeGnmPlayerFrame(resources, ageProfile(groomProfile, age - groomProfile.age), { expressionMode: "neutral" }));
assert.deepEqual(ageFrames.map((frame) => frame.appearance.ageShading), [0, 0.375, 1]);
assert.deepEqual(ageFrames[0].renderPositions, ageFrames[2].renderPositions, "wrinkle shading must not mutate facial identity geometry");
assert.deepEqual(ageFrames[0].identity.coefficients, ageFrames[2].identity.coefficients);
console.log("PASS fitted crew neck, bounded deterministic hair/beard/brow strands, shaved styles and age-only wrinkle strength/identity invariance");
const fixedAging = [22, 60].map((age) => computeGnmPlayerFrame(resources, ageProfile(groomProfile, age - groomProfile.age), { expressionMode: "neutral", diagnosticGroomingAge: 30 }));
assert.deepEqual(fixedAging[0].appearance.brow, fixedAging[1].appearance.brow);
assert.deepEqual(fixedAging[0].appearance.hair, fixedAging[1].appearance.hair);
assert.deepEqual(fixedAging[0].appearance.beard, fixedAging[1].appearance.beard);
assert.equal(fixedAging[1].appearance.ageShading, 1, "diagnostic pigment control must not suppress skin aging");
// Hair-envelope normals are welded across GLB UV splits.
const normalBySource = new Map();
for (let vertex = 0; vertex < staticData.renderCount; vertex += 1) {
  const source = staticData.sourceIds[vertex];
  const normal = Array.from(groomed.shell.normals.subarray(vertex * 3, vertex * 3 + 3));
  assert.ok(normal.every(Number.isFinite));
  if (normalBySource.has(source)) assert.deepEqual(normal, normalBySource.get(source));
  else normalBySource.set(source, normal);
}

// The opt-in hairstyle is not a thirteenth seeded FaceDNA value.
const { GNM_PLAYER_SIDE_PART, gnmPlayerHairSurfaceOffset } = await import('../src/gnm-player-model.js');
const { formatFaceCode, getFaceValues } = await import('../src/face-model.js');
assert.equal(values.hair, 12);
assert.equal(GNM_PLAYER_HAIR_STYLES.length, 12);
const prototypeOptions = { expressionMode: 'neutral', hairstylePrototype: 'side-part' };
const trialCode = formatFaceCode(groomProfile);
const trial = computeGnmPlayerFrame(resources, groomProfile, prototypeOptions);
const trialAgain = computeGnmPlayerFrame(resources, groomProfile, prototypeOptions);
assert.deepEqual(trial.shell, trialAgain.shell);
assert.deepEqual(trial.groom, trialAgain.groom);
assert.deepEqual(trial.renderPositions, groomed.renderPositions, 'head identity and expression are untouched');
assert.deepEqual(trial.identity.coefficients, groomed.identity.coefficients);
assert.equal(formatFaceCode(groomProfile), trialCode);
assert.equal(trial.appearance.hairStyle.asset, 'hair/prototype-side-part');
assert.notDeepEqual(trial.shell.positions, groomed.shell.positions);
assert.ok(trial.shell.positions.every(Number.isFinite) && trial.shell.normals.every(Number.isFinite));
assert.ok(trial.groom.hair.strandCount > 0 && trial.groom.hair.strandCount <= 16000);
const crownOffset = x => gnmPlayerHairSurfaceOffset(GNM_PLAYER_SIDE_PART, 65, 0.8, [x, .33, .04]);
assert.ok(crownOffset(-.02) > crownOffset(.055) * 2, 'swept crown has asymmetric volume');
assert.ok(crownOffset(.0278) < crownOffset(.012) * .65, 'the part is a carved channel, not just paint');
assert.throws(() => gnmPlayerAppearance(groomProfile, { hairstylePrototype: 'arbitrary' }), /Unsupported hairstyle/);
assert.equal(computeGnmPlayerFrame(resources, setFeature(groomProfile, 'hairVisible', 0), prototypeOptions).groom.hair.strandCount, 0);
for (const seed of [0, 1, 42, 12345, 4294967295]) {
  const p = setFeature(createProfile({seed, age:30}), 'hairVisible', 1);
  const original = gnmPlayerAppearance(p);
  assert.deepEqual(gnmPlayerAppearance(p, {hairstylePrototype:'original'}), original);
  assert.equal(original.hairStyle.asset, GNM_PLAYER_HAIR_STYLES[getFaceValues(p).hair].asset);
}
console.log('PASS side-part prototype: deterministic asymmetric geometry, carved part, unchanged identity/SF2/catalog, visibility and input validation');

// Unchanged envelope families retain their behavior; catalog part styles have separate regression coverage.
for (const style of GNM_PLAYER_HAIR_STYLES.filter(style => !["side-part", "center-part"].includes(style.pattern))) {
  for (const position of [[-.04,.34,.06], [.02,.36,.02], [.06,.32,-.04]]) {
    const [x,y,z] = position;
    const curl = style.pattern === 'curly';
    const wave = Math.sin(x*(curl?420:190)+z*120)*Math.sin(y*(curl?350:110)-z*230);
    const expected = gnmPlayerHairThicknessMm(style,55,.7)*(curl?1+.2*wave:1+.075*wave);
    assert.equal(gnmPlayerHairSurfaceOffset(style,55,.7,position), expected, 'original envelope stays identical to pre-fix behavior');
  }
}
const partSweep = Array.from({length:161}, (_, i) => gnmPlayerHairSurfaceOffset(GNM_PLAYER_SIDE_PART,60,.7,[-.02,.35,-.08+i*.001]));
assert.ok(Math.max(...partSweep)-Math.min(...partSweep)<.01, 'fixed prototype crown section must not have 660-radian depth ripples');
const rendererSource = fs.readFileSync(new URL('../src/gnm-player-renderer.js',import.meta.url),'utf8');
const hairAlbedoSource = rendererSource.split('vec3 hairAlbedo(')[1].split('float browCoverage()')[0];
const prototypeAlbedo = hairAlbedoSource.split('if (uHairStyle2.z > 3.5) {')[1].split('\n  }')[0];
assert.ok(!/\b(?:cos|sin)\s*\(/.test(prototypeAlbedo), 'prototype has no periodic pigment mask');
assert.ok(!/pattern\s*=|clumps = (?!0\.5)/.test(prototypeAlbedo), 'prototype has no macro spot mask');
assert.ok(rendererSource.includes('float hairStrandNoise(') && rendererSource.includes('fwidth(p)'), 'subpixel prototype strands are footprint filtered');
assert.equal(new Set(Array.from({length:8},(_,hairColor)=>gnmPlayerAppearance(setFeature(groomProfile,'hairColor',hairColor)).hair.join(','))).size,8,'pigments remain distinct');
console.log('PASS side-part pattern regression: no periodic crown/pigment mask, filtered strands, original envelopes unchanged, eight distinct pigments');
