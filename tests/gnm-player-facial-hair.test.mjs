import assert from "node:assert/strict";
import fs from "node:fs";
import { createProfile, hashSeed, setFeature, setKit } from "../src/face-model.js";
import { parseWebglGlb } from "../src/gnm-assets.js";
import { GNM_PLAYER_BEARD_STYLES, GNM_PLAYER_BROW_STYLES, gnmPlayerAppearance, gnmPlayerLandmarks, parseGnmPlayerPayload } from "../src/gnm-player-model.js";
import {
  GNM_PLAYER_BEARD_GROOMS,
  GNM_PLAYER_BROW_GROOMS,
  GNM_PLAYER_FACIAL_HAIR,
  buildGnmPlayerBeard,
  buildGnmPlayerBrows,
  gnmPlayerBeardGroom,
  gnmPlayerBrowGroom,
  gnmPlayerFacialHairUnderlay,
} from "../src/gnm-player-facial-hair.js";
import { buildGnmPlayerStatic, computeGnmPlayerFrame, gnmPlayerFacialHairFibre, gnmPlayerHairAoIndices } from "../src/gnm-player-renderer.js";

const work = new URL("../tools/gnm/work/", import.meta.url);
const read = (name) => {
  const buffer = fs.readFileSync(new URL(name, work));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};
const model = parseGnmPlayerPayload(JSON.parse(fs.readFileSync(new URL("gnm-player-generator.json", work), "utf8")), read("gnm-player-generator.bin"));
const asset = parseWebglGlb(read("gnm-official-head-render.glb"));
const staticData = buildGnmPlayerStatic(asset, model);
const resources = { model, asset, staticData };
const data = staticData.facialHair;
const at = (array, index) => [array[index * 3], array[index * 3 + 1], array[index * 3 + 2]];
const templateLandmarks = gnmPlayerLandmarks(model, staticData.template);
const landmark = (landmarks, index) => at(landmarks, index);

// --- Static zone data ---------------------------------------------------------
{
  const { count, tri, zone, neighbor } = data.triangles;
  assert.ok(count > 3000, `walkable facial skin (${count} triangles)`);
  for (let t = 0; t < count; t += 1) {
    assert.ok(zone[t] > 0, "every walkable triangle belongs to a zone");
    for (let k = 0; k < 3; k += 1) {
      const u = neighbor[t * 3 + k];
      if (u < 0) continue;
      assert.ok([0, 1, 2].some((m) => neighbor[u * 3 + m] === t), "edge neighbours are mutual");
    }
  }
  const lidTop = [Math.max(landmark(templateLandmarks, 37)[1], landmark(templateLandmarks, 38)[1]), Math.max(landmark(templateLandmarks, 43)[1], landmark(templateLandmarks, 44)[1])];
  const subnasale = landmark(templateLandmarks, 33)[1];
  const alar = Math.max(Math.abs(landmark(templateLandmarks, 31)[0]), Math.abs(landmark(templateLandmarks, 35)[0]));
  for (const [part, candidates] of [["brow", data.brow], ["beard", data.beard]]) {
    assert.ok(candidates.count > 5000, `${part}: ${candidates.count} root candidates`);
    for (let slot = 0; slot < candidates.count; slot += 1) {
      const b = candidates.bary.subarray(slot * 3, slot * 3 + 3);
      assert.ok(b.every((value) => value >= -1e-6 && value <= 1 + 1e-6) && Math.abs(b[0] + b[1] + b[2] - 1) < 1e-5, `${part}: candidates lie inside their triangle`);
      assert.ok(zone[candidates.tri[slot]] & (part === "brow" ? 1 : 2), `${part}: candidates lie in their zone`);
      const [x, y] = at(candidates.position, slot);
      if (part === "brow") assert.ok(y > lidTop[x < 0 ? 0 : 1], "brow roots stay above the upper lids");
      else assert.ok(!(y > subnasale && Math.abs(x) < alar), "beard roots stay off the nose");
    }
  }
  // Clump seeds are blue noise; every candidate has a nearby seed.
  const spacing = GNM_PLAYER_FACIAL_HAIR.clumpSpacingMm / 1000;
  const seeds = Array.from(data.beard.seeds, (slot) => at(data.beard.position, slot));
  for (let a = 0; a < seeds.length; a += 5) for (let b = 0; b < seeds.length; b += 1) {
    if (a !== b) assert.ok(Math.hypot(seeds[a][0] - seeds[b][0], seeds[a][1] - seeds[b][1], seeds[a][2] - seeds[b][2]) >= spacing * 0.999, "clump seeds keep their spacing");
  }
  let assigned = 0;
  for (let slot = 0; slot < data.beard.count; slot += 1) {
    const seed = data.beard.clump[slot];
    if (seed < 0) continue;
    assigned += 1;
    const [x, y, z] = at(data.beard.position, slot), s = seeds[seed];
    assert.ok(Math.hypot(x - s[0], y - s[1], z - s[2]) < spacing * 2.5, "a candidate clumps to a nearby seed");
  }
  assert.ok(assigned > data.beard.count * 0.97, "almost every beard candidate has a clump seed");
  console.log(`PASS facial hair static: ${count} walkable triangles with mutual neighbours, ${data.brow.count} brow and ${data.beard.count} beard candidates in their zones, ${seeds.length} blue-noise clump seeds`);
}

