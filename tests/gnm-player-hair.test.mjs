import assert from "node:assert/strict";
import fs from "node:fs";
import { createProfile, hashSeed, setFeature, setKit } from "../src/face-model.js";
import { parseWebglGlb } from "../src/gnm-assets.js";
import { GNM_PLAYER_HAIR_STYLES, GNM_PLAYER_SIDE_PART, computeGnmPlayerNormals, gnmPlayerAppearance, gnmPlayerExpression, parseGnmPlayerPayload, reconstructGnmPlayerPositions, sampleGnmPlayerIdentity } from "../src/gnm-player-model.js";
import {
  GNM_PLAYER_HAIR,
  GNM_PLAYER_HAIR_GROOMS,
  buildGnmPlayerHair,
  computeGnmPlayerHeadMap,
  gnmPlayerFastAtan2,
  gnmPlayerHairGroom,
  gnmPlayerHeadHeight,
} from "../src/gnm-player-hair.js";
import { buildGnmPlayerStatic, computeGnmPlayerFrame, gnmPlayerBunFrame, gnmPlayerHairAoIndices } from "../src/gnm-player-renderer.js";

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
const scalp = staticData.hairScalp;
const at = (array, index) => [array[index * 3], array[index * 3 + 1], array[index * 3 + 2]];

// --- Helpers -----------------------------------------------------------
for (const [y, x] of [[0, 1], [1, 0], [-1, 0], [0, -1], [0.3, -0.7], [-2, 5], [1e-7, -3], [5, 5]]) {
  assert.ok(Math.abs(gnmPlayerFastAtan2(y, x) - Math.atan2(y, x)) < 2e-5, `fast atan2(${y}, ${x})`);
}

// --- Static scalp data -------------------------------------------------
assert.ok(Math.abs(scalp.candidateCount - GNM_PLAYER_HAIR.candidates) < GNM_PLAYER_HAIR.candidates * 0.03, `stratified candidates (${scalp.candidateCount})`);
assert.ok(scalp.guideCandidates.length > 800 && scalp.guideCandidates.length < 2500, `blue-noise guide roots (${scalp.guideCandidates.length})`);
for (let slot = 0; slot < scalp.candidateCount; slot += 1) {
  const weights = scalp.candidateBary.subarray(slot * 3, slot * 3 + 3);
  assert.ok(weights.every((value) => value >= -1e-6 && value <= 1 + 1e-6) && Math.abs(weights[0] + weights[1] + weights[2] - 1) < 1e-5, "candidates lie inside their root triangle");
  assert.ok(scalp.candidateTri.subarray(slot * 3, slot * 3 + 3).every((vertex) => staticData.skinVertex[vertex]), "candidates root on skin");
}
let emptyCells = 0;
for (let cell = 0; cell < scalp.mapTri.length / 3; cell += 1) emptyCells += scalp.mapTri[cell * 3] < 0 ? 1 : 0;
assert.equal(emptyCells, 0, "the collision map covers every direction");
// Guide spacing is blue noise: no two guides closer than the spacing.
const guideSpacing = GNM_PLAYER_HAIR.guideSpacingMm / 1000;
for (let a = 0; a < scalp.guideCandidates.length; a += 7) {
  const pa = at(scalp.candidatePosition, scalp.guideCandidates[a]);
  for (let b = 0; b < scalp.guideCandidates.length; b += 1) {
    if (a === b) continue;
    const pb = at(scalp.candidatePosition, scalp.guideCandidates[b]);
    assert.ok(Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) >= guideSpacing * 0.999, "guides keep their spacing");
  }
}
console.log(`PASS hair scalp: ${scalp.candidateCount} stratified candidates, ${scalp.guideCandidates.length} blue-noise guides, closed collision map, fast atan2`);

