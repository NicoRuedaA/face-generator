import assert from "node:assert/strict";
import fs from "node:fs";
import { FACE_VARS, ageProfile, createProfile, getFaceValues, hashSeed, setFeature, setKit, setPresentation } from "../src/face-model.js";
import { parseWebglGlb } from "../src/gnm-assets.js";
import { GNM_PLAYER_HAIR_COLORS, computeGnmPlayerNormals, gnmPlayerExpression, parseGnmPlayerPayload, reconstructGnmPlayerPositions, sampleGnmPlayerIdentity } from "../src/gnm-player-model.js";
import {
  GNM_PLAYER_EYES,
  buildGnmPlayerLashes,
  buildGnmPlayerTearLine,
  computeGnmPlayerEyeRig,
  fitGnmPlayerSphere,
  gnmPlayerContactTable,
  gnmPlayerEyeSurfaceMasks,
  gnmPlayerIrisDetail,
  gnmPlayerLashPigment,
  gnmPlayerSpokeVertex,
} from "../src/gnm-player-eyes.js";
import { buildGnmPlayerStatic, computeGnmPlayerFrame } from "../src/gnm-player-renderer.js";

const work = new URL("../tools/gnm/work/", import.meta.url);
const read = (name) => {
  const buffer = fs.readFileSync(new URL(name, work));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};