// --- Geometry helpers ----------------------------------------------------------
const skinTriangles = staticData.indices.subarray(staticData.ranges.skin.start, staticData.ranges.skin.start + staticData.ranges.skin.count);
const lipField = staticData.facialHair.fields.lip, sockField = staticData.facialHair.fields.mouthSock;

/**
 * Exact signed distance (m) to the reconstructed skin near the face, from
 * the closest point on the skin triangles within `margin` (sign from the
 * interpolated vertex normal there); Infinity when no skin is that close.
 * Also returns the nearest render vertex of the closest triangle.
 */
function skinField(renderPositions, renderNormals, margin = 0.003) {
  const cell = 0.004;
  const grid = new Map();
  const key = (i, j, k) => `${i},${j},${k}`;
  for (let item = 0; item < skinTriangles.length; item += 3) {
    const a = at(renderPositions, skinTriangles[item]), b = at(renderPositions, skinTriangles[item + 1]), c = at(renderPositions, skinTriangles[item + 2]);
    if (Math.max(a[1], b[1], c[1]) < 0.11) continue;
    const lo = [0, 1, 2].map((axis) => Math.floor((Math.min(a[axis], b[axis], c[axis]) - margin) / cell));
    const hi = [0, 1, 2].map((axis) => Math.floor((Math.max(a[axis], b[axis], c[axis]) + margin) / cell));
    for (let i = lo[0]; i <= hi[0]; i += 1) for (let j = lo[1]; j <= hi[1]; j += 1) for (let k = lo[2]; k <= hi[2]; k += 1) {
      const entry = key(i, j, k);
      if (!grid.has(entry)) grid.set(entry, []);
      grid.get(entry).push(item);
    }
  }
  const closest = (p, a, b, c) => {
    // Ericson, Real-Time Collision Detection 5.1.5: barycentric weights of the closest point.
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
    const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
    const d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [1 - v, v, 0]; }
    const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    const d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [1 - w, 0, w]; }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [0, 1 - w, w]; }
    const denominator = 1 / (va + vb + vc);
    const v = vb * denominator, w = vc * denominator;
    return [1 - v - w, v, w];
  };
  return (p) => {
    const list = grid.get(key(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)));
    let best = Infinity, signed = Infinity, vertex = -1;
    for (const item of list ?? []) {
      const ids = [skinTriangles[item], skinTriangles[item + 1], skinTriangles[item + 2]];
      const [a, b, c] = ids.map((id) => at(renderPositions, id));
      const w = closest(p, a, b, c);
      const q = [0, 1, 2].map((axis) => w[0] * a[axis] + w[1] * b[axis] + w[2] * c[axis]);
      const distance = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (distance >= best || distance > margin) continue;
      const n = [0, 1, 2].map((axis) => w[0] * renderNormals[ids[0] * 3 + axis] + w[1] * renderNormals[ids[1] * 3 + axis] + w[2] * renderNormals[ids[2] * 3 + axis]);
      best = distance;
      signed = (p[0] - q[0]) * n[0] + (p[1] - q[1]) * n[1] + (p[2] - q[2]) * n[2] >= 0 ? distance : -distance;
      vertex = ids[w[0] >= w[1] && w[0] >= w[2] ? 0 : w[1] >= w[2] ? 1 : 2];
    }
    return { signed, vertex };
  };
}

/** Strands of a mesh as arrays of points, with their kinds. */
function strandsOf(mesh) {
  const strands = [];
  let offset = 0;
  for (let strand = 0; strand < mesh.strandCount; strand += 1) {
    const count = mesh.pointsPerStrand[strand];
    strands.push({ points: Array.from({ length: count }, (_, p) => at(mesh.vertices, (offset + p) * 2)), kind: mesh.surface[offset * 8 + 3], random: mesh.surface[offset * 8 + 1], offset });
    offset += count;
  }
  return strands;
}
const length = (points) => points.slice(1).reduce((sum, point, p) => sum + Math.hypot(point[0] - points[p][0], point[1] - points[p][1], point[2] - points[p][2]), 0);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