// --- Per-frame builds --------------------------------------------------
function reconstruct(profile, mode = "neutral") {
  const identity = sampleGnmPlayerIdentity(profile, model);
  const positions = reconstructGnmPlayerPositions(model, staticData.template, identity, gnmPlayerExpression(profile, mode).weights);
  const normals = computeGnmPlayerNormals(positions, staticData.sourceTriangles, model.vertexCount);
  const renderPositions = new Float32Array(staticData.renderCount * 3);
  const renderNormals = new Float32Array(staticData.renderCount * 3);
  for (let vertex = 0; vertex < staticData.renderCount; vertex += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      renderPositions[vertex * 3 + axis] = positions[staticData.sourceIds[vertex] * 3 + axis];
      renderNormals[vertex * 3 + axis] = normals[staticData.sourceIds[vertex] * 3 + axis];
    }
  }
  return { positions, normals, renderPositions, renderNormals };
}
const catalog = [...GNM_PLAYER_HAIR_STYLES, GNM_PLAYER_SIDE_PART];
assert.equal(Object.keys(GNM_PLAYER_HAIR_GROOMS).length, GNM_PLAYER_HAIR_STYLES.length, "one groom per catalog style");
for (const style of catalog) assert.ok(gnmPlayerHairGroom(style).label, `${style.asset} has a groom`);
assert.equal(gnmPlayerHairGroom(GNM_PLAYER_SIDE_PART).label, gnmPlayerHairGroom(GNM_PLAYER_HAIR_STYLES[3]).label, "the session side-part prototype shares the durable slot-3 groom");

const strandPoints = (mesh, strand, offset) => Array.from({ length: mesh.pointsPerStrand[strand] }, (_, p) => at(mesh.vertices, (offset + p) * 2));
function strandStats(mesh) {
  const stats = { lengths: [], tortuosity: [], minY: Infinity, maxY: -Infinity };
  let offset = 0;
  for (let strand = 0; strand < mesh.strandCount; strand += 1) {
    const points = strandPoints(mesh, strand, offset);
    let length = 0;
    for (let p = 1; p < points.length; p += 1) length += Math.hypot(points[p][0] - points[p - 1][0], points[p][1] - points[p - 1][1], points[p][2] - points[p - 1][2]);
    const chord = Math.hypot(points.at(-1)[0] - points[0][0], points.at(-1)[1] - points[0][1], points.at(-1)[2] - points[0][2]);
    stats.lengths.push(length);
    if (length > 0.02) stats.tortuosity.push(length / Math.max(chord, 1e-9));
    for (const point of points) { stats.minY = Math.min(stats.minY, point[1]); stats.maxY = Math.max(stats.maxY, point[1]); }
    offset += mesh.pointsPerStrand[strand];
  }
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  return { ...stats, medianLength: median(stats.lengths), maxLength: Math.max(...stats.lengths), medianTortuosity: median(stats.tortuosity) };
}