const model = parseGnmPlayerPayload(JSON.parse(fs.readFileSync(new URL("gnm-player-generator.json", work), "utf8")), read("gnm-player-generator.bin"));
const asset = parseWebglGlb(read("gnm-official-head-render.glb"));
const staticData = buildGnmPlayerStatic(asset, model);
const resources = { model, asset, staticData };
const topology = staticData.eyeTopology;
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected} (+/-${tolerance})`);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const at = (array, index) => [array[index * 3], array[index * 3 + 1], array[index * 3 + 2]];
function segmentDistance(p, a, b) {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / Math.max(dot(ab, ab), 1e-18)));
  return length(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
}

// --- Sphere fit: exact on a synthetic sphere, independent of sampling. ---
const sphere = [];
for (let index = 0; index < 64; index += 1) {
  const theta = index * 2.39996, z = 1 - (2 * index + 1) / 64, r = Math.sqrt(1 - z * z);
  sphere.push(0.1 + 0.0145 * r * Math.cos(theta), 0.3 + 0.0145 * r * Math.sin(theta), 0.05 + 0.0145 * z);
}
const fitted = fitGnmPlayerSphere(sphere, Array.from({ length: 64 }, (_, index) => index));
near(fitted.radius, 0.0145, 1e-9, "sphere fit radius");
near(length(sub(fitted.center, [0.1, 0.3, 0.05])), 0, 1e-9, "sphere fit centre");

// --- Contact table: periodic, uniform azimuths, linear between samples. ---
const polar = new Float64Array([-Math.PI / 2, 0.4, 0, 0.8, Math.PI / 2, 0.2, Math.PI, 0.6]);
const table = gnmPlayerContactTable(polar, 4, 8);
assert.equal(table.length, 8);
table.forEach((value) => assert.ok(value >= 0.2 - 1e-6 && value <= 0.8 + 1e-6, "contact table interpolates between samples"));
near(table[2], 0.4 + (0.8 - 0.4) * 0.25, 1e-6, "linear interpolation at azimuth -3pi/8");
near(table[7], 0.2 + (0.6 - 0.2) * 0.75, 1e-6, "linear interpolation at azimuth 7pi/8");
near(table[0], 0.6 + (0.4 - 0.6) * 0.25, 1e-6, "wraps around at +/-pi");

// --- Static topology: both eyes, closed lid-margin loops, split into lids at the canthi. ---
assert.equal(topology.eyes.length, 2);
assert.deepEqual(topology.eyes.map((eye) => eye.side), [-1, 1], "subject's right eye (x < 0) first");
const templateRig = computeGnmPlayerEyeRig(topology, Float64Array.from(staticData.template));
for (const [index, eye] of topology.eyes.entries()) {
  assert.ok(eye.spokeCount >= 30, `eye ${eye.side}: margin loop has ${eye.spokeCount} spokes`);
  const upper = eye.lids.upper, lower = eye.lids.lower;
  assert.equal(upper.spokes[0], eye.innerSpoke);
  assert.equal(lower.spokes[0], eye.innerSpoke);
  assert.equal(upper.spokes.at(-1), eye.outerSpoke);
  assert.equal(lower.spokes.at(-1), eye.outerSpoke);
  assert.equal(upper.spokes.length + lower.spokes.length - 2, eye.spokeCount, "the two lids partition the loop");
  for (const lid of [upper, lower]) for (let item = 1; item < lid.t.length; item += 1) assert.ok(lid.t[item] >= lid.t[item - 1], "lid arc parameter is monotonic");
  const rig = templateRig.eyes[index];
  const margin = (spoke) => at(staticData.template, gnmPlayerSpokeVertex(eye, spoke, 0));
  const inner = margin(eye.innerSpoke), outer = margin(eye.outerSpoke);
  assert.ok(Math.abs(inner[0]) < Math.abs(outer[0]), "inner canthus is nasal of the outer canthus");
  const middle = (lid) => dot(sub(margin(lid.spokes[lid.spokes.length >> 1]), rig.center), rig.up);
  assert.ok(middle(upper) > 0 && middle(lower) < 0, "upper lid above, lower lid below the gaze axis");
  const landmark = (id) => [0, 1, 2].map((axis) => model.landmarkWeights.subarray(id * 3, id * 3 + 3).reduce((sum, weight, corner) => sum + weight * staticData.template[model.landmarkIndices[id * 3 + corner] * 3 + axis], 0));
  // The outer canthus landmark lies on the margin loop; the inner one sits
  // ~3 mm further nasal, past the caruncle, so its nearest spoke is used.
  assert.ok(length(sub(outer, landmark(eye.outerLandmark))) < 0.001, "outer canthus spoke sits on its landmark");
  assert.ok(length(sub(inner, landmark(eye.innerLandmark))) < 0.0035, "inner canthus spoke is the loop vertex next to its landmark");
  assert.ok(Math.abs(landmark(eye.innerLandmark)[0]) < Math.abs(inner[0]), "the inner canthus landmark is nasal of the loop (caruncle between)");
  // Template anatomy: eyeball ~14.5 mm, corneal dome ~7.3 mm, gaze along +z, iris ~5 mm radius.
  near(rig.radius * 1000, 14.5, 0.3, "eyeball radius (mm)");
  near(rig.cornea.radius * 1000, 7.34, 0.4, "corneal dome radius (mm)");
  assert.ok(rig.axis[2] > 0.99, "gaze axis points forward");
  near(rig.iris.radius * 1000, 5.1, 0.6, "iris radius on the fitted plane (mm)");
  assert.equal(rig.contactTable.length, GNM_PLAYER_EYES.contactSamples);
  assert.ok(rig.contactTable.every((value) => value > 0.05 && value < 1.4), "contact polar angles are anatomical");
  const entry = (azimuth) => rig.contactTable[Math.floor(((azimuth + Math.PI) / (2 * Math.PI)) * GNM_PLAYER_EYES.contactSamples)];
  assert.ok(entry(Math.PI / 2) < entry(-Math.PI / 2), "the upper lid covers more of the eye than the lower lid");
}

// --- Static masks: lash line and wet margin only around the eyes. ---
const masks = gnmPlayerEyeSurfaceMasks(topology, model.vertexCount, staticData.template);
assert.ok(masks.every((value) => value >= 0 && value <= 1), "masks are bounded");
let lashLine = 0, wet = 0;
for (let vertex = 0; vertex < model.vertexCount; vertex += 1) {
  if (masks[vertex * 2] > 0 || masks[vertex * 2 + 1] > 0) {
    const position = at(staticData.template, vertex);
    assert.ok(templateRig.eyes.some((eye) => length(sub(position, eye.center)) < 0.03), "masks stay inside the eye region");
  }
  lashLine += masks[vertex * 2] > 0.5;
  wet += masks[vertex * 2 + 1] > 0.5;
}
assert.ok(lashLine > 40 && wet > 100, `lash line (${lashLine}) and wet margin (${wet}) are present`);
for (const eye of topology.eyes) {
  const middle = eye.lids.upper.spokes[eye.lids.upper.spokes.length >> 1];
  assert.ok(masks[gnmPlayerSpokeVertex(eye, middle, 0) * 2] > 0.9, "upper lid margin carries the full lash line");
  assert.ok(masks[gnmPlayerSpokeVertex(eye, middle, 2) * 2 + 1] > 0.9, "posterior margin is wet");
}

// --- Per-frame lashes: deterministic, bounded, attached, never penetrating. ---
function eyeFrame(profile, mode) {
  const identity = sampleGnmPlayerIdentity(profile, model);
  const positions = reconstructGnmPlayerPositions(model, staticData.template, identity, gnmPlayerExpression(profile, mode).weights);
  const normals = computeGnmPlayerNormals(positions, staticData.sourceTriangles, model.vertexCount);
  const rig = computeGnmPlayerEyeRig(topology, positions, normals);
  return { positions, normals, rig, lashes: buildGnmPlayerLashes(topology, rig, profile.seed), tearLine: buildGnmPlayerTearLine(topology, rig) };
}
const { lashes: lashConfig } = GNM_PLAYER_EYES;
const perEye = lashConfig.upper.count + lashConfig.lower.count;
const anteriorSkin = [...new Set(staticData.skinTriangles)].filter((vertex) => {
  const spec = model.fieldIndex.get("eyeSocket");
  return spec.min + (model.fields[spec.index * model.vertexCount + vertex] / 255) * (spec.max - spec.min) < 0.5;
});
let checkedPoints = 0;
for (let shape = 0; shape < 6; shape += 1) {
  for (const mode of ["neutral", "alert", "soft", "focused"]) {
    const profile = setFeature(createProfile({ seed: hashSeed(`lash-bounds:${shape}`), age: 30 }), "eyes", shape);
    const { positions, normals, rig, lashes, tearLine } = eyeFrame(profile, mode);
    assert.equal(lashes.strandCount, 2 * perEye);
    assert.deepEqual(lashes.counts, { upper: 2 * lashConfig.upper.count, lower: 2 * lashConfig.lower.count });
    assert.equal(lashes.indices.length, lashes.strandCount * lashConfig.segments * 6);
    for (const array of [lashes.vertices, lashes.normals, lashes.uvs, lashes.surface, tearLine.vertices, tearLine.normals]) assert.ok(array.every(Number.isFinite), "strand data is finite");
    const points = lashes.pointsPerStrand;
    const nearbySkin = anteriorSkin.filter((vertex) => rig.eyes.some((eye) => length(sub(at(positions, vertex), eye.center)) < 0.03));
    for (let strand = 0; strand < lashes.strandCount; strand += 1) {
      const eye = rig.eyes[strand < perEye ? 0 : 1];
      const upper = strand % perEye < lashConfig.upper.count;
      const settings = upper ? lashConfig.upper : lashConfig.lower;
      let total = 0;
      for (let point = 1; point < points; point += 1) total += length(sub(at(lashes.vertices, (strand * points + point) * 2), at(lashes.vertices, (strand * points + point - 1) * 2)));
      assert.ok(total * 1000 > settings.lengthMm[0] * 0.2 && total * 1000 < settings.lengthMm[1] * 1.25, `lash length ${total * 1000} mm within bounds`);
      const rootHalfWidth = lashes.surface[strand * points * 2 * 4];
      const tipHalfWidth = lashes.surface[((strand + 1) * points * 2 - 1) * 4];
      assert.ok(rootHalfWidth > tipHalfWidth * 3 && rootHalfWidth < 0.0001, "lashes taper from a ~0.1 mm root");
      // Rooted on the anterior lid margin: close to the ring -2..0 polylines of its lid.
      const root = at(lashes.vertices, strand * points * 2);
      const lid = topology.eyes[strand < perEye ? 0 : 1].lids[upper ? "upper" : "lower"];
      let rootDistance = Infinity;
      for (let item = 1; item < lid.spokes.length; item += 1) {
        for (const depth of [-2, -1, 0]) rootDistance = Math.min(rootDistance, segmentDistance(root, eye.profilePoint(lid.spokes[item - 1], depth), eye.profilePoint(lid.spokes[item], depth)));
      }
      assert.ok(rootDistance < 0.00065, `lash root ${rootDistance * 1000} mm from the anterior lid margin`);
      for (let point = 1; point < points; point += 1) {
        const p = at(lashes.vertices, (strand * points + point) * 2);
        const offset = sub(p, eye.center);
        const gap = length(offset) - eye.envelope(offset.map((value) => value / length(offset)));
        assert.ok(gap > 0.0001, `lash point outside the eyeball envelope (gap ${gap * 1000} mm)`);
        let best = -1, bestDistance = Infinity;
        for (const vertex of nearbySkin) {
          const distance = length(sub(p, at(positions, vertex)));
          if (distance < bestDistance) { bestDistance = distance; best = vertex; }
        }
        if (bestDistance < 0.0015) assert.ok(dot(sub(p, at(positions, best)), at(normals, best)) > -0.00002, `lash point in front of the lid skin (shape ${shape} ${mode} strand ${strand} point ${point}: ${(dot(sub(p, at(positions, best)), at(normals, best)) * 1000).toFixed(3)} mm at ${(bestDistance * 1000).toFixed(2)} mm)`);
        checkedPoints += 1;
      }
    }
    // Tear meniscus hugs the lid/eyeball contact.
    for (let vertex = 0; vertex < tearLine.vertices.length / 3; vertex += 1) {
      const p = at(tearLine.vertices, vertex);
      const gaps = rig.eyes.map((eye) => { const offset = sub(p, eye.center); return Math.abs(length(offset) - eye.envelope(offset.map((value) => value / length(offset)))); });
      assert.ok(Math.min(...gaps) < 0.0006, "tear line within 0.6 mm of the eyeball envelope");
    }
  }
}
assert.ok(checkedPoints > 30000, `penetration checked on ${checkedPoints} lash points`);

// Determinism and isolation: lashes are a function of the reconstructed lid
// geometry (identity, eye shape, expression) and the seed only.
const base = setFeature(setFeature(createProfile({ seed: hashSeed("lash-isolation"), age: 27, presentation: "neutral" }), "hairVisible", 1), "beard", 0);
const reference = eyeFrame(base, "neutral");
assert.deepEqual(eyeFrame(base, "neutral").lashes, reference.lashes, "lashes are deterministic");
const values = getFaceValues(base);
const lidVertices = [...new Set(topology.eyes.flatMap((eye) => Array.from(eye.spokes)))];
for (const variable of FACE_VARS) {
  const edited = setFeature(base, variable.key, (values[variable.key] + 1) % variable.validValues);
  const frameEdit = eyeFrame(edited, "neutral");
  const lidsMoved = lidVertices.some((vertex) => length(sub(at(frameEdit.positions, vertex), at(reference.positions, vertex))) > 0);
  if (!["head", "jaw", "faceProportion", "eyes", "nose", "mouth", "earShape"].includes(variable.key)) assert.equal(lidsMoved, false, `${variable.key}: non-geometric control leaves the lids in place`);
  if (!lidsMoved) assert.deepEqual(frameEdit.lashes.vertices, reference.lashes.vertices, `${variable.key}: lash geometry isolated`);
}
for (const edited of [ageProfile(base, 25), setPresentation(base, "feminine"), setKit(base, "#123456", "#abcdef")]) {
  assert.deepEqual(eyeFrame(edited, "neutral").lashes.vertices, reference.lashes.vertices, "age, presentation and kit leave lashes unchanged");
}
assert.notDeepEqual(eyeFrame(setFeature(base, "eyes", (values.eyes + 3) % 6), "neutral").lashes.vertices, reference.lashes.vertices, "eye shape moves the lashes");
assert.notDeepEqual(eyeFrame(base, "focused").lashes.vertices, reference.lashes.vertices, "expressions move the lashes");
assert.notDeepEqual(eyeFrame(createProfile({ seed: hashSeed("lash-isolation-2"), age: 27 }), "neutral").lashes.surface, reference.lashes.surface, "per-lash variation follows the seed");

// --- Lash pigment: darker than the scalp hair, lighter for blond/red, darker at the root. ---
const linear = (srgb) => srgb.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
const luminance = (srgb) => { const [r, g, b] = linear(srgb); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const pigments = GNM_PLAYER_HAIR_COLORS.map((hex, index) => {
  const hair = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const pigment = gnmPlayerLashPigment(setFeature(base, "hairColor", index));
  assert.ok(luminance(pigment.root) <= luminance(hair) + 1e-9 && luminance(pigment.tip) <= luminance(hair) + 1e-9, `hair colour ${index}: lashes darker than the scalp hair`);
  assert.ok(luminance(pigment.root) <= luminance(pigment.tip), `hair colour ${index}: root darker than tip`);
  return pigment;
});
assert.ok(luminance(pigments[4].root) > luminance(pigments[0].root) * 3, "blond lashes are lighter than black-hair lashes");
assert.ok(luminance(pigments[6].root) > luminance(pigments[0].root), "red lashes are lighter than black-hair lashes");
assert.ok(pigments[6].root[0] > pigments[6].root[2] * 1.5, "red lashes keep a warm pigment");
// FaceDNA clears the hair colour of a player without visible hair or beard
// (it also drives the brows), so hairVisible is exercised with a beard.
for (const variable of FACE_VARS) {
  if (variable.key === "hairColor") continue;
  const blond = setFeature(setFeature(base, "hairColor", 4), "beard", variable.key === "hairVisible" ? 1 : 0);
  const edited = setFeature(blond, variable.key, (getFaceValues(blond)[variable.key] + 1) % variable.validValues);
  assert.deepEqual(gnmPlayerLashPigment(edited), pigments[4], `${variable.key}: lash pigment follows the hair colour only`);
}
assert.deepEqual(gnmPlayerLashPigment(ageProfile(setFeature(base, "hairColor", 4), 30)), pigments[4], "lashes do not grey with age");

// --- Iris detail: seed-stable, bounded, isolated from every other control. ---
const iris = gnmPlayerIrisDetail(base);
assert.deepEqual(gnmPlayerIrisDetail(base), iris, "iris detail is deterministic");
for (const variable of FACE_VARS) {
  const edited = setFeature(base, variable.key, (values[variable.key] + 1) % variable.validValues);
  assert.deepEqual(gnmPlayerIrisDetail(edited), iris, `${variable.key}: iris detail follows the seed only`);
}
const irises = Array.from({ length: 40 }, (_, index) => gnmPlayerIrisDetail(createProfile({ seed: hashSeed(`iris:${index}`) })));
for (const entry of irises) {
  assert.ok(entry.pupil >= 0.27 && entry.pupil <= 0.34, "pupil fraction in a studio-light range");
  assert.ok(entry.collarette > 0.3 && entry.collarette < 0.5 && entry.limbalRing > 0.5 && entry.limbalRing < 0.95, "collarette and limbal ring bounded");
  assert.ok(entry.centralTint >= 0 && entry.centralTint <= 0.6 && entry.vessels > 0.5 && entry.vessels <= 1, "tint and vessels bounded");
}
assert.ok(new Set(irises.map((entry) => entry.offset.join(","))).size === irises.length, "iris patterns differ per seed");
assert.ok(irises.some((entry) => entry.centralTint > 0.15) && irises.some((entry) => entry.centralTint < 0.05), "central heterochromia appears on some seeds only");

// --- The renderer frame carries the eye inputs; identity data is untouched. ---
const frame = computeGnmPlayerFrame(resources, base, { expressionMode: "neutral" });
assert.deepEqual(frame.eyes.lashes.vertices, reference.lashes.vertices, "renderer frame uses the same lashes");
assert.equal(frame.eyes.uniforms.contact.length, 2 * GNM_PLAYER_EYES.contactSamples);
assert.equal(frame.eyes.uniforms.centers.length, 8);
assert.equal(frame.eyes.uniforms.irisNormals.length, 8);
assert.ok(Object.values(frame.eyes.uniforms).every((array) => array.every(Number.isFinite)), "eye uniforms are finite");
assert.equal(staticData.eyeMasks.length, staticData.renderCount * 2);

console.log(`PASS eyes: sphere fit, contact table, lid topology and canthi, masks, ${checkedPoints} lash points without penetration over 6 eye shapes x 4 expressions, tear line contact, determinism, lash/iris isolation, lash pigment`);