function checkMesh(mesh, label, part) {
  for (const array of [mesh.vertices, mesh.normals, mesh.uvs, mesh.surface]) assert.ok(array.every(Number.isFinite), `${label}: finite strand data`);
  assert.equal(mesh.vertices.length, mesh.pointCount * 6, `${label}: two ribbon vertices per point`);
  assert.equal(mesh.indices.length, (mesh.pointCount - mesh.strandCount) * 6, `${label}: two triangles per segment`);
  assert.equal(mesh.uvs.length, mesh.pointCount * 6, `${label}: three uv components per ribbon vertex`);
  for (let vertex = 0; vertex < mesh.pointCount * 2; vertex += 1) {
    const halfWidth = mesh.surface[vertex * 4];
    assert.ok(halfWidth >= 0 && halfWidth < 0.0001, `${label}: half-width below 0.1 mm`);
    assert.equal(mesh.uvs[vertex * 3 + 2], 0, `${label}: no hanging-hair width boost`);
    assert.ok([0, 1, 2].includes(mesh.surface[vertex * 4 + 3]), `${label}: terminal, stray or fine hair`);
  }
  assert.equal(mesh.part, part);
  assert.equal(mesh.rootVertices.length, mesh.pointCount * 2);
  for (const vertex of mesh.roots) assert.ok(staticData.skinVertex[vertex] === 1, `${label}: AO texels are skin vertices`);
}

// --- Builds: bounds, rooting, no penetration --------------------------------------
const identities = [
  { key: "base", profile: createProfile({ seed: hashSeed("facial-hair-test:base"), age: 26 }), mode: "neutral" },
  { key: "broad", profile: [["head", 1], ["jaw", 4], ["faceProportion", 0], ["mouth", 3], ["nose", 1]].reduce((p, [k, v]) => setFeature(p, k, v), createProfile({ seed: hashSeed("facial-hair-test:broad"), age: 44 })), mode: "alert" },
  { key: "long", profile: [["head", 2], ["jaw", 0], ["faceProportion", 4], ["eyes", 1], ["mouth", 1]].reduce((p, [k, v]) => setFeature(p, k, v), createProfile({ seed: hashSeed("facial-hair-test:long"), age: 31 })), mode: "soft" },
];
const built = new Map();
let checkedPoints = 0, minimumHeight = Infinity;
for (const { key, profile, mode } of identities) {
  const frame = computeGnmPlayerFrame(resources, setFeature(profile, "beard", 0), { expressionMode: mode });
  const { renderPositions, renderNormals, bust, landmarks } = frame;
  const skin = skinField(renderPositions, renderNormals);
  const lids = [Math.max(landmark(landmarks, 37)[1], landmark(landmarks, 38)[1]), Math.max(landmark(landmarks, 43)[1], landmark(landmarks, 44)[1])];
  const browTop = Math.max(...[17, 18, 19, 20, 21, 22, 23, 24, 25, 26].map((index) => landmark(landmarks, index)[1]));
  const checkPoints = (mesh, label, every, extra) => {
    strandsOf(mesh).forEach((strand, index) => {
      // Roots sit on the skin.
      const root = skin(strand.points[0]);
      assert.ok(Math.abs(root.signed) < 0.00005, `${label}: strand ${index} is rooted on the skin (${root.signed})`);
      if (index % every) return;
      for (let p = 1; p < strand.points.length; p += 1) {
        const point = strand.points[p];
        const { signed, vertex } = skin(point);
        assert.ok(signed > -0.00002, `${label}: strand ${index} point ${p} does not penetrate the skin (${(signed * 1000).toFixed(3)} mm)`);
        if (signed < minimumHeight) minimumHeight = signed;
        if (extra) extra(point, vertex, index, p, signed);
        checkedPoints += 1;
      }
    });
  };
  for (const style of GNM_PLAYER_BROW_STYLES) {
    const mesh = buildGnmPlayerBrows(data, renderPositions, renderNormals, style, profile.seed);
    const label = `${key}/${style.asset}`;
    checkMesh(mesh, label, "brow");
    assert.ok(mesh.strandCount > 400 && mesh.strandCount < 4000, `${label}: ${mesh.strandCount} brow hairs`);
    // No brow hair anywhere but the brows: above the upper lids, below the forehead, off the midline.
    checkPoints(mesh, label, 1, ([x, y]) => {
      assert.ok(y > lids[x < 0 ? 0 : 1] && y < browTop + 0.022 && Math.abs(x) > 0.003 && Math.abs(x) < 0.08, `${label}: brow hair inside the brow region (${x}, ${y})`);
    });
    if (key === "base") built.set(style.asset, mesh);
  }
  const collar = bust.collarPlane;
  for (const style of GNM_PLAYER_BEARD_STYLES) {
    const mesh = buildGnmPlayerBeard(data, renderPositions, renderNormals, style, profile.seed, { collarPlane: collar });
    const label = `${key}/${style.asset}`;
    if (style.asset === "beard/none") { assert.equal(mesh.strandCount, 0, "no beard, no strands"); continue; }
    checkMesh(mesh, label, "beard");
    assert.ok(mesh.strandCount > 150, `${label}: ${mesh.strandCount} beard hairs`);
    checkPoints(mesh, label, style.asset === "beard/full" ? 3 : 2, (point, vertex, index, p, signed) => {
      const [x, y, z] = point;
      // Above the collar, never lying on the red lips (a moustache may overhang
      // them) or inside the mouth, never on the nose.
      assert.ok(y + 0.12 * (z - collar[1]) >= collar[0] + GNM_PLAYER_FACIAL_HAIR.collarMarginMm / 1000 - 1e-6, `${label}: strand ${index} stays above the collar`);
      if (vertex >= 0) {
        assert.ok(sockField[vertex] < 0.25, `${label}: strand ${index} point ${p} lies in the mouth (mouth ${sockField[vertex]})`);
        assert.ok(signed > 0.0008 || lipField[vertex] < 0.9, `${label}: strand ${index} point ${p} lies on the red lip (lip ${lipField[vertex]})`);
        const t = at(staticData.positions, vertex);
        const subnasale = landmark(templateLandmarks, 33)[1];
        assert.ok(!(t[1] > subnasale + 0.001 && Math.abs(t[0]) < Math.abs(landmark(templateLandmarks, 35)[0])), `${label}: strand ${index} point ${p} lies on the nose`);
      }
    });
    if (key === "base") built.set(style.asset, mesh);
  }
}
console.log(`PASS facial hair strands: 8 brows and 6 beards x 3 identities (neutral, alert, soft), finite, bounded, rooted on the skin; ${checkedPoints} points outside the skin (lowest ${(minimumHeight * 1000).toFixed(3)} mm), brows inside the brow region, beards above the collar, never lying on the red lips, in the mouth or on the nose`);

