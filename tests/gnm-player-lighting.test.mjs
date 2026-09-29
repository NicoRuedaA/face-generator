import assert from "node:assert/strict";
import fs from "node:fs";
import { FACE_VARS, createProfile, getFaceValues, hashSeed, setFeature, setPresentation, ageProfile } from "../src/face-model.js";
import { parseWebglGlb } from "../src/gnm-assets.js";
import { parseGnmPlayerPayload } from "../src/gnm-player-model.js";
import {
  GNM_PLAYER_AMBIENT_OCCLUSION,
  GNM_PLAYER_LIGHT_VOLUME,
  GNM_PLAYER_SKIN_LUT,
  GNM_PLAYER_SKIN_PROFILE,
  GNM_PLAYER_STUDIO,
  buildGnmPlayerLightMatrix,
  buildGnmPlayerSkinLut,
  computeGnmPlayerSurfaceTerms,
  convolveShIrradiance,
  cosineWeightedVisibility,
  evaluateSh9,
  fibonacciSphere,
  gnmPlayerAoDirections,
  gnmPlayerSkinRegions,
  gnmPlayerStudioLighting,
  orthonormalBasis,
  preintegratedSkinDiffuse,
  projectRadianceToSh9,
  shaderShDiffuse,
  smoothVertexValues,
  sphericalGaussian,
  sphericalGaussianIntegral,
  studioEnvironmentRadiance,
  viewDirectionToWorld,
} from "../src/gnm-player-lighting.js";
import { GNM_PLAYER_DEBUG_VIEWS, GNM_PLAYER_LIGHTING, buildGnmPlayerAoNeighbors, buildGnmPlayerBustAoNeighbors, buildGnmPlayerCamera, buildGnmPlayerStatic, computeGnmPlayerCavity, computeGnmPlayerFrame, gnmPlayerHairAoIndices } from "../src/gnm-player-renderer.js";

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a) => Math.sqrt(dot(a, a));
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected} (+/-${tolerance})`);

// --- Pre-integrated skin LUT (Penner & Borshukov, d'Eon & Luebke profile) ---
for (let channel = 0; channel < 3; channel += 1) near(GNM_PLAYER_SKIN_PROFILE.reduce((sum, entry) => sum + entry.weights[channel], 0), 1, 1e-9, `profile channel ${channel} weights sum to 1`);
const lut = buildGnmPlayerSkinLut();
assert.equal(lut.size, GNM_PLAYER_SKIN_LUT.size);
assert.equal(lut.data.length, lut.size * lut.size * 4);
assert.deepEqual(buildGnmPlayerSkinLut().data, lut.data, "LUT generation is deterministic");
const decode = (row, column, channel) => (lut.data[(row * lut.size + column) * 4 + channel] / 255) ** 2;
for (let column = 0; column < lut.size; column += 1) {
  const cosine = (column / (lut.size - 1)) * 2 - 1;
  for (let channel = 0; channel < 3; channel += 1) near(decode(0, column, channel), Math.max(cosine, 0), 0.008, `zero curvature row is Lambert at N.L=${cosine.toFixed(3)}`);
}
for (let row = 0; row < lut.size; row += 1) {
  for (let channel = 0; channel < 3; channel += 1) {
    assert.equal(lut.data[(row * lut.size) * 4 + 3], 255);
    for (let column = 1; column < lut.size; column += 1) assert.ok(decode(row, column, channel) + 0.004 >= decode(row, column - 1, channel), `LUT row ${row} channel ${channel} is monotonic in N.L`);
  }
}
const wrapped = preintegratedSkinDiffuse(-0.15, 0.6);
assert.ok(wrapped[0] > 0.01 && wrapped[0] > wrapped[1] && wrapped[1] >= wrapped[2], `curved skin wraps red light past the terminator (${wrapped})`);
for (const curvature of [0, 0.05, 0.2, 0.6, 1]) {
  for (const cosine of [-1, -0.4, 0, 0.3, 1]) {
    for (const value of preintegratedSkinDiffuse(cosine, curvature)) assert.ok(value >= 0 && value <= 1.0001, `falloff bounded at curvature ${curvature}, N.L ${cosine}`);
  }
}
near(preintegratedSkinDiffuse(1, 0.002)[1], 1, 0.002, "flat skin facing the light is unattenuated");
console.log("PASS pre-integrated skin LUT: normalized profile, Lambert at zero curvature, monotonic rows, red wrap, bounds, determinism");

// --- Spherical harmonics and spherical Gaussians ---
const constant = projectRadianceToSh9(() => [0.5, 0.25, 1]);
for (const direction of fibonacciSphere(64)) {
  const irradiance = evaluateSh9(convolveShIrradiance(constant), direction);
  near(irradiance[0], Math.PI * 0.5, 1e-3, "constant radiance -> pi * L irradiance");
  near(irradiance[2], Math.PI, 1e-3, "constant radiance (blue)");
}
const hemisphere = projectRadianceToSh9((direction) => { const value = Math.max(direction[2], 0); return [value, value, value]; });
near(evaluateSh9(convolveShIrradiance(hemisphere), [0, 0, 1])[0], (2 * Math.PI) / 3, 0.1, "L2 irradiance of a cosine hemisphere at +z");
assert.ok(Math.abs(evaluateSh9(convolveShIrradiance(hemisphere), [0, 0, -1])[0]) < 0.15, "and it is dark at -z");
for (const sharpness of [1.6, 4.5, 9]) {
  const lobe = { axis: [0, 1, 0], sharpness, color: [1, 1, 1] };
  const samples = fibonacciSphere(20000);
  const numeric = samples.reduce((sum, direction) => sum + sphericalGaussian(lobe, direction)[0], 0) * (4 * Math.PI) / samples.length;
  near(numeric, sphericalGaussianIntegral(sharpness), sphericalGaussianIntegral(sharpness) * 0.01, `SG integral, sharpness ${sharpness}`);
}
const studio = gnmPlayerStudioLighting();
assert.equal(studio, gnmPlayerStudioLighting(), "studio inputs are cached");
assert.equal(studio.shDiffuse.length, 27);
assert.equal(studio.lobeAxes.length / 4, GNM_PLAYER_STUDIO.environment.lobes.length);
const shaderSh = (n) => { const b = [1, n[1], n[2], n[0], n[0] * n[1], n[1] * n[2], 3 * n[2] * n[2] - 1, n[0] * n[2], n[0] * n[0] - n[1] * n[1]]; return [0, 1, 2].map((c) => b.reduce((sum, value, index) => sum + studio.shDiffuse[index * 3 + c] * value, 0)); };
let minimumIrradiance = Infinity;
for (const direction of fibonacciSphere(2000)) minimumIrradiance = Math.min(minimumIrradiance, ...shaderSh(direction));
assert.ok(minimumIrradiance > 0.02, `studio SH irradiance stays positive (no ringing below zero): ${minimumIrradiance}`);
const reference = convolveShIrradiance(studio.shRadiance);
for (const direction of fibonacciSphere(32)) {
  const expected = evaluateSh9(reference, direction).map((value) => value / Math.PI);
  shaderSh(direction).forEach((value, channel) => near(value, expected[channel], 1e-4, "shader SH layout matches evaluateSh9 / pi"));
}
const fillAxis = GNM_PLAYER_STUDIO.environment.lobes.find((lobe) => lobe.name === "fill-softbox").axis;
assert.ok(shaderSh(fillAxis)[1] > shaderSh(GNM_PLAYER_STUDIO.key.direction.map((value) => -value))[1] * 1.5, "the fill softbox side is brighter than the far side");
assert.ok(studioEnvironmentRadiance(fillAxis)[2] > studioEnvironmentRadiance([0, 0, -1])[2], "environment radiance peaks at the softbox");
assert.deepEqual(shaderShDiffuse(studio.shRadiance), studio.shDiffuse);
console.log("PASS environment: SH projection/convolution, SG integrals, positive studio irradiance, shader layout, cached inputs");

// --- Curvature and cavity ---
function sphereMesh(radius, rings = 40, segments = 80, center = [0, 0, 0]) {
  const positions = [];
  const normals = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const phi = (ring / rings) * Math.PI;
    for (let segment = 0; segment < segments; segment += 1) {
      const theta = (segment / segments) * Math.PI * 2;
      const normal = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      positions.push(...normal.map((value, axis) => center[axis] + value * radius));
      normals.push(...normal);
    }
  }
  const triangles = [];
  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const a = ring * segments + segment, b = ring * segments + ((segment + 1) % segments), c = a + segments, d = b + segments;
      triangles.push(a, c, b, b, c, d);
    }
  }
  return { positions: Float64Array.from(positions), normals: Float32Array.from(normals), triangles: Uint32Array.from(triangles), segments, rings };
}
const sphere = sphereMesh(0.05);
const terms = computeGnmPlayerSurfaceTerms(sphere.positions, sphere.normals, sphere.triangles);
const equator = (sphere.rings / 2) * sphere.segments;
for (let segment = 0; segment < sphere.segments; segment += 7) near(terms.curvature[equator + segment], 1 / 0.05, 0.05 * 20, "sphere mean curvature is 1/R (1/m)");
assert.ok(terms.cavity.every((value) => value === 0), "a convex sphere has no cavity");
const scaled = sphereMesh(0.2, 40, 80, [1, 2, 3]);
near(computeGnmPlayerSurfaceTerms(scaled.positions, scaled.normals, scaled.triangles).curvature[equator], 1 / 0.2, 0.05 * 5, "curvature scales as 1/size and ignores translation");
const flipped = Float32Array.from(sphere.normals, (value) => -value);
assert.ok(computeGnmPlayerSurfaceTerms(sphere.positions, flipped, sphere.triangles).curvature[equator] < -15, "inward normals give negative (concave) curvature");
const plane = { positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), triangles: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]) };
assert.ok(computeGnmPlayerSurfaceTerms(plane.positions, plane.normals, plane.triangles).curvature.every((value) => value === 0), "a plane has zero curvature");
assert.deepEqual(computeGnmPlayerCavity(plane.positions, plane.normals, plane.triangles), computeGnmPlayerSurfaceTerms(plane.positions, plane.normals, plane.triangles).cavity, "cavity export shares the edge pass");
const noisy = Float64Array.from({ length: sphere.positions.length / 3 }, (_, index) => (index % 3) - 1);
const smoothed = smoothVertexValues(noisy, sphere.triangles, 2);
assert.ok(smoothed.every((value) => value >= -1 && value <= 1), "smoothing is a convex combination");
assert.ok(smoothVertexValues(new Float64Array(10).fill(0.7), sphere.triangles.filter((index) => index < 10), 3).every((value) => Math.abs(value - 0.7) < 1e-12), "smoothing preserves constants");
console.log("PASS curvature: 1/R on spheres, sign, scale/translation behaviour, planes, shared cavity pass, bounded smoothing");

// --- Light volume, projections and ambient-occlusion directions ---
const directions = gnmPlayerAoDirections();
assert.equal(directions.length, GNM_PLAYER_AMBIENT_OCCLUSION.directions);
assert.deepEqual(gnmPlayerAoDirections(), directions, "AO directions are fixed");
directions.forEach((direction) => near(length(direction), 1, 1e-12, "unit AO direction"));
const mean = [0, 1, 2].map((axis) => directions.reduce((sum, direction) => sum + direction[axis], 0) / directions.length);
assert.ok(length(mean) < 0.05, "AO directions cover the sphere evenly");
for (const normal of [[0, 0, 1], [0, 0, -1], [0.3, -0.2, -0.93], ...fibonacciSphere(50)]) {
  const unit = normal.map((value) => value / length(normal));
  const { tangent, bitangent } = orthonormalBasis(unit);
  near(length(tangent), 1, 1e-9, "unit tangent");
  near(length(bitangent), 1, 1e-9, "unit bitangent");
  near(dot(tangent, unit), 0, 1e-9, "tangent is orthogonal");
  near(dot(bitangent, unit), 0, 1e-9, "bitangent is orthogonal");
  near(dot(tangent, bitangent), 0, 1e-9, "basis is orthogonal");
}
const apply = (matrix, point) => [0, 1, 2].map((row) => matrix[row] * point[0] + matrix[4 + row] * point[1] + matrix[8 + row] * point[2] + matrix[12 + row]);
const lightDirection = [0.2, 0.8, 0.56].map((value, _, array) => value / length(array));
const lightMatrix = buildGnmPlayerLightMatrix(lightDirection);
const { center, radius } = GNM_PLAYER_LIGHT_VOLUME;
apply(lightMatrix, center).forEach((value) => near(value, 0, 1e-6, "volume center maps to the clip origin"));
near(apply(lightMatrix, center.map((value, axis) => value + lightDirection[axis] * radius))[2], -1, 1e-5, "the point nearest to the light has depth -1");
near(apply(lightMatrix, center.map((value, axis) => value - lightDirection[axis] * radius))[2], 1, 1e-5, "the farthest point has depth +1");
const { tangent } = orthonormalBasis(lightDirection);
near(apply(lightMatrix, center.map((value, axis) => value + tangent[axis] * radius))[0], 1, 1e-5, "the volume spans clip x");
const camera = buildGnmPlayerCamera({ yaw: 0.7, pitch: -0.2, distance: 1 }, 1);
const towardsCamera = viewDirectionToWorld(camera.view, [0, 0, 1]);
const eyeDirection = camera.eye.map((value, axis) => value - [0, 0.246, 0.018][axis]);
near(dot(towardsCamera, eyeDirection.map((value) => value / length(eyeDirection))), 1, 1e-6, "view +z maps to the direction of the camera");
near(cosineWeightedVisibility([0, 1, 0], directions, directions.map(() => 1)), 1, 1e-12, "unoccluded AO is 1");
near(cosineWeightedVisibility([0, 1, 0], directions, directions.map(() => 0)), 0, 1e-12, "fully occluded AO is 0");
const halfOccluded = cosineWeightedVisibility([0, 1, 0], directions, directions.map((direction) => (direction[0] > 0 ? 0 : 1)));
assert.ok(halfOccluded > 0.35 && halfOccluded < 0.65, `a half-space occluder gives ~0.5 AO (${halfOccluded})`);
console.log("PASS projections: fixed even AO directions, orthonormal basis, light clip matrix, view->world, cosine-weighted visibility bounds");

// --- Regional skin variation depends only on seed, tone, age and presentation ---
const base = createProfile({ seed: hashSeed("skin-regions"), age: 34, presentation: "masculine" });
const regions = gnmPlayerSkinRegions(base);
assert.deepEqual(gnmPlayerSkinRegions(base), regions, "regions are deterministic");
for (const key of ["redness", "periorbital", "beardShadow", "oiliness", "lightness"]) assert.ok(regions[key] >= 0 && regions[key] <= 1.2, `${key} bounded`);
for (const variable of FACE_VARS) {
  if (variable.key === "skin") continue;
  const edited = setFeature(base, variable.key, (getFaceValues(base)[variable.key] + 1) % variable.validValues);
  assert.deepEqual(gnmPlayerSkinRegions(edited), regions, `${variable.key}: regional skin variation is isolated from unrelated controls`);
}
const byTone = Array.from({ length: 8 }, (_, tone) => gnmPlayerSkinRegions(setFeature(base, "skin", tone)));
for (let tone = 1; tone < 8; tone += 1) {
  assert.ok(byTone[tone].lightness <= byTone[tone - 1].lightness, "tones are ordered light to dark");
  assert.ok(byTone[tone].redness <= byTone[tone - 1].redness + 1e-9, "redness is less visible on darker skin");
}
assert.deepEqual(byTone.map((entry) => entry.mottleOffset), byTone.map(() => regions.mottleOffset), "the mottling pattern follows the seed, not the tone");
assert.equal(gnmPlayerSkinRegions(setPresentation(base, "feminine")).beardShadow, 0, "no beard shadow for feminine presentation");
assert.equal(gnmPlayerSkinRegions(setPresentation(base, "neutral")).beardShadow, 0, "no beard shadow for neutral presentation");
assert.ok(regions.beardShadow > 0.3, "masculine adults get a subtle beard shadow");
assert.ok(gnmPlayerSkinRegions(ageProfile(base, 20)).periorbital >= regions.periorbital, "periorbital darkening does not decrease with age");
assert.notDeepEqual(gnmPlayerSkinRegions(createProfile({ seed: hashSeed("skin-regions-2"), age: 34, presentation: "masculine" })).mottleOffset, regions.mottleOffset, "different seeds vary the pattern");
console.log("PASS regional skin variation: deterministic, bounded, isolated from all non-skin controls, tone-scaled redness, presentation-gated beard shadow");

// --- Real mesh: per-vertex curvature, region anchors, groom roots, descriptor ---
const read = (name) => { const buffer = fs.readFileSync(new URL(`../tools/gnm/work/${name}`, import.meta.url)); return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength); };
const model = parseGnmPlayerPayload(JSON.parse(fs.readFileSync(new URL("../tools/gnm/work/gnm-player-generator.json", import.meta.url), "utf8")), read("gnm-player-generator.bin"));
const asset = parseWebglGlb(read("gnm-official-head-render.glb"));
const staticData = buildGnmPlayerStatic(asset, model);
const resources = { model, asset, staticData };
assert.equal(staticData.regionAnchors.length, 24);
assert.ok(staticData.regionAnchors.every(Number.isFinite));
let groomed = base;
for (const [key, value] of Object.entries({ hairVisible: 1, hair: 6, beard: 3, brows: 3 })) groomed = setFeature(groomed, key, value);
const frame = computeGnmPlayerFrame(resources, groomed, { expressionMode: "neutral" });
assert.equal(frame.renderCurvature.length, staticData.renderCount);
assert.ok(frame.renderCurvature.every((value) => Number.isFinite(value) && value >= 0 && value <= GNM_PLAYER_SKIN_LUT.maxCurvaturePerMm), "render curvature is finite and within the LUT range");
const skinCurvatures = Array.from(frame.renderCurvature).filter((_, vertex) => staticData.skinVertex[vertex]).sort((a, b) => a - b);
const median = skinCurvatures[Math.floor(skinCurvatures.length / 2)];
assert.ok(median > 0.002 && median < 0.1, `typical skin curvature is face-scale (median ${median.toFixed(4)} 1/mm)`);
assert.ok(skinCurvatures.at(-1) > 0.15, "ears, lids and nostrils reach high curvature");
assert.deepEqual(computeGnmPlayerFrame(resources, groomed, { expressionMode: "neutral" }).renderCurvature, frame.renderCurvature, "curvature is deterministic");
assert.deepEqual(frame.skinRegions, gnmPlayerSkinRegions(groomed));
// Scalp hair strands root on one skin render vertex each (see gnm-player-hair.js).
assert.ok(frame.groom.hair.strandCount > 0 && frame.groom.hair.roots.every((vertex) => staticData.skinVertex[vertex] === 1), "hair strands root on skin vertices");
// Beard and brow strands root on one skin render vertex each (see gnm-player-facial-hair.js).
for (const key of ["beard", "brow"]) {
  const mesh = frame.groom[key];
  assert.ok(mesh.strandCount > 0 && mesh.roots.length === mesh.strandCount, `${key} strands have roots`);
  assert.ok(mesh.roots.every((vertex) => vertex < staticData.renderCount && staticData.skinVertex[vertex] === 1), `${key} strands root on skin vertices`);
}
// GPU ambient-occlusion plumbing: smoothing adjacency and groom root texels.
const neighbors = buildGnmPlayerAoNeighbors(staticData, model.vertexCount);
assert.equal(neighbors.length, staticData.renderCount * 8);
assert.deepEqual(buildGnmPlayerAoNeighbors(staticData, model.vertexCount), neighbors, "AO adjacency is deterministic");
let isolated = 0;
for (let vertex = 0; vertex < staticData.renderCount; vertex += 1) {
  const row = Array.from(neighbors.subarray(vertex * 8, vertex * 8 + 8)).filter((value) => value >= 0);
  if (row.length === 0) isolated += 1;
  for (const neighbor of row) {
    assert.ok(neighbor < staticData.renderCount && neighbor !== vertex, "neighbours are other render vertices");
    assert.notEqual(staticData.sourceIds[neighbor], staticData.sourceIds[vertex], "neighbours come from adjacent source vertices");
  }
}
assert.equal(isolated, 0, "every render vertex has mesh neighbours to smooth with");
const seamSources = new Map();
for (let vertex = 0; vertex < staticData.renderCount; vertex += 1) {
  const row = Array.from(neighbors.subarray(vertex * 8, vertex * 8 + 8)).join(",");
  const source = staticData.sourceIds[vertex];
  if (seamSources.has(source)) assert.equal(row, seamSources.get(source), "UV-seam duplicates smooth identically");
  else seamSources.set(source, row);
}
const bustNeighbors = buildGnmPlayerBustAoNeighbors(frame.bust.vertices.length / 3, frame.bust.collarVertexCount);
assert.deepEqual(Array.from(bustNeighbors.subarray(0, 8)), [1, 127, -1, 128, -1, -1, -1, -1], "bust grid wraps around each ring");
{
  // Hair strands read the AO texel of their root in the hair-envelope block, on every vertex.
  const mesh = frame.groom.hair;
  const aoIndices = gnmPlayerHairAoIndices(mesh, staticData.renderCount);
  assert.equal(aoIndices.length, mesh.vertices.length / 3);
  let vertex = 0;
  mesh.pointsPerStrand.forEach((count, strand) => {
    for (let item = 0; item < count * 2; item += 1) assert.equal(aoIndices[vertex + item], staticData.renderCount + mesh.roots[strand], "hair strand AO comes from its root");
    vertex += count * 2;
  });
}
for (const key of ["beard", "brow"]) {
  // Beard and brow strands read the AO texel of their root skin vertex (the skin block), on every vertex.
  const mesh = frame.groom[key];
  const aoIndices = gnmPlayerHairAoIndices(mesh, 0);
  assert.equal(aoIndices.length, mesh.vertices.length / 3);
  let vertex = 0;
  mesh.pointsPerStrand.forEach((count, strand) => {
    for (let item = 0; item < count * 2; item += 1) assert.equal(aoIndices[vertex + item], mesh.roots[strand], `${key} strand AO comes from its root`);
    vertex += count * 2;
  });
}
assert.equal(GNM_PLAYER_LIGHTING.model, "studio-environment-v3");
assert.equal(GNM_PLAYER_LIGHTING.cavity, "local-normal-curvature");
assert.deepEqual(Object.values(GNM_PLAYER_DEBUG_VIEWS), [20, 21, 22, 23, 24]);
const rendererSource = fs.readFileSync(new URL("../src/gnm-player-renderer.js", import.meta.url), "utf8");
assert.ok(!/\bfill(?:Direction|Color)\b/.test(rendererSource) && !rendererSource.includes("vec3(1.0, 0.42, 0.28)"), "the ad-hoc wrap/red scatter and directional fill are gone");
console.log("PASS real mesh: bounded deterministic curvature, region anchors, strand roots on skin vertices, AO smoothing adjacency and strand root texels, lighting descriptor");