// Independent penetration check against the reconstructed skin: every non-root
// point within 4 mm of visible skin stays on the outer side of the tangent
// plane of its nearest visible skin vertex (skin below the crew-neck plane is
// clipped by the renderer; farther points are covered by the head map check).
function skinGrid(renderPositions, collarPlane) {
  const cell = 0.006, grid = new Map();
  for (let vertex = 0; vertex < staticData.renderCount; vertex += 1) {
    if (!staticData.skinVertex[vertex]) continue;
    const [x, y, z] = at(renderPositions, vertex);
    if (y + 0.12 * (z - collarPlane[1]) < collarPlane[0] - 0.001) continue;
    const key = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(vertex);
  }
  return { cell, grid };
}
const earSpec = model.fieldIndex.get("ear");
const earField = Float32Array.from(staticData.sourceIds, (source) => earSpec.min + (model.fields[earSpec.index * model.vertexCount + source] / 255) * (earSpec.max - earSpec.min));
const skinTriangles = staticData.indices.subarray(staticData.ranges.skin.start, staticData.ranges.skin.start + staticData.ranges.skin.count);
// Ray/skin crossings from a point (Moller-Trumbore); odd = inside along a ray that leaves through closed skin.
function crossings(renderPositions, point, direction) {
  let count = 0;
  for (let item = 0; item < skinTriangles.length; item += 3) {
    const a = at(renderPositions, skinTriangles[item]), b = at(renderPositions, skinTriangles[item + 1]), c = at(renderPositions, skinTriangles[item + 2]);
    if (Math.min(a[1], b[1], c[1]) > point[1] + 0.06 || Math.max(a[1], b[1], c[1]) < point[1] - 0.06) continue;
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const p = [direction[1] * e2[2] - direction[2] * e2[1], direction[2] * e2[0] - direction[0] * e2[2], direction[0] * e2[1] - direction[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-16) continue;
    const t = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
    const u = (t[0] * p[0] + t[1] * p[1] + t[2] * p[2]) / det;
    if (u < 0 || u > 1) continue;
    const q = [t[1] * e1[2] - t[2] * e1[1], t[2] * e1[0] - t[0] * e1[2], t[0] * e1[1] - t[1] * e1[0]];
    const v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) / det;
    if (v < 0 || u + v > 1) continue;
    if ((e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det > 0) count += 1;
  }
  return count;
}
function skinSignedDistance({ cell, grid }, renderPositions, renderNormals, point) {
  const [x, y, z] = point;
  let best = Infinity, signed = Infinity, nearest = -1;
  const [cx, cy, cz] = [Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell)];
  for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
    for (const vertex of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
      const v = at(renderPositions, vertex), n = at(renderNormals, vertex);
      const d = Math.hypot(x - v[0], y - v[1], z - v[2]);
      if (d < best) { best = d; nearest = vertex; signed = (x - v[0]) * n[0] + (y - v[1]) * n[1] + (z - v[2]) * n[2]; }
    }
  }
  if (best >= 0.004) return Infinity;
  // Next to the thin ear folds a tangent plane misleads: decide by ray parity
  // (outwards and upwards, both leaving through closed skin).
  if (signed < -0.0005 && earField[nearest] > 0.3) {
    const outward = [Math.sign(x) || 1, 0, 0];
    if (crossings(renderPositions, point, outward) % 2 === 0 || crossings(renderPositions, point, [0, 1, 0]) % 2 === 0) return Infinity;
  }
  return signed;
}