// Every expression preset keeps the moustache, goatee and full beard out of the lips and the mouth.
{
  const profile = identities[0].profile;
  let points = 0;
  for (const mode of ["neutral", "alert", "soft", "focused"]) {
    const frame = computeGnmPlayerFrame(resources, profile, { expressionMode: mode });
    const skin = skinField(frame.renderPositions, frame.renderNormals);
    for (const style of [GNM_PLAYER_BEARD_STYLES[3], GNM_PLAYER_BEARD_STYLES[4], GNM_PLAYER_BEARD_STYLES[5]]) {
      const mesh = buildGnmPlayerBeard(data, frame.renderPositions, frame.renderNormals, style, profile.seed, { collarPlane: frame.bust.collarPlane });
      for (const strand of strandsOf(mesh)) {
        const [x, y] = strand.points[0];
        if (Math.abs(x) > 0.04 || y < 0.19 || y > 0.26) continue;
        for (let p = 1; p < strand.points.length; p += 1) {
          const { signed, vertex } = skin(strand.points[p]);
          assert.ok(signed > -0.00002, `${mode}/${style.asset}: no mouth-area point penetrates the skin`);
          if (vertex >= 0) assert.ok(sockField[vertex] < 0.25 && (signed > 0.0008 || lipField[vertex] < 0.9), `${mode}/${style.asset}: no point lying on the red lips or in the mouth`);
          points += 1;
        }
      }
    }
  }
  console.log(`PASS lips and mouth: moustache, goatee and full beard under all 4 expression presets (${points} mouth-area points)`);
}

// --- Growth direction per region --------------------------------------------------
{
  const frame = computeGnmPlayerFrame(resources, setFeature(identities[0].profile, "beard", 0), { expressionMode: "neutral" });
  const lm = frame.landmarks;
  const inner = Math.abs(landmark(lm, 21)[0]), outer = Math.abs(landmark(lm, 17)[0]);
  const browT = (x) => (Math.abs(x) - inner) / (outer - inner);
  for (const asset of ["brows/soft", "brows/thick", "brows/arched", "brows/flat"]) {
    const bins = { head: [], body: [], tail: [] };
    for (const strand of strandsOf(built.get(asset))) {
      if (strand.kind !== 0) continue;
      const root = strand.points[0], tip = strand.points.at(-1);
      const out = Math.sign(root[0]) * (tip[0] - root[0]), up = tip[1] - root[1];
      const t = browT(root[0]);
      if (t < 0.08) bins.head.push([out, up]); else if (t > 0.3 && t < 0.5) bins.body.push([out, up]); else if (t > 0.85) bins.tail.push([out, up]);
    }
    const mean = (list, k) => list.reduce((sum, value) => sum + value[k], 0) / list.length;
    assert.ok(bins.head.length > 10 && bins.body.length > 30 && bins.tail.length > 10, `${asset}: hairs in every part of the brow`);
    assert.ok(mean(bins.head, 1) > Math.abs(mean(bins.head, 0)) && mean(bins.head, 0) > -0.0005, `${asset}: head hairs point up and slightly out`);
    assert.ok(mean(bins.body, 0) > 0.002 && mean(bins.body, 1) > 0 && mean(bins.body, 0) > mean(bins.body, 1), `${asset}: body hairs point up and out`);
    assert.ok(mean(bins.tail, 0) > 0.002 && mean(bins.tail, 1) < 0, `${asset}: tail hairs point out and down`);
  }
  // Brow hairs lie close to the skin: tips within ~1.2 mm of it.
  const skin = skinField(frame.renderPositions, frame.renderNormals);
  const heights = strandsOf(built.get("brows/soft")).map((strand) => skin(strand.points.at(-1)).signed);
  assert.ok(median(heights) < 0.0008 && Math.max(...heights.filter(Number.isFinite)) < 0.0025, `brow hairs lie close to the skin (median tip height ${(median(heights) * 1000).toFixed(2)} mm)`);
  // Beard: down on the cheeks, down (and forward) on the chin, down and out on the moustache, down or back on the neck.
  const mouthY = (landmark(lm, 51)[1] + landmark(lm, 57)[1]) / 2, chinY = landmark(lm, 8)[1], noseY = landmark(lm, 33)[1], upperLip = landmark(lm, 51)[1];
  const regions = { cheek: [], chin: [], moustache: [], neck: [] };
  for (const strand of strandsOf(built.get("beard/short"))) {
    if (strand.kind !== 0) continue;
    const root = strand.points[0], tip = strand.points.at(-1);
    const d = [tip[0] - root[0], tip[1] - root[1], tip[2] - root[2]];
    const [x, y] = root;
    if (Math.abs(x) > 0.045 && y > mouthY && y < noseY) regions.cheek.push(d);
    else if (Math.abs(x) < 0.012 && y < landmark(lm, 57)[1] - 0.006 && y > chinY + 0.004) regions.chin.push(d);
    else if (Math.abs(x) > 0.004 && Math.abs(x) < 0.02 && y > upperLip + 0.002 && y < noseY - 0.002) regions.moustache.push([Math.sign(x) * d[0], d[1], d[2]]);
    else if (y < chinY - 0.012) regions.neck.push(d);
  }
  const share = (list, test) => list.filter(test).length / Math.max(list.length, 1);
  for (const [region, list] of Object.entries(regions)) assert.ok(list.length > 20, `short beard: strands on the ${region} (${list.length})`);
  assert.ok(share(regions.cheek, (d) => d[1] < 0 && -d[1] > Math.abs(d[0])) > 0.8, "cheek hair grows down");
  assert.ok(share(regions.chin, (d) => d[1] < 0) > 0.85 && share(regions.chin, (d) => d[2] > -0.3 * Math.abs(d[1])) > 0.8, "chin hair grows down and forward");
  assert.ok(share(regions.moustache, (d) => d[1] < 0 && d[0] > 0) > 0.75, "moustache hair grows down and out");
  assert.ok(share(regions.neck, (d) => d[1] < 0 || d[2] < 0) > 0.85, "neck hair grows down or back towards the throat");
  console.log(`PASS growth pattern: brow heads up, bodies up and out, tails out and down, hairs lying close to the skin; beard down on the cheeks, down and forward on the chin, down and out on the moustache, down/back on the neck`);
}