const identities = [
  { key: "base", profile: createProfile({ seed: hashSeed("hair-test:base"), age: 26 }) },
  { key: "broad", profile: [["head", 1], ["jaw", 4], ["faceProportion", 0], ["earShape", 3]].reduce((p, [k, v]) => setFeature(p, k, v), createProfile({ seed: hashSeed("hair-test:broad"), age: 44 })) },
  { key: "long", profile: [["head", 2], ["jaw", 0], ["faceProportion", 4], ["earShape", 2]].reduce((p, [k, v]) => setFeature(p, k, v), createProfile({ seed: hashSeed("hair-test:long"), age: 31 })) },
];
const stats = new Map();
let checkedPoints = 0;
for (const { key, profile } of identities) {
  const { positions, normals, renderPositions, renderNormals } = reconstruct(profile, key === "broad" ? "alert" : "neutral");
  const radii = computeGnmPlayerHeadMap(scalp, renderPositions, renderNormals);
  const bust = computeGnmPlayerFrame(resources, setFeature(profile, "hairVisible", 0), { expressionMode: key === "broad" ? "alert" : "neutral" }).bust;
  const grid = skinGrid(renderPositions, bust.collarPlane);
  for (const style of catalog) {
    const options = { bust, browTop: 0.335, bun: style.pattern === "bun" ? gnmPlayerBunFrame(staticData, positions, normals) : null };
    const mesh = buildGnmPlayerHair(scalp, renderPositions, renderNormals, style, profile.seed, options);
    const groom = gnmPlayerHairGroom(style);
    for (const array of [mesh.vertices, mesh.normals, mesh.uvs, mesh.surface]) assert.ok(array.every(Number.isFinite), `${style.asset}: finite strand data`);
    assert.ok(mesh.strandCount > groom.count * 0.9, `${style.asset}: ${mesh.strandCount} strands`);
    assert.equal(mesh.indices.length, (mesh.pointCount - mesh.strandCount) * 6);
    assert.equal(mesh.vertices.length, mesh.pointCount * 6);
    // Widths: positive, below 0.2 mm, tapering (except plaits and the bun wrap).
    for (let vertex = 0; vertex < mesh.pointCount * 2; vertex += 1) assert.ok(mesh.surface[vertex * 4] >= 0 && mesh.surface[vertex * 4] < 0.0002, "half-width bounded");
    // Ribbon uvs: (side, t, width boost); the boost widens hanging hair only
    // (styles with a hang), never at the root, and only below the ear tops
    // or where the strand stands off the scalp.
    assert.equal(mesh.uvs.length, mesh.pointCount * 6, "three uv components per ribbon vertex");
    let boosted = 0;
    for (let vertex = 0; vertex < mesh.pointCount * 2; vertex += 1) {
      const boost = mesh.uvs[vertex * 3 + 2];
      assert.ok(boost >= 0 && boost <= groom.hang + 1e-6, `${style.asset}: width boost within the style's hang`);
      if (boost > 0) boosted += 1;
    }
    assert.ok(groom.hang > 0 ? boosted > mesh.pointCount * 0.05 : boosted === 0, `${style.asset}: ${boosted} boosted ribbon vertices`);
    for (let strand = 0, first = 0; strand < mesh.strandCount; first += mesh.pointsPerStrand[strand], strand += 1) assert.equal(mesh.uvs[first * 6 + 2], 0, "no boost at the root");
    // Scalp strands fade over their last ~8 mm (4-20% of t).
    assert.ok(mesh.tipFade >= 0.8 && mesh.tipFade <= 0.96, `${style.asset}: tip fade start ${mesh.tipFade}`);
    // Bounds: around the head and shoulders (long hair drapes down the back
    // of the bust, which reaches y = -0.14, below the portrait frame).
    for (let point = 0; point < mesh.pointCount; point += 1) {
      const [x, y, z] = at(mesh.vertices, point * 2);
      assert.ok(Math.abs(x) < 0.2 && y > -0.02 && y < 0.47 && z > -0.22 && z < 0.2, `${style.asset}: point inside the portrait volume (${x}, ${y}, ${z})`);
    }
    // No scalp penetration: the collision map and the independent skin check.
    let offset = 0;
    for (let strand = 0; strand < mesh.strandCount; strand += 1) {
      const count = mesh.pointsPerStrand[strand];
      const kind = mesh.surface[offset * 8 + 3];
      for (let p = 1; p < count; p += 1) {
        const point = at(mesh.vertices, (offset + p) * 2);
        assert.ok(gnmPlayerHeadHeight(radii, ...point) > -0.00005, `${key}/${style.asset}: strand ${strand} point ${p} is outside the head`);
        if (kind === GNM_PLAYER_HAIR.kinds.scalp || kind === GNM_PLAYER_HAIR.kinds.baby || kind === GNM_PLAYER_HAIR.kinds.flyaway) {
          if (strand % 3 === 0) assert.ok(skinSignedDistance(grid, renderPositions, renderNormals, point) > -0.0005, `${key}/${style.asset}: strand ${strand} point ${p} does not penetrate the skin`);
        }
        checkedPoints += 1;
      }
      // Roots sit on the reconstructed skin.
      if (kind <= GNM_PLAYER_HAIR.kinds.baby) {
        const rootDistance = skinSignedDistance(grid, renderPositions, renderNormals, at(mesh.vertices, offset * 2));
        assert.ok(rootDistance === Infinity || Math.abs(rootDistance) < 0.0015, "roots sit on the skin");
      }
      offset += count;
    }
    if (key === "base") stats.set(style.asset, { mesh, ...strandStats(mesh) });
  }
}
console.log(`PASS hair strands: 13 grooms x 3 identities (one with an expression), finite, bounded, rooted, ${checkedPoints} points outside the head and the skin`);