// --- Per-style character and distinctness -------------------------------------------
{
  const brows = GNM_PLAYER_BROW_STYLES.map((style) => built.get(style.asset));
  for (let a = 0; a < brows.length; a += 1) for (let b = a + 1; b < brows.length; b += 1) assert.notDeepEqual(brows[a].vertices, brows[b].vertices, `brow styles ${a}/${b} differ`);
  const rootsOf = (mesh) => strandsOf(mesh).map((strand) => strand.points[0]);
  const meanY = (mesh) => { const roots = rootsOf(mesh); return roots.reduce((sum, p) => sum + p[1], 0) / roots.length; };
  const extentX = (mesh) => Math.max(...strandsOf(mesh).flatMap((strand) => strand.points.map((p) => Math.abs(p[0]))));
  const s = (asset) => built.get(`brows/${asset}`);
  assert.ok(meanY(s("low")) < meanY(s("soft")) - 0.0015 && meanY(s("high")) > meanY(s("soft")) + 0.0015, "low and high brows keep their offsets");
  assert.ok(s("thick").strandCount > s("soft").strandCount * 1.3, "thick brows have more hairs");
  assert.ok(extentX(s("short")) < extentX(s("soft")) - 0.002, "short brows end earlier");
  const peakRise = (mesh) => {
    const roots = rootsOf(mesh).filter((p) => p[0] > 0);
    const xs = roots.map((p) => p[0]), lo = Math.min(...xs), hi = Math.max(...xs);
    const band = (from, to) => { const list = roots.filter((p) => p[0] >= lo + (hi - lo) * from && p[0] <= lo + (hi - lo) * to); return list.reduce((sum, p) => sum + p[1], 0) / list.length; };
    return band(0.45, 0.65) - (band(0, 0.12) + band(0.88, 1)) / 2;
  };
  assert.ok(peakRise(s("arched")) > peakRise(s("flat")) + 0.0015, "arched brows rise more than flat ones");
  const beards = GNM_PLAYER_BEARD_STYLES.slice(1).map((style) => built.get(style.asset));
  for (let a = 0; a < beards.length; a += 1) for (let b = a + 1; b < beards.length; b += 1) assert.notDeepEqual(beards[a].vertices, beards[b].vertices, `beard styles ${a + 1}/${b + 1} differ`);
  const lengths = (asset) => strandsOf(built.get(asset)).filter((strand) => strand.kind === 0).map((strand) => length(strand.points));
  assert.ok(Math.max(...lengths("beard/stubble")) < 0.0022, "stubble is very short");
  assert.ok(median(lengths("beard/short")) > 0.003 && median(lengths("beard/short")) < 0.009, "the short beard is short");
  assert.ok(median(lengths("beard/full")) > 0.011, "the full beard is long");
  assert.ok(built.get("beard/stubble").strandCount > built.get("beard/short").strandCount * 0.8, "stubble is dense");
  // The full beard has volume: strand tips stand well off the skin, and it hangs below the jaw.
  const frame = computeGnmPlayerFrame(resources, setFeature(identities[0].profile, "beard", 0), { expressionMode: "neutral" });
  const skin = skinField(frame.renderPositions, frame.renderNormals, 0.02);
  const tipHeights = (asset) => strandsOf(built.get(asset)).filter((_, index) => index % 4 === 0).map((strand) => skin(strand.points.at(-1)).signed).filter(Number.isFinite);
  assert.ok(median(tipHeights("beard/full")) > median(tipHeights("beard/short")) * 2 && median(tipHeights("beard/full")) > 0.0025, "the full beard stands off the skin");
  // Chin hair of the full beard hangs below the jawline (the menton).
  const chinY = landmark(frame.landmarks, 8)[1];
  const chinTips = (asset) => strandsOf(built.get(asset)).filter((strand) => Math.abs(strand.points[0][0]) < 0.015 && strand.points[0][1] > chinY + 0.004 && strand.points[0][1] < chinY + 0.02).map((strand) => Math.min(...strand.points.map((p) => p[1])));
  assert.ok(median(chinTips("beard/full")) < chinY - 0.004 && median(chinTips("beard/full")) < median(chinTips("beard/short")) - 0.004, `the full beard hangs below the jawline (chin tips ${((median(chinTips("beard/full")) - chinY) * 1000).toFixed(1)} mm)`);
  // Goatee and moustache keep their shapes: no cheek hair; the moustache stays above the mouth.
  const mouth = landmark(frame.landmarks, 62)[1];
  for (const asset of ["beard/goatee", "beard/moustache"]) {
    const roots = rootsOf(built.get(asset));
    assert.ok(roots.every(([x, y]) => Math.abs(x) < 0.036 && y < landmark(frame.landmarks, 33)[1] + 0.001), `${asset}: no cheek or nose hair`);
  }
  assert.ok(rootsOf(built.get("beard/moustache")).every(([, y]) => y > mouth), "the moustache roots above the mouth");
  const goateeRoots = rootsOf(built.get("beard/goatee"));
  assert.ok(goateeRoots.some(([, y]) => y < mouth - 0.02) && goateeRoots.some(([, y]) => y > mouth + 0.004), "the goatee has chin and moustache hair");
  console.log("PASS style character: 8 distinct brows (offsets, thickness, length, arch kept), 6 distinct beards (stubble, short, full with volume, goatee and moustache shapes)");
}

// --- Determinism, seed variation, levels of detail ------------------------------------
{
  const profile = identities[0].profile;
  const frame = computeGnmPlayerFrame(resources, setFeature(profile, "beard", 0), { expressionMode: "neutral" });
  const { renderPositions: positions, renderNormals: normals } = frame;
  for (const [build, style] of [[buildGnmPlayerBrows, GNM_PLAYER_BROW_STYLES[3]], [buildGnmPlayerBrows, GNM_PLAYER_BROW_STYLES[5]], [buildGnmPlayerBeard, GNM_PLAYER_BEARD_STYLES[1]], [buildGnmPlayerBeard, GNM_PLAYER_BEARD_STYLES[3]], [buildGnmPlayerBeard, GNM_PLAYER_BEARD_STYLES[5]]]) {
    const full = build(data, positions, normals, style, profile.seed);
    assert.deepEqual(build(data, positions, normals, style, profile.seed), full, `${style.asset}: same profile, same strands`);
    assert.notDeepEqual(build(data, positions, normals, style, profile.seed + 1).vertices, full.vertices, `${style.asset}: seed-stable variation`);
    const reduced = build(data, positions, normals, style, profile.seed, { lod: "reduced" });
    const fraction = reduced.strandCount / full.strandCount;
    assert.ok(Math.abs(fraction - GNM_PLAYER_FACIAL_HAIR.reducedFraction) < 0.07, `${style.asset}: reduced level of detail (${fraction.toFixed(3)})`);
    assert.equal(full.tiers.reduced, reduced.strandCount);
    assert.equal(full.tiers.reducedIndexCount, reduced.indices.length);
    assert.deepEqual(full.vertices.subarray(0, reduced.pointCount * 6), reduced.vertices, `${style.asset}: the reduced tier is exactly the first strands of the full build`);
    assert.deepEqual(full.surface.subarray(0, reduced.pointCount * 8), reduced.surface);
    assert.ok(full.tiers.aoIndexCount > 0 && full.tiers.aoIndexCount === reduced.tiers.aoIndexCount, "AO occluder prefix shared by both tiers");
  }
  console.log("PASS facial hair determinism: identical rebuilds, seed-stable variation, reduced tier = exact prefix of the full build");
}

// --- Aperiodicity ----------------------------------------------------------------------
{
  const mesh = built.get("beard/stubble");
  const grid = new Float64Array(64 * 64);
  const randoms = [], xs = [];
  for (const strand of strandsOf(mesh)) {
    const [x, y, z] = strand.points[0];
    const u = Math.floor(((Math.atan2(x, z - 0.0175) + Math.PI) / (2 * Math.PI)) * 64), v = Math.floor(((y - 0.14) / 0.14) * 64);
    if (u >= 0 && u < 64 && v >= 0 && v < 64) grid[v * 64 + u] += 1;
    randoms.push(strand.random); xs.push(x);
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
  assert.ok(peak < Math.max(dc, 1) * 0.6, `no periodic root banding (peak ${peak.toFixed(1)} vs low-frequency ${dc.toFixed(1)})`);
  const n = randoms.length, mr = randoms.reduce((a, b) => a + b, 0) / n, mx = xs.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vr = 0, vx = 0;
  for (let i = 0; i < n; i += 1) { cov += (randoms[i] - mr) * (xs[i] - mx); vr += (randoms[i] - mr) ** 2; vx += (xs[i] - mx) ** 2; }
  assert.ok(Math.abs(cov / Math.sqrt(vr * vx)) < 0.05, "per-strand variation is independent of position");
  const source = fs.readFileSync(new URL("../src/gnm-player-facial-hair.js", import.meta.url), "utf8");
  assert.ok(!/Math\.random/.test(source), "facial hair never uses Math.random");
  const renderer = fs.readFileSync(new URL("../src/gnm-player-renderer.js", import.meta.url), "utf8");
  assert.ok(!/browCoverage|beardCoverage|uBrowStyle|uBeardStyle/.test(renderer), "no painted brow or beard remains in the shaders");
  console.log("PASS facial hair aperiodicity: no dominant root frequency, uncorrelated per-strand variation, no Math.random, no painted brow or beard");
}

// --- Frame integration, isolation, underlay and pigment ------------------------------
{
  let groomed = createProfile({ seed: 7310, age: 29, presentation: "masculine" });
  for (const [key, value] of Object.entries({ hairVisible: 1, hair: 4, beard: 2, brows: 3, hairColor: 1 })) groomed = setFeature(groomed, key, value);
  const frame = computeGnmPlayerFrame(resources, groomed, { expressionMode: "neutral" });
  assert.equal(frame.groom.beard.style, "beard/short");
  assert.equal(frame.groom.brow.style, "brows/thick");
  assert.equal(frame.groom.beard.lod, "full");
  const thumbnail = computeGnmPlayerFrame(resources, groomed, { expressionMode: "neutral", hairDetail: "reduced" });
  assert.equal(thumbnail.groom.beard.strandCount, frame.groom.beard.tiers.reduced, "thumbnails build only the reduced beard tier");
  assert.equal(thumbnail.groom.brow.strandCount, frame.groom.brow.tiers.reduced, "thumbnails build only the reduced brow tier");
  const ao = gnmPlayerHairAoIndices(frame.groom.beard, 0);
  assert.ok(ao.every((value) => value < staticData.renderCount && staticData.skinVertex[value] === 1), "beard strands read the AO of their root skin vertex");
  const same = (edited, keys, message) => { for (const part of keys) assert.deepEqual(edited.groom[part].vertices, frame.groom[part].vertices, `${message}: ${part} unchanged`); };
  // Hair style, colour and visibility never change the beard or the brows.
  for (const [key, value] of [["hair", 7], ["hairColor", 5], ["hairVisible", 0]]) same(computeGnmPlayerFrame(resources, setFeature(groomed, key, value), { expressionMode: "neutral" }), ["beard", "brow"], key);
  // Unrelated controls never change the grooming.
  for (const [key, value] of [["eyeColor", 3], ["skin", 6], ["freckles", 1], ["scar", 1], ["glasses", 1]]) same(computeGnmPlayerFrame(resources, setFeature(groomed, key, value), { expressionMode: "neutral" }), ["beard", "brow", "hair"], key);
  same(computeGnmPlayerFrame(resources, setKit(groomed, "#aa0000", "#00aa00"), { expressionMode: "neutral" }), ["beard", "brow", "hair"], "kit");
  // The beard changes only the beard; the brow style (and its offset) only the brows.
  const beardEdit = computeGnmPlayerFrame(resources, setFeature(groomed, "beard", 3), { expressionMode: "neutral" });
  same(beardEdit, ["brow", "hair"], "beard");
  assert.deepEqual(beardEdit.renderPositions, frame.renderPositions, "beard: head geometry unchanged");
  for (const value of [6, 7]) {
    const browEdit = computeGnmPlayerFrame(resources, setFeature(groomed, "brows", value), { expressionMode: "neutral" });
    same(browEdit, ["beard", "hair"], `brows ${value}`);
    assert.deepEqual(browEdit.renderPositions, frame.renderPositions, "brows: head geometry unchanged");
    for (let v = 0; v < staticData.renderCount; v += 1) assert.equal(browEdit.facialUnderlay[v * 2], frame.facialUnderlay[v * 2], "brows never change the beard underlay");
  }
  for (let v = 0; v < staticData.renderCount; v += 1) assert.equal(beardEdit.facialUnderlay[v * 2 + 1], frame.facialUnderlay[v * 2 + 1], "the beard never changes the brow underlay");
  // Underlay: never outside its zone; no brow tint anywhere near the nose; nothing for "beard/none".
  const nostrils = [31, 32, 33, 34, 35].map((index) => landmark(templateLandmarks, index));
  for (const style of GNM_PLAYER_BROW_STYLES) {
    const underlay = gnmPlayerFacialHairUnderlay(data, GNM_PLAYER_BEARD_STYLES[0], style);
    for (let v = 0; v < staticData.renderCount; v += 1) {
      assert.equal(underlay[v * 2], 0, "no beard underlay without a beard");
      if (underlay[v * 2 + 1] <= 0) continue;
      const [x, y] = at(staticData.positions, v);
      assert.ok(y > landmark(templateLandmarks, 37)[1] && Math.abs(x) < 0.075, `${style.asset}: brow tint only on the brows`);
      for (const n of nostrils) assert.ok(Math.hypot(x - n[0], y - n[1]) > 0.03, `${style.asset}: no brow tint near the nose`);
    }
  }
  const none = computeGnmPlayerFrame(resources, setFeature(groomed, "beard", 0), { expressionMode: "neutral" });
  assert.equal(none.groom.beard.strandCount, 0);
  assert.deepEqual(none.skinRegions, frame.skinRegions, "the presentation-gated beard shadow does not depend on the beard");
  for (let v = 0; v < staticData.renderCount; v += 1) assert.equal(none.facialUnderlay[v * 2], 0, "beard/none leaves only the skin's own beard shadow");
  // Pigment: beard and brows keep the model's colours as the mean of their strands; dark beards stay rich.
  for (const age of [22, 38, 60]) {
    const appearance = gnmPlayerAppearance(setFeature(createProfile({ seed: 5, age }), "hairColor", 0));
    for (const [part, pigment, grey] of [["beard", "beardPigment", "beardGrey"], ["brow", "browPigment", "browGrey"]]) {
      for (let channel = 0; channel < 3; channel += 1) {
        assert.ok(Math.abs(appearance[pigment][channel] + (appearance.hairGreyColor[channel] - appearance[pigment][channel]) * appearance[grey] - appearance[part][channel]) < 1e-12, `${part}: the grey strand fraction keeps the mean colour`);
      }
    }
    const fibre = gnmPlayerFacialHairFibre(appearance, frame.groom.beard, "beard");
    if (age === 22) assert.ok(fibre.greyFraction === 0 && Math.max(...fibre.pigment) < 0.012, "a young black beard has no grey strands and a rich dark pigment");
    else assert.ok(fibre.greyFraction > 0, "older beards grey");
  }
  assert.deepEqual(Object.keys(GNM_PLAYER_BROW_GROOMS), GNM_PLAYER_BROW_STYLES.map((style) => style.asset), "one groom per brow style");
  assert.deepEqual(Object.keys(GNM_PLAYER_BEARD_GROOMS), GNM_PLAYER_BEARD_STYLES.slice(1).map((style) => style.asset), "one groom per beard style");
  assert.equal(gnmPlayerBeardGroom(GNM_PLAYER_BEARD_STYLES[0]), null);
  assert.ok(GNM_PLAYER_BROW_STYLES.every((style) => gnmPlayerBrowGroom(style).label));
  console.log("PASS facial hair integration: frame build, thumbnail tiers, root AO texels, isolation (hair, unrelated controls, beard vs brows), underlay in its zone and never near the nose, beard/none, grey strand means, rich dark beards");
}