// --- Per-style character and distinctness -------------------------------
const s = (asset) => stats.get(asset);
assert.ok(s("hair/short-01").maxLength < 0.006, "buzz cut: stubble only");
assert.ok(s("hair/short-03").medianLength < s("hair/short-02").medianLength, "caesar crop is shorter than the textured crop");
for (const asset of ["hair/long-01", "hair/long-02"]) assert.ok(s(asset).minY < 0.2 && s(asset).medianLength > 0.12, `${asset}: reaches the shoulders`);
assert.ok(s("hair/long-02").maxLength > s("hair/long-01").maxLength, "long-02 is the longest style");
assert.ok(s("hair/medium-02").minY < 0.24 && s("hair/medium-02").minY > s("hair/long-01").minY, "the bob ends between the jaw and the shoulders");
assert.ok(s("hair/curly-01").medianTortuosity > 1.35, `curls coil (tortuosity ${s("hair/curly-01").medianTortuosity.toFixed(2)})`);
for (const asset of ["hair/long-01", "hair/medium-01", "hair/short-03"]) assert.ok(s(asset).medianTortuosity < 1.25, `${asset} is straight`);
assert.ok(s("hair/braids-01").mesh.kinds.braid >= 3 * 10 * 3, "cornrows are plaited fibre bundles");
assert.ok(s("hair/braids-01").minY < 0.2, "braids hang below the nape");
assert.ok(s("hair/bun-01").mesh.kinds.bun > 500, "the bun is wound from strands");
for (const [asset, entry] of stats) if (!["hair/braids-01", "hair/bun-01"].includes(asset)) assert.equal(entry.mesh.kinds.braid + entry.mesh.kinds.bun, 0, `${asset} has no plaits or bun`);
assert.ok([...stats.values()].every((entry) => entry.mesh.babyHairs > 0), "every style has baby hairs at the hairline");
// Partings: roots avoid the part line where it divides the hair.
for (const [asset, partX] of [["hair/short-04", (z, mesh) => mesh.part.x0 + mesh.part.slope * z], ["hair/medium-02", (z, mesh) => mesh.part.x0]]) {
  const mesh = s(asset).mesh;
  let near = 0, total = 0, offset = 0;
  for (let strand = 0; strand < mesh.strandCount; strand += 1) {
    const [x, y, z] = at(mesh.vertices, offset * 2);
    if (y > 0.37 && z > 0.0) { total += 1; if (Math.abs(x - partX(z, mesh)) < 0.0008) near += 1; }
    offset += mesh.pointsPerStrand[strand];
  }
  assert.ok(total > 200 && near / total < 0.012, `${asset}: visible parting (${near}/${total} roots on the line)`);
}
// Every pair of catalog styles differs in rendered strands.
const catalogMeshes = GNM_PLAYER_HAIR_STYLES.map((style) => s(style.asset).mesh);
for (let a = 0; a < catalogMeshes.length; a += 1) for (let b = a + 1; b < catalogMeshes.length; b += 1) {
  assert.notDeepEqual(catalogMeshes[a].vertices.subarray(0, 3000), catalogMeshes[b].vertices.subarray(0, 3000), `styles ${a}/${b} differ`);
}
console.log(`PASS hair character: buzz stubble, crop lengths, long styles on the shoulders, bob, coiled curls (${s("hair/curly-01").medianTortuosity.toFixed(2)}), straight styles, plaits, bun, partings, baby hairs, 12 distinct grooms`);

// --- Determinism, seed variation and levels of detail --------------------
const base = identities[0].profile;
const baseGeometry = reconstruct(base);
for (const style of [GNM_PLAYER_HAIR_STYLES[4], GNM_PLAYER_HAIR_STYLES[10], GNM_PLAYER_HAIR_STYLES[6]]) {
  const build = (seed, lod = "full") => buildGnmPlayerHair(scalp, baseGeometry.renderPositions, baseGeometry.renderNormals, style, seed, { lod, browTop: 0.335 });
  const full = build(base.seed);
  assert.deepEqual(build(base.seed), full, `${style.asset}: same profile, same strands`);
  assert.notDeepEqual(build(base.seed + 1).vertices, full.vertices, `${style.asset}: seed-stable variation`);
  const reduced = build(base.seed, "reduced");
  const fraction = reduced.strandCount / full.strandCount;
  assert.ok(Math.abs(fraction - GNM_PLAYER_HAIR.reducedFraction) < 0.03, `${style.asset}: reduced level of detail (${fraction.toFixed(3)})`);
  assert.equal(full.tiers.reduced, reduced.strandCount);
  assert.equal(full.tiers.reducedIndexCount, reduced.indices.length);
  // Ambient-occlusion occluders: the same prefix strands in both levels of detail.
  assert.ok(full.tiers.aoIndexCount > 0 && full.tiers.aoIndexCount === reduced.tiers.aoIndexCount && full.tiers.ao === reduced.tiers.ao, "AO occluder prefix shared by both tiers");
  const prefix = reduced.pointCount * 6;
  assert.deepEqual(full.vertices.subarray(0, prefix), reduced.vertices, `${style.asset}: the reduced tier is exactly the first strands of the full build`);
  assert.deepEqual(full.surface.subarray(0, reduced.pointCount * 8), reduced.surface);
}
console.log("PASS hair determinism: identical rebuilds, seed-stable variation, reduced tier = prefix of the full build (thumbnails, direct fallback)");

// --- Aperiodicity -------------------------------------------------------------
// Root density on a grid over the scalp has no dominant spatial frequency,
// and per-strand randoms are uncorrelated with position.
{
  const mesh = s("hair/short-03").mesh;
  const grid = new Float64Array(64 * 64);
  let offset = 0;
  const randoms = [], xs = [];
  for (let strand = 0; strand < mesh.strandCount; strand += 1) {
    const [x, y, z] = at(mesh.vertices, offset * 2);
    const u = Math.floor(((Math.atan2(x, z - 0.0175) + Math.PI) / (2 * Math.PI)) * 64), v = Math.floor(((y - 0.2) / 0.22) * 64);
    if (u >= 0 && u < 64 && v >= 0 && v < 64) grid[v * 64 + u] += 1;
    randoms.push(mesh.surface[offset * 8 + 1]); xs.push(x);
    offset += mesh.pointsPerStrand[strand];
  }
  const mean = grid.reduce((a, b) => a + b, 0) / grid.length;
  let dc = 0, peak = 0;
  for (let ky = 0; ky < 32; ky += 1) for (let kx = 0; kx < 32; kx += 1) {
    let re = 0, im = 0;
    for (let v = 0; v < 64; v += 1) for (let u = 0; u < 64; u += 1) {
      const angle = (-2 * Math.PI * (kx * u + ky * v)) / 64;
      const value = grid[v * 64 + u] - mean;
      re += value * Math.cos(angle); im += value * Math.sin(angle);
    }
    const magnitude = Math.hypot(re, im);
    if (kx + ky > 2) peak = Math.max(peak, magnitude); else dc = Math.max(dc, magnitude);
  }
  // Broad (low-frequency) coverage shape is allowed; no sharp mid/high-frequency line.
  assert.ok(peak < Math.max(dc, 1) * 0.6, `no periodic root banding (peak ${peak.toFixed(1)} vs low-frequency ${dc.toFixed(1)})`);
  const n = randoms.length, mr = randoms.reduce((a, b) => a + b, 0) / n, mx = xs.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vr = 0, vx = 0;
  for (let i = 0; i < n; i += 1) { cov += (randoms[i] - mr) * (xs[i] - mx); vr += (randoms[i] - mr) ** 2; vx += (xs[i] - mx) ** 2; }
  assert.ok(Math.abs(cov / Math.sqrt(vr * vx)) < 0.05, "per-strand variation is independent of position");
}
const hairSource = fs.readFileSync(new URL("../src/gnm-player-hair.js", import.meta.url), "utf8");
const rendererSource = fs.readFileSync(new URL("../src/gnm-player-renderer.js", import.meta.url), "utf8");
assert.ok(!/sin\(vObject\.[xyz] \*/.test(rendererSource), "no periodic world-space stripe masks in the shaders");
const hairShader = rendererSource.split("function hairFragmentSource(")[1].split("}`;\n}")[0];
const pigmentCode = hairShader.split("// Pigment:")[1].split("// Absorption")[0];
assert.ok(!/\b(?:sin|cos)\s*\(/.test(pigmentCode) && !/vObject|vViewPosition/.test(pigmentCode), "strand pigment has no spatial or periodic masks");
assert.ok(!/discard/.test(hairShader.replace(/\$\{dithered[^}]*\}/, "")), "the multisampled hair shader never discards (hidden fragments can be rejected early)");
assert.ok(!/Math\.random/.test(hairSource), "hair generation never uses Math.random");
console.log("PASS hair aperiodicity: no dominant root frequency, uncorrelated per-strand variation, no periodic masks, no Math.random");

// --- Frame integration, isolation and visibility --------------------------
let groomed = createProfile({ seed: 90210, age: 29 });
for (const [key, value] of Object.entries({ hairVisible: 1, hair: 8, beard: 2, brows: 3 })) groomed = setFeature(groomed, key, value);
const frame = computeGnmPlayerFrame(resources, groomed, { expressionMode: "neutral" });
assert.equal(frame.groom.hair.style, "hair/long-02");
assert.equal(frame.groom.hair.lod, "full");
const thumbnail = computeGnmPlayerFrame(resources, groomed, { expressionMode: "neutral", hairDetail: "reduced" });
assert.equal(thumbnail.groom.hair.strandCount, frame.groom.hair.tiers.reduced, "thumbnails build only the reduced tier");
const ao = gnmPlayerHairAoIndices(frame.groom.hair, staticData.renderCount);
assert.ok(ao.every((value) => value >= staticData.renderCount && value < staticData.renderCount * 2), "strand AO reads the hair-envelope block of its root");
// Unrelated controls never change the hair; hair controls never change the face, eyes, beard or brows.
for (const [key, value] of [["beard", 4], ["brows", 6], ["eyeColor", 3], ["skin", 6], ["freckles", 1], ["scar", 1], ["glasses", 1]]) {
  const edited = computeGnmPlayerFrame(resources, setFeature(groomed, key, value), { expressionMode: "neutral" });
  assert.deepEqual(edited.groom.hair.vertices, frame.groom.hair.vertices, `${key}: hair strands unchanged`);
}
assert.deepEqual(computeGnmPlayerFrame(resources, setKit(groomed, "#aa0000", "#00aa00"), { expressionMode: "neutral" }).groom.hair.surface, frame.groom.hair.surface, "kit colours never change the hair");
for (const [key, value] of [["hair", 2], ["hairColor", 5], ["hairVisible", 0]]) {
  const edited = computeGnmPlayerFrame(resources, setFeature(groomed, key, value), { expressionMode: "neutral" });
  assert.deepEqual(edited.renderPositions, frame.renderPositions, `${key}: face geometry unchanged`);
  assert.deepEqual(edited.eyes.lashes, frame.eyes.lashes, `${key}: eyes unchanged`);
  assert.deepEqual(edited.groom.beard, frame.groom.beard, `${key}: beard unchanged`);
  assert.deepEqual(edited.groom.brow, frame.groom.brow, `${key}: brows unchanged`);
}
const colour = computeGnmPlayerFrame(resources, setFeature(groomed, "hairColor", 5), { expressionMode: "neutral" });
assert.deepEqual(colour.groom.hair.vertices, frame.groom.hair.vertices, "hair colour is shading only");
const hidden = computeGnmPlayerFrame(resources, setFeature(groomed, "hairVisible", 0), { expressionMode: "neutral" });
assert.equal(hidden.groom.hair.strandCount, 0, "hidden hair has no strands");
const aged = gnmPlayerAppearance(setFeature(createProfile({ seed: 5, age: 58 }), "hairVisible", 1));
assert.ok(aged.hairGrey > 0.5, "older players have grey strands");
for (let channel = 0; channel < 3; channel += 1) assert.ok(Math.abs(aged.hairPigment[channel] + (aged.hairGreyColor[channel] - aged.hairPigment[channel]) * aged.hairGrey - aged.hair[channel]) < 1e-12, "grey strand fraction keeps the mean hair colour");
console.log("PASS hair integration: frame build, thumbnail tier, root AO texels, isolation from unrelated controls, face/eyes/beard/brows untouched by hair, hidden hair, grey strand mean");
