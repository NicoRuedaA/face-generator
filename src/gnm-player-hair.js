/*
 * Sports Face GNM 3D player scalp hair
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * DOM/WebGL-free strand hair shared by the WebGL2 renderer and the tests.
 *
 * Once per asset, buildGnmPlayerHairScalp() samples the official scalp:
 * stratified, area-weighted root candidates in a fixed shuffled order (any
 * prefix is a spatially uniform subset, which gives the levels of detail),
 * blue-noise guide roots with the three nearest guides of every candidate,
 * and a spherical ray-cast table of the outermost skin surface around the
 * head centre (the collision proxy; skin hidden by the jersey is left out).
 *
 * Per reconstructed frame, buildGnmPlayerHair() grooms one style:
 *
 * 1. head map: the ray-cast table evaluated on the deformed mesh, plus the
 *    style's hair volume over the same cells;
 * 2. guide curves grown from the scalp through a per-style flow field
 *    (parting, crown whorl, combing direction and length by region, fade
 *    gradients): lifted at the root, laid onto the hair volume at a random
 *    layer, kept outside the head, released to gravity below its equator
 *    and ended at the face, the shoulders or the bun;
 * 3. render strands transported from their three guides (a rotation about
 *    the head centre), clumped towards their nearest guide, with per-strand
 *    length, smooth random deviation, curls or waves, flyaways, and finer,
 *    shorter baby hairs in the soft density falloff of the hairline;
 * 4. special structures: plaited cornrows with hanging tails, and a coiled
 *    bun with the scalp hair combed towards it.
 *
 * Strands use the eyelash ribbon format: two vertices per centreline point,
 * the unit tangent, (side, t), (half-width, random, visibility, kind) and a
 * root render vertex for ambient occlusion. Everything is generated in code
 * and deterministic: the same profile always gives the same strands, and
 * per-strand variation follows the seed. Nothing is periodic across the
 * scalp; the only repeating structures are the weave along each plait and
 * the coils of a curl, whose pitch, phase and width vary per braid or clump.
 */

import { gnmPlayerHairThicknessMm, gnmPlayerHairThreshold } from "./gnm-player-model.js";

/** Global hair constants (lengths in metres unless the name says Mm). */
export const GNM_PLAYER_HAIR = Object.freeze({
  version: "strand-hair-v1",
  model: "guide-interpolated-clumped-strands",
  /** Head centre of the collision map and the flow fields (template space). */
  center: Object.freeze([0, 0.29, 0.012]),
  /** Spherical collision map around the x axis: theta around, lambda across. */
  headMap: Object.freeze({ theta: 128, lambda: 64 }),
  /** Skin below this template height is inside the jersey: a collider only within the neck cylinder. */
  hiddenBelow: 0.175,
  /** Neck cylinder (template x/z centre and radius, m) kept as a collider below the collar. */
  neck: Object.freeze({ x: 0, z: -0.005, radius: 0.075, bottom: 0.09 }),
  /** Static root candidates (every style accepts a prefix-ordered subset). */
  candidates: 40000,
  guideSpacingMm: 5.5,
  /** Fraction of the strands in the reduced level of detail (thumbnails, direct fallback). */
  reducedFraction: 0.45,
  /** Minimum clearance of every non-root point above the skin (mm). */
  clearanceMm: 0.3,
  /** Strand kinds (surface.w): scalp hair, flyaway, hairline baby hair, braid, bun wrap. */
  kinds: Object.freeze({ scalp: 0, flyaway: 1, baby: 2, braid: 3, bun: 4 }),
});

const KIND = GNM_PLAYER_HAIR.kinds;
const [CX, CY, CZ] = GNM_PLAYER_HAIR.center;
const MAP_THETA = GNM_PLAYER_HAIR.headMap.theta;
const MAP_LAMBDA = GNM_PLAYER_HAIR.headMap.lambda;
const MAP_CELLS = MAP_THETA * MAP_LAMBDA;
const PI = Math.PI;
const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
/** Official scalp-field ear centre (z, m): front = cos(azimuth about it). */
const EAR_Z = 0.017451;
const CLEARANCE = GNM_PLAYER_HAIR.clearanceMm / 1000;
const MAX_GUIDE_STEPS = 48;

function clamp(value, low, high) { return value < low ? low : value > high ? high : value; }
function smoothstep(edge0, edge1, value) { const t = clamp((value - edge0) / (edge1 - edge0), 0, 1); return t * t * (3 - 2 * t); }
function lerp(a, b, t) { return a + (b - a) * t; }

/** 32-bit integer finalizer (lowbias32); deterministic on every platform. */
function mix32(value) {
  let x = value >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}
/** Uniform [0, 1) from (seed, index, salt); independent per argument. */
function hashUnit(seed, index, salt) {
  return mix32((seed ^ mix32(Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 7, 0x85ebca6b))) >>> 0) / 4294967296;
}
/**
 * Per-item random stream (xorshift32 seeded through mix32): cheap repeated
 * draws in a fixed order, deterministic for (seed, index, salt).
 */
class RandomStream {
  constructor(seed, index, salt) { this.state = mix32(seed ^ mix32(Math.imul(index + 1, 0x9e3779b1) ^ salt)) || 0x9e3779b9; }
  next() {
    let x = this.state;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 4294967296;
  }
}
function stringSalt(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return hash >>> 0;
}

/** atan2 from a minimax polynomial (|error| < 1e-5 rad). */
export function gnmPlayerFastAtan2(y, x) {
  const ax = Math.abs(x), ay = Math.abs(y);
  const high = ax > ay ? ax : ay;
  if (high === 0) return 0;
  const a = (ax > ay ? ay : ax) / high;
  const s = a * a;
  let r = (((((-0.0117212 * s + 0.05265332) * s - 0.11643287) * s + 0.19354346) * s - 0.33262347) * s + 0.99997726) * a;
  if (ay > ax) r = HALF_PI - r;
  if (x < 0) r = PI - r;
  return y < 0 ? -r : r;
}
const atan2 = gnmPlayerFastAtan2;

/** Smooth value noise in [0, 1] from hashed lattice corners (aperiodic). */
function valueNoise(x, y, z, salt) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const corner = (dx, dy, dz) => mix32(Math.imul(ix + dx, 0x8da6b343) ^ Math.imul(iy + dy, 0xd8163841) ^ Math.imul(iz + dz, 0xcb1ab31f) ^ salt) / 4294967296;
  const x00 = lerp(corner(0, 0, 0), corner(1, 0, 0), sx), x10 = lerp(corner(0, 1, 0), corner(1, 1, 0), sx);
  const x01 = lerp(corner(0, 0, 1), corner(1, 0, 1), sx), x11 = lerp(corner(0, 1, 1), corner(1, 1, 1), sx);
  return lerp(lerp(x00, x10, sy), lerp(x01, x11, sy), sz);
}

/** Uniform grid over points for neighbour queries (linked cells, integer keys). */
function createGrid(cell) {
  const min = [-0.16, 0.05, -0.2];
  const size = [Math.ceil(0.32 / cell) + 1, Math.ceil(0.4 / cell) + 1, Math.ceil(0.4 / cell) + 1];
  const head = new Int32Array(size[0] * size[1] * size[2]).fill(-1);
  return {
    cell, head, next: [], item: [],
    index(x, y, z) {
      const i = clamp(Math.floor((x - min[0]) / cell), 0, size[0] - 1), j = clamp(Math.floor((y - min[1]) / cell), 0, size[1] - 1), k = clamp(Math.floor((z - min[2]) / cell), 0, size[2] - 1);
      return [i, j, k];
    },
    key(i, j, k) { return i < 0 || j < 0 || k < 0 || i >= size[0] || j >= size[1] || k >= size[2] ? -1 : (i * size[1] + j) * size[2] + k; },
    insert(value, x, y, z) {
      const [i, j, k] = this.index(x, y, z);
      const key = this.key(i, j, k);
      this.item.push(value);
      this.next.push(this.head[key]);
      this.head[key] = this.item.length - 1;
    },
    /** Calls visit(item) for items in cells within `ring` of the point's cell (only the shell when onlyShell). */
    visit(x, y, z, ring, onlyShell, visit) {
      const [ci, cj, ck] = this.index(x, y, z);
      for (let di = -ring; di <= ring; di += 1) for (let dj = -ring; dj <= ring; dj += 1) for (let dk = -ring; dk <= ring; dk += 1) {
        if (onlyShell && Math.max(Math.abs(di), Math.abs(dj), Math.abs(dk)) !== ring) continue;
        const key = this.key(ci + di, cj + dj, ck + dk);
        if (key < 0) continue;
        for (let entry = this.head[key]; entry >= 0; entry = this.next[entry]) if (visit(this.item[entry])) return;
      }
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Static scalp data                                                        */
/* ------------------------------------------------------------------------ */

/** Lowest hairline threshold of any catalog style (mm on the scalp field). */
function widestThreshold(front) {
  return gnmPlayerHairThreshold({ hairline: -8, back: -54 }, front);
}

/**
 * Static per-asset scalp data. `positions` are template render positions,
 * `skinTriangles`/`closureTriangles` render-vertex triangles (closure: the
 * corneas, so the collision map has no holes at the eye openings), `fields`
 * per-render-vertex official fields and `anchors` the field anchors (mm).
 */
export function buildGnmPlayerHairScalp({ positions, skinTriangles, closureTriangles = new Uint32Array(0), fields, anchors }) {
  const { scalp, front, ear, eyeSocket, mouthSock, lip } = fields;
  const eligible = (vertex) => ear[vertex] < 0.35 && eyeSocket[vertex] < 0.3 && mouthSock[vertex] < 0.3 && lip[vertex] < 0.3 && scalp[vertex] > widestThreshold(front[vertex]) - 7;
  const triangles = [];
  let totalArea = 0;
  for (let item = 0; item < skinTriangles.length; item += 3) {
    const a = skinTriangles[item], b = skinTriangles[item + 1], c = skinTriangles[item + 2];
    if (!eligible(a) || !eligible(b) || !eligible(c)) continue;
    const abx = positions[b * 3] - positions[a * 3], aby = positions[b * 3 + 1] - positions[a * 3 + 1], abz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const acx = positions[c * 3] - positions[a * 3], acy = positions[c * 3 + 1] - positions[a * 3 + 1], acz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const area = 0.5 * Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx);
    if (area <= 0) continue;
    triangles.push(a, b, c, area);
    totalArea += area;
  }
  // Stratified area-weighted candidates: the expected count per triangle,
  // R2 low-discrepancy points inside it, then one fixed global shuffle.
  const target = GNM_PLAYER_HAIR.candidates;
  const tri = [];
  const bary = [];
  let stream = 0x2545f491;
  const next = () => { stream = (stream + 0x6d2b79f5) >>> 0; return mix32(stream) / 4294967296; };
  for (let item = 0; item < triangles.length; item += 4) {
    const count = Math.floor((target * triangles[item + 3]) / totalArea + next());
    const o1 = next(), o2 = next();
    for (let k = 0; k < count; k += 1) {
      let u = (o1 + k * 0.7548776662466927) % 1, v = (o2 + k * 0.5698402909980532) % 1;
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      tri.push(triangles[item], triangles[item + 1], triangles[item + 2]);
      bary.push(1 - u - v, u, v);
    }
  }
  const count = tri.length / 3;
  const order = Uint32Array.from({ length: count }, (_, index) => index);
  for (let index = count - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    const value = order[index]; order[index] = order[swap]; order[swap] = value;
  }
  const candidateTri = new Uint32Array(count * 3);
  const candidateBary = new Float32Array(count * 3);
  const candidatePosition = new Float32Array(count * 3);
  const candidateScalp = new Float32Array(count);
  const candidateFront = new Float32Array(count);
  const candidateNoise = new Float32Array(count);
  const candidateRegions = new Float32Array(count * 7);
  for (let slot = 0; slot < count; slot += 1) {
    const source = order[slot];
    let s = 0, f = 0;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = tri[source * 3 + corner], weight = bary[source * 3 + corner];
      candidateTri[slot * 3 + corner] = vertex;
      candidateBary[slot * 3 + corner] = weight;
      for (let axis = 0; axis < 3; axis += 1) candidatePosition[slot * 3 + axis] += weight * positions[vertex * 3 + axis];
      s += weight * scalp[vertex];
      f += weight * front[vertex];
    }
    candidateScalp[slot] = s;
    candidateFront[slot] = f;
    // Hairline jitter: ~4 mm value noise, fixed per candidate.
    candidateNoise[slot] = valueNoise(candidatePosition[slot * 3] * 260, candidatePosition[slot * 3 + 1] * 260, candidatePosition[slot * 3 + 2] * 260, 0x3c6ef372);
    // Static region weights (template position): hairline blend front/back, sides, top, fringe, back, nape.
    const y = candidatePosition[slot * 3 + 1];
    const w = slot * 7;
    candidateRegions[w] = smoothstep(0.15, 0.85, f);
    candidateRegions[w + 1] = smoothstep(0.05, 0.75, -f);
    candidateRegions[w + 2] = 1 - smoothstep(0.15, 0.85, f);
    candidateRegions[w + 3] = smoothstep(0.345, 0.392, y);
    candidateRegions[w + 4] = smoothstep(0.3, 0.75, f) * smoothstep(0.328, 0.372, y);
    candidateRegions[w + 5] = smoothstep(0.05, 0.65, -f);
    candidateRegions[w + 6] = candidateRegions[w + 5] * (1 - smoothstep(0.235, 0.29, y));
  }
  // Blue-noise guide roots: dart throwing in the shuffled candidate order.
  const spacing = GNM_PLAYER_HAIR.guideSpacingMm / 1000;
  const dartGrid = createGrid(spacing);
  const guides = [];
  const at = (slot, axis) => candidatePosition[slot * 3 + axis];
  for (let slot = 0; slot < count; slot += 1) {
    const x = at(slot, 0), y = at(slot, 1), z = at(slot, 2);
    let blocked = false;
    dartGrid.visit(x, y, z, 1, false, (other) => {
      const ox = at(other, 0) - x, oy = at(other, 1) - y, oz = at(other, 2) - z;
      blocked = ox * ox + oy * oy + oz * oz < spacing * spacing;
      return blocked;
    });
    if (blocked) continue;
    dartGrid.insert(slot, x, y, z);
    guides.push(slot);
  }
  if (guides.length > 65535) throw new Error("GNM player hair has too many guide roots");
  // Three nearest guides of every candidate (inverse-square distance weights).
  const nearGrid = createGrid(spacing * 2);
  guides.forEach((slot, guide) => nearGrid.insert(guide, at(slot, 0), at(slot, 1), at(slot, 2)));
  const nearGuides = new Uint16Array(count * 3);
  const guideWeights = new Float32Array(count * 3);
  const bestDistance = new Float64Array(3);
  const bestGuide = new Int32Array(3);
  for (let slot = 0; slot < count; slot += 1) {
    const x = at(slot, 0), y = at(slot, 1), z = at(slot, 2);
    bestDistance.fill(Infinity);
    bestGuide.fill(-1);
    const consider = (guide) => {
      const g = guides[guide];
      const ox = at(g, 0) - x, oy = at(g, 1) - y, oz = at(g, 2) - z;
      let d = ox * ox + oy * oy + oz * oz;
      let candidate = guide;
      for (let k = 0; k < 3 && candidate >= 0; k += 1) {
        if (d < bestDistance[k]) {
          const nd = bestDistance[k], ng = bestGuide[k];
          bestDistance[k] = d; bestGuide[k] = candidate;
          d = nd; candidate = ng;
        }
      }
      return false;
    };
    for (let ring = 0; ring <= 3 && (ring < 2 || bestGuide[2] < 0); ring += 1) nearGrid.visit(x, y, z, ring, true, consider);
    let total = 0;
    for (let k = 0; k < 3; k += 1) {
      const found = bestGuide[k] >= 0;
      nearGuides[slot * 3 + k] = found ? bestGuide[k] : Math.max(bestGuide[0], 0);
      guideWeights[slot * 3 + k] = found ? 1 / (bestDistance[k] + 2.25e-6) : 0;
      total += guideWeights[slot * 3 + k];
    }
    for (let k = 0; k < 3; k += 1) guideWeights[slot * 3 + k] = total > 0 ? guideWeights[slot * 3 + k] / total : (k === 0 ? 1 : 0);
  }
  // Colliders: skin above the collar and the neck cylinder inside the
  // jersey; the shoulders under the jersey are left to the jersey collider.
  const visible = [];
  const neck = GNM_PLAYER_HAIR.neck;
  const inNeck = (vertex) => Math.hypot(positions[vertex * 3] - neck.x, positions[vertex * 3 + 2] - neck.z) < neck.radius && positions[vertex * 3 + 1] > neck.bottom;
  for (let item = 0; item < skinTriangles.length; item += 3) {
    const a = skinTriangles[item], b = skinTriangles[item + 1], c = skinTriangles[item + 2];
    if (Math.max(positions[a * 3 + 1], positions[b * 3 + 1], positions[c * 3 + 1]) >= GNM_PLAYER_HAIR.hiddenBelow || (inNeck(a) && inNeck(b) && inNeck(c))) visible.push(a, b, c);
  }
  const map = buildHeadMapTable(positions, [visible, closureTriangles]);
  // Shoulder skin around the crew neck: where it shows above the collar
  // plane, hanging hair rests on it like on the jersey.
  const shoulders = [];
  const shoulder = (vertex) => positions[vertex * 3 + 1] > 0.1 && positions[vertex * 3 + 1] < 0.21 && Math.hypot(positions[vertex * 3] - neck.x, positions[vertex * 3 + 2] - neck.z) > 0.045;
  for (let item = 0; item < skinTriangles.length; item += 3) {
    const a = skinTriangles[item], b = skinTriangles[item + 1], c = skinTriangles[item + 2];
    if (shoulder(a) && shoulder(b) && shoulder(c)) shoulders.push(a, b, c);
  }
  // Skin vertices near the neck axis (the per-frame neck collider).
  const skinVertex = new Uint8Array(positions.length / 3);
  for (const vertex of skinTriangles) {
    const dx = positions[vertex * 3] - neck.x, dz = positions[vertex * 3 + 2] - neck.z;
    if (dx * dx + dz * dz < 0.1 * 0.1) skinVertex[vertex] = 1;
  }
  // Ears can swing far from their template direction (projecting ears), so
  // they are also re-rasterized on every frame's deformed mesh.
  const earTriangles = [];
  for (let item = 0; item < skinTriangles.length; item += 3) {
    const a = skinTriangles[item], b = skinTriangles[item + 1], c = skinTriangles[item + 2];
    if (ear[a] > 0.3 || ear[b] > 0.3 || ear[c] > 0.3) earTriangles.push(a, b, c);
  }
  // Map cells on or next to the ears get extra clearance: hair drapes over them.
  const mapEar = new Uint8Array(MAP_CELLS);
  for (let cell = 0; cell < MAP_CELLS; cell += 1) {
    if (map.tri[cell * 3] < 0) continue;
    let value = 0;
    for (let corner = 0; corner < 3; corner += 1) value += map.bary[cell * 3 + corner] * ear[map.tri[cell * 3 + corner]];
    if (value > 0.3) mapEar[cell] = 1;
  }
  return {
    version: GNM_PLAYER_HAIR.version,
    candidateCount: count,
    candidateTri, candidateBary, candidatePosition, candidateScalp, candidateFront, candidateNoise, candidateRegions,
    guideCandidates: Uint32Array.from(guides),
    nearGuides, guideWeights,
    mapTri: map.tri, mapBary: map.bary, mapDirection: map.direction, mapEar, earTriangles: Uint32Array.from(earTriangles), skinVertex, shoulderTriangles: Uint32Array.from(shoulders),
    anchors: Object.freeze({ foreheadTop: anchors.foreheadTopMm / 1000, earTop: anchors.earTopMm / 1000 }),
    scalpArea: totalArea,
  };
}

/** Map coordinates (u around theta, v across lambda) and radius of a point, about the x axis through the head centre. */
function sphericalCell(x, y, z) {
  const dx = x - CX, dy = y - CY, dz = z - CZ;
  const theta = Math.atan2(dz, dy);
  const lambda = Math.atan2(dx, Math.hypot(dy, dz));
  return [(theta + PI) * (MAP_THETA / TAU), (lambda + HALF_PI) * (MAP_LAMBDA / PI), Math.hypot(dx, dy, dz)];
}

/**
 * Rasterize the skin (and closure) triangles into the spherical map, keeping
 * the outermost hit per cell as a (triangle, barycentric) pair so every
 * frame re-evaluates the radius on its own deformed mesh.
 */
function buildHeadMapTable(positions, triangleSets) {
  const tri = new Int32Array(MAP_CELLS * 3).fill(-1);
  const bary = new Float32Array(MAP_CELLS * 3);
  const radius = new Float32Array(MAP_CELLS);
  const cells = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const weights = [0, 0, 0];
  for (const triangles of triangleSets) {
    for (let item = 0; item < triangles.length; item += 3) {
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = triangles[item + corner];
        cells[corner] = sphericalCell(positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]);
      }
      const uMax = Math.max(cells[0][0], cells[1][0], cells[2][0]), uMin = Math.min(cells[0][0], cells[1][0], cells[2][0]);
      if (uMax - uMin > MAP_THETA / 2) for (const cell of cells) if (cell[0] < MAP_THETA / 2) cell[0] += MAP_THETA;
      const [[u0, v0], [u1, v1], [u2, v2]] = cells;
      const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
      if (Math.abs(det) < 1e-12) continue;
      const iMin = Math.floor(Math.min(u0, u1, u2) - 0.5), iMax = Math.ceil(Math.max(u0, u1, u2) - 0.5);
      const jMin = Math.max(0, Math.floor(Math.min(v0, v1, v2) - 0.5)), jMax = Math.min(MAP_LAMBDA - 1, Math.ceil(Math.max(v0, v1, v2) - 0.5));
      for (let i = iMin; i <= iMax; i += 1) {
        for (let j = jMin; j <= jMax; j += 1) {
          const cu = i + 0.5, cv = j + 0.5;
          weights[1] = ((cu - u0) * (v2 - v0) - (u2 - u0) * (cv - v0)) / det;
          weights[2] = ((u1 - u0) * (cv - v0) - (cu - u0) * (v1 - v0)) / det;
          weights[0] = 1 - weights[1] - weights[2];
          if (weights[0] < -1e-6 || weights[1] < -1e-6 || weights[2] < -1e-6) continue;
          let px = 0, py = 0, pz = 0;
          for (let corner = 0; corner < 3; corner += 1) {
            const vertex = triangles[item + corner];
            px += weights[corner] * positions[vertex * 3];
            py += weights[corner] * positions[vertex * 3 + 1];
            pz += weights[corner] * positions[vertex * 3 + 2];
          }
          const r = Math.hypot(px - CX, py - CY, pz - CZ);
          const cell = (((i % MAP_THETA) + MAP_THETA) % MAP_THETA) + j * MAP_THETA;
          if (r <= radius[cell]) continue;
          radius[cell] = r;
          for (let corner = 0; corner < 3; corner += 1) { tri[cell * 3 + corner] = triangles[item + corner]; bary[cell * 3 + corner] = weights[corner]; }
        }
      }
    }
  }
  // Cells the visible mesh never covers (below the neck) borrow a neighbour's surface point.
  for (let pass = 0; pass < 24; pass += 1) {
    const filled = Int32Array.from(tri);
    const filledBary = Float32Array.from(bary);
    let missing = 0;
    for (let j = 0; j < MAP_LAMBDA; j += 1) for (let i = 0; i < MAP_THETA; i += 1) {
      const cell = i + j * MAP_THETA;
      if (tri[cell * 3] >= 0) continue;
      missing += 1;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const jj = j + dj;
        if (jj < 0 || jj >= MAP_LAMBDA) continue;
        const other = ((i + di + MAP_THETA) % MAP_THETA) + jj * MAP_THETA;
        if (tri[other * 3] < 0) continue;
        for (let k = 0; k < 3; k += 1) { filled[cell * 3 + k] = tri[other * 3 + k]; filledBary[cell * 3 + k] = bary[other * 3 + k]; }
        break;
      }
    }
    tri.set(filled);
    bary.set(filledBary);
    if (missing === 0) break;
  }
  const direction = new Float32Array(MAP_CELLS * 3);
  for (let j = 0; j < MAP_LAMBDA; j += 1) for (let i = 0; i < MAP_THETA; i += 1) {
    const theta = ((i + 0.5) / MAP_THETA) * TAU - PI, lambda = ((j + 0.5) / MAP_LAMBDA) * PI - HALF_PI;
    const cell = i + j * MAP_THETA;
    direction[cell * 3] = Math.sin(lambda);
    direction[cell * 3 + 1] = Math.cos(theta) * Math.cos(lambda);
    direction[cell * 3 + 2] = Math.sin(theta) * Math.cos(lambda);
  }
  return { tri, bary, direction };
}

/** Rasterize triangles of `positions` into map radii (keeping the outermost radius per cell). */
function rasterizeRadii(radii, positions, triangles) {
  const u = [0, 0, 0], v = [0, 0, 0], r = [0, 0, 0];
  for (let item = 0; item < triangles.length; item += 3) {
    let uMin = Infinity, uMax = -Infinity;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = triangles[item + corner];
      const dx = positions[vertex * 3] - CX, dy = positions[vertex * 3 + 1] - CY, dz = positions[vertex * 3 + 2] - CZ;
      const ryz = Math.sqrt(dy * dy + dz * dz);
      u[corner] = (atan2(dz, dy) + PI) * (MAP_THETA / TAU);
      v[corner] = (atan2(dx, ryz) + HALF_PI) * (MAP_LAMBDA / PI);
      r[corner] = Math.sqrt(dx * dx + ryz * ryz);
      uMin = Math.min(uMin, u[corner]); uMax = Math.max(uMax, u[corner]);
    }
    if (uMax - uMin > MAP_THETA / 2) for (let corner = 0; corner < 3; corner += 1) if (u[corner] < MAP_THETA / 2) u[corner] += MAP_THETA;
    const det = (u[1] - u[0]) * (v[2] - v[0]) - (u[2] - u[0]) * (v[1] - v[0]);
    if (Math.abs(det) < 1e-12) continue;
    const iMin = Math.floor(Math.min(u[0], u[1], u[2]) - 0.5), iMax = Math.ceil(Math.max(u[0], u[1], u[2]) - 0.5);
    const jMin = Math.max(0, Math.floor(Math.min(v[0], v[1], v[2]) - 0.5)), jMax = Math.min(MAP_LAMBDA - 1, Math.ceil(Math.max(v[0], v[1], v[2]) - 0.5));
    for (let i = iMin; i <= iMax; i += 1) {
      for (let j = jMin; j <= jMax; j += 1) {
        const cu = i + 0.5, cv = j + 0.5;
        const w1 = ((cu - u[0]) * (v[2] - v[0]) - (u[2] - u[0]) * (cv - v[0])) / det;
        const w2 = ((u[1] - u[0]) * (cv - v[0]) - (cu - u[0]) * (v[1] - v[0])) / det;
        const w0 = 1 - w1 - w2;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const radius = w0 * r[0] + w1 * r[1] + w2 * r[2];
        const cell = (((i % MAP_THETA) + MAP_THETA) % MAP_THETA) + j * MAP_THETA;
        if (radius > radii[cell]) radii[cell] = radius;
      }
    }
  }
}

/**
 * Per-frame surface radius (m from the head centre) of every map cell on the
 * deformed mesh; 0 when uncovered. With `normals`, each cell's template
 * surface point is re-projected along the cell's own ray through its
 * tangent plane, which corrects the drift of strongly deformed identities.
 */
export function computeGnmPlayerHeadMap(scalp, positions, normals = null) {
  const radii = new Float32Array(MAP_CELLS);
  const { mapTri, mapBary, mapDirection } = scalp;
  for (let cell = 0; cell < MAP_CELLS; cell += 1) {
    const a = mapTri[cell * 3];
    if (a < 0) continue;
    const b = mapTri[cell * 3 + 1], c = mapTri[cell * 3 + 2];
    const wa = mapBary[cell * 3], wb = mapBary[cell * 3 + 1], wc = mapBary[cell * 3 + 2];
    const x = wa * positions[a * 3] + wb * positions[b * 3] + wc * positions[c * 3] - CX;
    const y = wa * positions[a * 3 + 1] + wb * positions[b * 3 + 1] + wc * positions[c * 3 + 1] - CY;
    const z = wa * positions[a * 3 + 2] + wb * positions[b * 3 + 2] + wc * positions[c * 3 + 2] - CZ;
    const radius = Math.sqrt(x * x + y * y + z * z);
    radii[cell] = radius;
    if (!normals) continue;
    const nx = wa * normals[a * 3] + wb * normals[b * 3] + wc * normals[c * 3];
    const ny = wa * normals[a * 3 + 1] + wb * normals[b * 3 + 1] + wc * normals[c * 3 + 1];
    const nz = wa * normals[a * 3 + 2] + wb * normals[b * 3 + 2] + wc * normals[c * 3 + 2];
    const dx = mapDirection[cell * 3], dy = mapDirection[cell * 3 + 1], dz = mapDirection[cell * 3 + 2];
    const facing = (dx * nx + dy * ny + dz * nz) / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
    if (facing < 0.35) continue;
    const along = (x * nx + y * ny + z * nz) / (dx * nx + dy * ny + dz * nz);
    // First-order correction only: never move a cell by more than a few millimetres.
    if (along > 0 && Math.abs(along - radius) < 0.006) radii[cell] = along;
  }
  if (scalp.earTriangles) rasterizeRadii(radii, positions, scalp.earTriangles);
  return radii;
}

/**
 * Bilinear lookup of the head map towards (dx, dy, dz) from the head centre:
 * returns the surface radius and stores the style volume (m) in lookup[0].
 * `map.reach` (0..1) blends from the exact radius (at a strand's root, so
 * short hair stays on the skin) to the conservative dilated one.
 */
function headLookup(map, dx, dy, dz) {
  const ryz = Math.sqrt(dy * dy + dz * dz);
  const u = (atan2(dz, dy) + PI) * (MAP_THETA / TAU) - 0.5;
  const v = clamp((atan2(dx, ryz) + HALF_PI) * (MAP_LAMBDA / PI) - 0.5, 0, MAP_LAMBDA - 1.000001);
  const i = Math.floor(u), j = Math.floor(v);
  const fu = u - i, fv = v - j;
  const i0 = ((i % MAP_THETA) + MAP_THETA) % MAP_THETA, i1 = (i0 + 1) % MAP_THETA;
  const c00 = i0 + j * MAP_THETA, c10 = i1 + j * MAP_THETA, c01 = c00 + MAP_THETA, c11 = c10 + MAP_THETA;
  const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
  const volume = map.volume;
  if (volume) map.lookup[0] = volume[c00] * w00 + volume[c10] * w10 + volume[c01] * w01 + volume[c11] * w11;
  const radii = map.radii;
  const dilated = radii[c00] * w00 + radii[c10] * w10 + radii[c01] * w01 + radii[c11] * w11;
  const raw = map.raw;
  if (!raw || !(map.reach < 1)) return dilated;
  const exact = raw[c00] * w00 + raw[c10] * w10 + raw[c01] * w01 + raw[c11] * w11;
  return exact + (dilated - exact) * map.reach;
}

/** True when the ray from the head centre along (dx, dy, dz) meets an ear cell of the map. */
function overEar(mapEar, dx, dy, dz) {
  const i = Math.floor((atan2(dz, dy) + PI) * (MAP_THETA / TAU)) % MAP_THETA;
  const j = Math.floor(clamp((atan2(dx, Math.sqrt(dy * dy + dz * dz)) + HALF_PI) * (MAP_LAMBDA / PI), 0, MAP_LAMBDA - 1));
  return mapEar[i + j * MAP_THETA] === 1;
}

/** Height (m) of a world point above the head surface along the ray from the head centre. */
export function gnmPlayerHeadHeight(radii, x, y, z) {
  const dx = x - CX, dy = y - CY, dz = z - CZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - headLookup({ radii, volume: null }, dx, dy, dz);
}

/** Push a point out along the ray from the head centre so it is at least `clearance` above the surface. */
function keepOutside(map, xyz, offset, clearance) {
  const ox = xyz[offset] - CX, oy = xyz[offset + 1] - CY, oz = xyz[offset + 2] - CZ;
  const r = Math.sqrt(ox * ox + oy * oy + oz * oz);
  const needed = headLookup(map, ox, oy, oz) + clearance;
  if (r >= needed || r <= 0) return;
  const scale = needed / r;
  xyz[offset] = CX + ox * scale; xyz[offset + 1] = CY + oy * scale; xyz[offset + 2] = CZ + oz * scale;
}

/* ------------------------------------------------------------------------ */
/* Grooms                                                                    */
/* ------------------------------------------------------------------------ */

/*
 * Per-style grooming. `length` is mm by region (top, fringe, sides, back,
 * nape); `comb` names the flow field; `lift` the root angle (degrees) above
 * the scalp on top and at the sides; `follow` how tightly strands follow
 * the flow; `gravity` how much they fall; `clump` the pull towards the
 * nearest guide at the tips; `frizz` the smooth random deviation (mm at the
 * tip); `curl`/`wave` the radius or amplitude and the pitch (mm); `width`
 * the root half-width (mm); `bumps` per-clump volume variation; `scalpTint`
 * the painted root density under the strands (0..1); `hang` the extra
 * ribbon width (fraction) where strands hang below the scalp or stand off
 * it, where no painted scalp shows between them (coverage-preserving width);
 * `hairlineSoftness` widens the hairline's density falloff (roots and paint).
 */
const BASE_GROOM = Object.freeze({
  count: 9000, segments: 6, length: Object.freeze([40, 40, 30, 30, 20]), jitter: 0.22, lift: Object.freeze([25, 12]), comb: "growth", follow: 0.45,
  gravity: 0, clump: 0.3, clumpPower: 1.6, frizz: 0.6, flyaway: 0.012, width: 0.055, layer: Object.freeze([0.3, 1]), fadeFloor: 0.08,
  curl: null, wave: null, part: null, scalpTint: 0.92, baby: 0.35, bumps: 0.12, volumeScale: 1, tangent: true, crownLift: 30, hang: 0, hairlineSoftness: 1,
});

/** Groom per catalog asset; the session side-part prototype shares the durable slot-3 groom. */
export const GNM_PLAYER_HAIR_GROOMS = Object.freeze({
  "hair/short-01": Object.freeze({ label: "buzz cut", count: 12600, segments: 2, length: [3.2, 3.0, 2.4, 2.4, 2], jitter: 0.3, lift: [32, 26], comb: "growth", follow: 0.7, clump: 0, frizz: 0.05, flyaway: 0, width: 0.04, layer: [0.8, 1], scalpTint: 0.55, baby: 0.2, hairlineSoftness: 2.4 }),
  "hair/short-02": Object.freeze({ label: "textured crop with fade", count: 12600, segments: 5, length: [44, 38, 13, 11, 6], jitter: 0.28, lift: [42, 14], comb: "forward", follow: 0.4, clump: 0.45, clumpPower: 1.3, frizz: 1.6, flyaway: 0.02, width: 0.05, scalpTint: 0.9, fadeFloor: 0.08, bumps: 0.3 }),
  "hair/short-03": Object.freeze({ label: "caesar crop", count: 11700, segments: 4, length: [22, 20, 15, 14, 10], jitter: 0.2, lift: [24, 16], comb: "forward", follow: 0.6, clump: 0.25, frizz: 0.5, flyaway: 0.008, width: 0.05, scalpTint: 0.9, fadeFloor: 0.25 }),
  "hair/short-04": Object.freeze({ label: "swept side part with faded sides", count: 9900, segments: 8, length: [82, 88, 11, 10, 5], jitter: 0.18, lift: [46, 14], comb: "side-part", follow: 0.42, clump: 0.42, frizz: 1.0, flyaway: 0.012, width: 0.055, part: "side", scalpTint: 0.9, fadeFloor: 0.07, volumeScale: 0.8 }),
  "hair/medium-01": Object.freeze({ label: "tousled medium", count: 8100, segments: 10, length: [90, 78, 62, 62, 26], jitter: 0.3, lift: [30, 14], comb: "tousled", follow: 0.38, gravity: 0.55, clump: 0.36, frizz: 2.2, flyaway: 0.015, width: 0.065, bumps: 0.2, volumeScale: 0.75, hang: 1.15 }),
  "hair/medium-02": Object.freeze({ label: "centre-parted bob", count: 7600, segments: 11, length: [135, 128, 112, 104, 80], jitter: 0.12, lift: [18, 8], comb: "center-part", follow: 0.4, gravity: 0.7, clump: 0.16, frizz: 1.0, flyaway: 0.012, width: 0.07, part: "center", volumeScale: 0.42, hang: 1.15 }),
  "hair/curly-01": Object.freeze({ label: "tight curls", count: 5400, segments: 17, length: [64, 56, 50, 54, 36], jitter: 0.25, lift: [62, 50], comb: "outward", follow: 0.3, gravity: 0.05, clump: 0.55, clumpPower: 1.1, frizz: 1.8, flyaway: 0.025, width: 0.06, curl: [2.4, 6.5], layer: [0.25, 1], bumps: 0.25, volumeScale: 0.85, tangent: false, hang: 1.3 }),
  "hair/long-01": Object.freeze({ label: "long straight", count: 7200, segments: 13, length: [210, 195, 205, 215, 180], jitter: 0.1, lift: [16, 6], comb: "long", follow: 0.45, gravity: 0.8, clump: 0.24, frizz: 2.0, flyaway: 0.012, width: 0.072, part: "natural", volumeScale: 0.4, hang: 1.15 }),
  "hair/long-02": Object.freeze({ label: "long wavy with side part", count: 7200, segments: 14, length: [300, 280, 295, 305, 250], jitter: 0.1, lift: [20, 6], comb: "long-side", follow: 0.42, gravity: 0.8, clump: 0.3, frizz: 2.4, flyaway: 0.014, width: 0.072, wave: [7, 105], part: "side", volumeScale: 0.5, hang: 1.15 }),
  "hair/fade-01": Object.freeze({ label: "high skin fade with quiff", count: 9900, segments: 6, length: [58, 66, 7, 6, 3], jitter: 0.2, lift: [58, 14], comb: "quiff", follow: 0.45, clump: 0.4, frizz: 1.0, flyaway: 0.015, width: 0.052, scalpTint: 0.88, fadeFloor: 0.03 }),
  "hair/braids-01": Object.freeze({ label: "cornrows with hanging braids", count: 4700, segments: 4, length: [20, 18, 18, 18, 14], jitter: 0.25, lift: [8, 6], comb: "braid", follow: 0.8, clump: 0.2, frizz: 0.25, flyaway: 0.006, width: 0.05, scalpTint: 0.5, baby: 0.25, braids: Object.freeze({ rows: 10, periodMm: 9, halfWidthMm: 4.2, fibers: 8, tailMm: 125, bandMm: 4.2 }) }),
  "hair/bun-01": Object.freeze({ label: "slicked back into a bun", count: 6300, segments: 9, length: [150, 165, 120, 80, 70], jitter: 0.05, lift: [10, 6], comb: "bun", follow: 0.75, clump: 0.3, frizz: 0.5, flyaway: 0.01, width: 0.05, layer: [0.35, 1], scalpTint: 0.85, bun: Object.freeze({ strands: 1200, turns: 2.2 }) }),
});

/** Resolved groom of a style: the catalog groom of its asset, else of its pattern. */
export function gnmPlayerHairGroom(style) {
  if (!style) return null;
  const byPattern = { "side-part": "hair/short-04", "center-part": "hair/medium-02", curly: "hair/curly-01", braids: "hair/braids-01", bun: "hair/bun-01" };
  const groom = GNM_PLAYER_HAIR_GROOMS[style.asset] ?? GNM_PLAYER_HAIR_GROOMS[byPattern[style.pattern]] ?? GNM_PLAYER_HAIR_GROOMS["hair/short-03"];
  return Object.freeze({ ...BASE_GROOM, ...groom, asset: style.asset });
}

/* ------------------------------------------------------------------------ */
/* Style context and fields                                                  */
/* ------------------------------------------------------------------------ */

function frontAt(x, z) {
  const dz = z - EAR_Z;
  const length = Math.sqrt(x * x + dz * dz);
  return length > 1e-9 ? dz / length : 0;
}

/** Hairline curve of the offline builder (azimuth, m): scalp field = (y - curve) in mm. */
function hairlineKnots(anchors) {
  const f = anchors.foreheadTop, e = anchors.earTop;
  return [[0, f + 0.004], [0.55, f - 0.002], [0.95, f - 0.02], [1.25, e - 0.01], [1.55, e + 0.006], [1.95, e + 0.004], [2.35, e - 0.03], [PI, e - 0.06]];
}

/** Approximate official scalp field (mm) of an arbitrary point: its height above the hairline curve. */
function scalpFieldAt(knots, x, y, z) {
  const azimuth = Math.abs(atan2(x, z - EAR_Z));
  for (let k = 1; k < knots.length; k += 1) {
    if (azimuth <= knots[k][0]) return (y - lerp(knots[k - 1][1], knots[k][1], (azimuth - knots[k - 1][0]) / (knots[k][0] - knots[k - 1][0]))) * 1000;
  }
  return (y - knots[knots.length - 1][1]) * 1000;
}

/** Style context shared by the guide and strand passes. */
function styleContext(style, groom, scalp, seed, options) {
  const salt = stringSalt(style.asset ?? style.pattern ?? "hair");
  const jitter = (index) => hashUnit(seed, index, salt ^ 0x51ed27);
  return {
    style, groom, scalp, seed, salt,
    // Seed-stable crown whorl and parting offsets (a few millimetres).
    whorl: [0.012 + (jitter(1) - 0.5) * 0.012, 0.392 + (jitter(2) - 0.5) * 0.008, -0.036 + (jitter(3) - 0.5) * 0.012],
    partShift: (jitter(4) - 0.5) * 0.004,
    bun: options.bun ?? null,
    browTop: options.browTop ?? 0.335,
    jersey: groom.gravity > 0 ? jerseyField(options.bust ?? null, options.positions, scalp.shoulderTriangles) : null,
    neck: groom.gravity > 0 && options.skinVertex ? neckField(options.positions, options.skinVertex) : null,
    knots: hairlineKnots(scalp.anchors),
    rows: groom.braids ? braidRows(groom, seed, salt) : null,
    comb: new Float64Array(3),
    point: new Float64Array(3),
  };
}

/**
 * Per-frame collision map: the surface radii dilated by one cell (a 3x3
 * maximum, 3 mm more around the ears, plus 30% of the local spread up to 3 mm, so
 * strands drape over the ears, never dip into concave regions and clear
 * grazing cheeks), plus the style's outer volume (m) over the same cells.
 */
function styleHeadMap(context, radii) {
  const { mapDirection: direction, mapEar } = context.scalp;
  const volume = new Float32Array(MAP_CELLS);
  const dilated = new Float32Array(MAP_CELLS);
  for (let j = 0; j < MAP_LAMBDA; j += 1) {
    for (let i = 0; i < MAP_THETA; i += 1) {
      let high = 0, low = Infinity;
      for (let dj = -1; dj <= 1; dj += 1) {
        const jj = j + dj;
        if (jj < 0 || jj >= MAP_LAMBDA) continue;
        for (let di = -1; di <= 1; di += 1) {
          const other = ((i + di + MAP_THETA) % MAP_THETA) + jj * MAP_THETA;
          // One-cell maximum; ears (thin folds) add 3 mm of clearance.
          high = Math.max(high, radii[other] + (mapEar[other] ? 0.003 : 0));
          low = Math.min(low, radii[other]);
        }
      }
      // Where the surface is seen at a grazing angle from the head centre the
      // radius varies fast between cells and linear interpolation undershoots
      // a convex profile: add clearance in proportion to the local spread.
      dilated[i + j * MAP_THETA] = high + (low < Infinity ? 0.3 * Math.min(high - low, 0.01) : 0);
    }
  }
  if (context.groom.hang > 0) earSkirt(dilated, mapEar);
  for (let cell = 0; cell < MAP_CELLS; cell += 1) {
    const r = radii[cell];
    const x = CX + direction[cell * 3] * r, y = CY + direction[cell * 3 + 1] * r, z = CZ + direction[cell * 3 + 2] * r;
    volume[cell] = gnmPlayerHairThicknessMm(context.style, scalpFieldAt(context.knots, x, y, z), frontAt(x, z)) * context.groom.volumeScale / 1000;
  }
  return { radii: dilated, raw: radii, volume, lookup: new Float64Array(1), reach: 1 };
}

/**
 * Styles that hang over the ears climb onto them along a cone around the
 * ears (rising 0.6 m per m) instead of kinking outwards at the rim, which
 * left a shelf of strands standing out beside the head. The cone is a
 * chamfer max-plus sweep over the map (two passes each way; theta wraps).
 */
const EAR_SKIRT = new Float32Array(MAP_CELLS);
const EAR_SKIRT_ALONG = new Float32Array(MAP_LAMBDA);
function earSkirt(radii, mapEar) {
  const slope = 0.6, radius = 0.09, step = TAU / MAP_THETA;
  const cone = EAR_SKIRT, along = EAR_SKIRT_ALONG;
  const across = slope * radius * step;
  for (let j = 0; j < MAP_LAMBDA; j += 1) along[j] = across * Math.max(Math.cos(((j + 0.5) / MAP_LAMBDA) * PI - HALF_PI), 0.05);
  for (let cell = 0; cell < MAP_CELLS; cell += 1) cone[cell] = mapEar[cell] ? radii[cell] : -1;
  for (let pass = 0; pass < 2; pass += 1) {
    for (let j = 0; j < MAP_LAMBDA; j += 1) {
      const row = j * MAP_THETA, previous = row - MAP_THETA;
      const diagonal = Math.sqrt(along[j] * along[j] + across * across);
      for (let i = 0; i < MAP_THETA; i += 1) {
        const left = i > 0 ? i - 1 : MAP_THETA - 1, right = i < MAP_THETA - 1 ? i + 1 : 0;
        let value = Math.max(cone[row + i], cone[row + left] - along[j]);
        if (j > 0) value = Math.max(value, cone[previous + i] - across, cone[previous + left] - diagonal, cone[previous + right] - diagonal);
        cone[row + i] = value;
      }
    }
    for (let j = MAP_LAMBDA - 1; j >= 0; j -= 1) {
      const row = j * MAP_THETA, next = row + MAP_THETA;
      const diagonal = Math.sqrt(along[j] * along[j] + across * across);
      for (let i = MAP_THETA - 1; i >= 0; i -= 1) {
        const left = i > 0 ? i - 1 : MAP_THETA - 1, right = i < MAP_THETA - 1 ? i + 1 : 0;
        let value = Math.max(cone[row + i], cone[row + right] - along[j]);
        if (j < MAP_LAMBDA - 1) value = Math.max(value, cone[next + i] - across, cone[next + left] - diagonal, cone[next + right] - diagonal);
        cone[row + i] = value;
      }
    }
  }
  for (let cell = 0; cell < MAP_CELLS; cell += 1) if (cone[cell] > radii[cell]) radii[cell] = cone[cell];
}

/**
 * Height field of the jersey's top surface (m) over x/z from the bust mesh,
 * with the neck opening capped and the shoulder skin that shows above the
 * collar plane included: hanging hair rests on the shoulders and slides off.
 */
function jerseyField(bust, positions, shoulderTriangles) {
  if (!bust) return null;
  const cell = 0.005, x0 = -0.3, z0 = -0.24, nx = 121, nz = 97;
  const height = new Float32Array(nx * nz).fill(-1);
  const { vertices, indices } = bust;
  const ring = bust.collarVertexCount ?? 0;
  if (ring > 2) {
    let rx = 0, rz = 0;
    for (let k = 0; k < ring; k += 1) { rx += vertices[k * 3] / ring; rz += vertices[k * 3 + 2] / ring; }
    for (let i = 0; i < nx; i += 1) for (let k = 0; k < nz; k += 1) {
      const x = x0 + i * cell, z = z0 + k * cell;
      const radial = Math.sqrt((x - rx) * (x - rx) + (z - rz) * (z - rz));
      if (radial > 0.09) continue;
      const angle = atan2(x - rx, z - rz);
      const vertex = ((Math.round(((angle + PI) / TAU) * ring) % ring) + ring) % ring;
      const ex = vertices[vertex * 3] - rx, ez = vertices[vertex * 3 + 2] - rz;
      const limit = Math.sqrt(ex * ex + ez * ez);
      // A shallow dome over the opening: resting hair slides outwards, never under the collar.
      if (radial <= limit) height[i * nz + k] = vertices[vertex * 3 + 1] + 0.012 * (1 - radial / limit);
    }
  }
  rasterizeHeights(height, vertices, indices, x0, z0, cell, nx, nz);
  if (positions && shoulderTriangles && bust.collarPlane) {
    const [collarHeight, collarZ] = bust.collarPlane;
    const visible = [];
    const shown = (vertex) => positions[vertex * 3 + 1] + 0.12 * (positions[vertex * 3 + 2] - collarZ) >= collarHeight - 0.001;
    for (let item = 0; item < shoulderTriangles.length; item += 3) {
      const a = shoulderTriangles[item], b = shoulderTriangles[item + 1], c = shoulderTriangles[item + 2];
      if (shown(a) || shown(b) || shown(c)) visible.push(a, b, c);
    }
    // Only the skin that faces up: the steep neck and jaw would lift hair
    // passing beside the neck up to the jaw line.
    rasterizeHeights(height, positions, visible, x0, z0, cell, nx, nz, 0.5);
  }
  return { cell, x0, z0, nx, nz, height };
}

/**
 * Rasterize triangles into a top-down height field (maximum y per cell, a
 * small inflation against gaps), skipping triangles whose unit normal has
 * |y| below `minUp`.
 */
function rasterizeHeights(height, vertices, indices, x0, z0, cell, nx, nz, minUp = 0) {
  for (let item = 0; item < indices.length; item += 3) {
    const a = indices[item] * 3, b = indices[item + 1] * 3, c = indices[item + 2] * 3;
    if (minUp > 0) {
      const ux = vertices[b] - vertices[a], uy = vertices[b + 1] - vertices[a + 1], uz = vertices[b + 2] - vertices[a + 2];
      const vx = vertices[c] - vertices[a], vy = vertices[c + 1] - vertices[a + 1], vz = vertices[c + 2] - vertices[a + 2];
      const ny = uz * vx - ux * vz, nx_ = uy * vz - uz * vy, nz_ = ux * vy - uy * vx;
      if (Math.abs(ny) < minUp * Math.sqrt(nx_ * nx_ + ny * ny + nz_ * nz_)) continue;
    }
    const ax = (vertices[a] - x0) / cell, az = (vertices[a + 2] - z0) / cell;
    const bx = (vertices[b] - x0) / cell, bz = (vertices[b + 2] - z0) / cell;
    const cx = (vertices[c] - x0) / cell, cz = (vertices[c + 2] - z0) / cell;
    const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    if (Math.abs(det) < 1e-9) continue;
    const iMin = Math.max(0, Math.floor(Math.min(ax, bx, cx))), iMax = Math.min(nx - 1, Math.ceil(Math.max(ax, bx, cx)));
    const kMin = Math.max(0, Math.floor(Math.min(az, bz, cz))), kMax = Math.min(nz - 1, Math.ceil(Math.max(az, bz, cz)));
    for (let i = iMin; i <= iMax; i += 1) for (let k = kMin; k <= kMax; k += 1) {
      const w1 = ((i - ax) * (cz - az) - (cx - ax) * (k - az)) / det;
      const w2 = ((bx - ax) * (k - az) - (i - ax) * (bz - az)) / det;
      const w0 = 1 - w1 - w2;
      if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
      const y = w0 * vertices[a + 1] + w1 * vertices[b + 1] + w2 * vertices[c + 1];
      if (y > height[i * nz + k]) height[i * nz + k] = y;
    }
  }
}

/**
 * Cylindrical collider around the neck for hanging hair (rays from the head
 * centre graze the neck): per height band and angle about the neck axis,
 * the largest horizontal radius of the visible neck and jaw skin, dilated
 * by one cell. Built from the deformed mesh.
 */
const NECK_FIELD = Object.freeze({ angles: 48, bands: 9, bottom: 0.1, top: 0.28, reach: 0.1 });
function neckField(positions, skinVertex) {
  const { angles, bands, bottom, top, reach } = NECK_FIELD;
  const { x: axisX, z: axisZ } = GNM_PLAYER_HAIR.neck;
  const radius = new Float32Array(angles * bands);
  const count = skinVertex.length;
  for (let vertex = 0; vertex < count; vertex += 1) {
    if (!skinVertex[vertex]) continue;
    const y = positions[vertex * 3 + 1];
    if (y < bottom || y >= top) continue;
    const dx = positions[vertex * 3] - axisX, dz = positions[vertex * 3 + 2] - axisZ;
    const r = Math.sqrt(dx * dx + dz * dz);
    if (r > reach) continue;
    const a = Math.min(angles - 1, Math.floor(((atan2(dx, dz) + PI) / TAU) * angles));
    const b = Math.floor(((y - bottom) / (top - bottom)) * bands);
    if (r > radius[b * angles + a]) radius[b * angles + a] = r;
  }
  const dilated = new Float32Array(angles * bands);
  for (let b = 0; b < bands; b += 1) for (let a = 0; a < angles; a += 1) {
    let high = 0;
    for (let db = -1; db <= 1; db += 1) {
      const bb = b + db;
      if (bb < 0 || bb >= bands) continue;
      for (let da = -1; da <= 1; da += 1) high = Math.max(high, radius[bb * angles + ((a + da + angles) % angles)]);
    }
    dilated[b * angles + a] = high;
  }
  return { radius: dilated, axisX, axisZ };
}

/** Push a point horizontally out of the neck collider (with `clearance`); no-op outside its height range. */
function keepOutsideNeck(field, xyz, offset, clearance) {
  const { angles, bands, bottom, top } = NECK_FIELD;
  const y = xyz[offset + 1];
  if (y < bottom || y >= top) return;
  const dx = xyz[offset] - field.axisX, dz = xyz[offset + 2] - field.axisZ;
  const r = Math.sqrt(dx * dx + dz * dz);
  const a = Math.min(angles - 1, Math.floor(((atan2(dx, dz) + PI) / TAU) * angles));
  const b = Math.floor(((y - bottom) / (top - bottom)) * bands);
  const needed = field.radius[b * angles + a] + clearance;
  if (r >= needed || r <= 1e-6 || field.radius[b * angles + a] <= 0) return;
  xyz[offset] = field.axisX + dx * (needed / r);
  xyz[offset + 2] = field.axisZ + dz * (needed / r);
}

/** Jersey top (m) at (x, z), or -1 where the bust has no surface below. */
function jerseyHeight(field, x, z) {
  const u = (x - field.x0) / field.cell, v = (z - field.z0) / field.cell;
  if (u < 0 || v < 0 || u >= field.nx - 1 || v >= field.nz - 1) return -1;
  const i = Math.floor(u), k = Math.floor(v), fu = u - i, fv = v - k;
  const h = field.height, n = field.nz;
  const h00 = h[i * n + k], h10 = h[(i + 1) * n + k], h01 = h[i * n + k + 1], h11 = h[(i + 1) * n + k + 1];
  if (h00 < 0 || h10 < 0 || h01 < 0 || h11 < 0) return Math.max(h00, h10, h01, h11);
  return (h00 * (1 - fu) + h10 * fu) * (1 - fv) + (h01 * (1 - fu) + h11 * fu) * fv;
}

/** Side-part line (x of the parting at depth z): the prototype's part line. */
function sidePartX(context, z) { return 0.026 + z * 0.045 + context.partShift; }

/** Parting for the painted scalp: type (0 none, 1 side, 2 centre), x at z = 0 (m) and dx/dz (template space). */
function partLine(context) {
  const { groom } = context;
  if (groom.part === "side") return { type: 1, x0: sidePartX(context, 0), slope: 0.045 };
  if (groom.part === "center") return { type: 2, x0: context.partShift * 0.5, slope: 0 };
  if (groom.part === "natural") return { type: 2, x0: 0.006 + context.partShift, slope: 0 };
  return { type: 0, x0: 0, slope: 0 };
}

/**
 * Weight (0..1) of the parting's influence at a point: partings divide the
 * top and front of the head; behind the crown hair falls naturally.
 */
function partWeight(context, y, z) {
  if (!context.groom.part && context.groom.comb !== "side-part") return 0;
  return smoothstep(0.325, 0.36, y) * smoothstep(-0.05, -0.012, z);
}

/** Which side of its parting a root lies on (-1/+1). */
function partSide(context, x, z) {
  const { groom } = context;
  if (groom.comb === "side-part" || groom.comb === "long-side") return x < sidePartX(context, z) ? -1 : 1;
  if (groom.part === "natural") return x < 0.006 + context.partShift ? -1 : 1;
  return x < context.partShift * 0.5 ? -1 : 1;
}

/** Distance (m, across) from a template point to its parting line; Infinity without one. */
function partDistance(context, x, z) {
  const { groom } = context;
  if (groom.comb === "side-part" || groom.comb === "long-side") return Math.abs(x - sidePartX(context, z));
  if (groom.part === "natural") return Math.abs(x - 0.006 - context.partShift);
  if (groom.part === "center") return Math.abs(x - context.partShift * 0.5);
  return Infinity;
}

/** Style length (mm) at root candidate `slot`, from its static region weights. */
function candidateLength(context, slot, above) {
  const { groom, style, scalp } = context;
  const w = slot * 7, regions = scalp.candidateRegions, lengths = groom.length;
  const top = lengths[0], fringe = lengths[1], side = lengths[2], back = lengths[3], nape = lengths[4];
  let length = side + (back - side) * regions[w + 5];
  length += (nape - length) * regions[w + 6];
  length += (top - length) * regions[w + 3];
  length += (fringe - length) * regions[w + 4];
  const fade = style.fade * regions[w + 2] * (1 - smoothstep(0, 40, above));
  return length * lerp(1, groom.fadeFloor, fade);
}

/** Hairline threshold (mm) at root candidate `slot` (gnmPlayerHairThreshold from static weights). */
function candidateThreshold(context, slot) {
  const w = slot * 7, regions = context.scalp.candidateRegions;
  return context.style.hairline * regions[w] + context.style.back * regions[w + 1];
}

/** Braid rows: lateral position (lambda) and extent (theta) of each cornrow, with seed-stable jitter. */
function braidRows(groom, seed, salt) {
  const count = groom.braids.rows;
  return Array.from({ length: count }, (_, row) => {
    const r = (k) => hashUnit(seed, row, salt ^ k);
    const lambda = ((row + 0.5) / count - 0.5) * 1.55 + (r(1) - 0.5) * 0.05;
    return {
      lambda,
      thetaFront: 1.05 - 0.3 * Math.abs(lambda) + (r(2) - 0.5) * 0.06,
      thetaBack: -2.15 + 0.35 * Math.abs(lambda),
      tail: groom.braids.tailMm / 1000 * (0.8 + 0.4 * r(3)),
      period: groom.braids.periodMm / 1000 * (0.9 + 0.2 * r(4)),
      halfWidth: groom.braids.halfWidthMm / 1000 * (0.9 + 0.2 * r(5)),
      phase: r(6) * TAU,
    };
  });
}

/** Lateral coordinate (lambda) of a row at fraction t from the front hairline to the nape. */
function rowLambda(row, t) { return row.lambda * lerp(1, 0.72, smoothstep(0.45, 1, t)); }

/** Distance (m, across the rows) from a point to the nearest braid row. */
function rowDistance(context, x, y, z) {
  const dx = x - CX, dy = y - CY, dz = z - CZ;
  const theta = atan2(dz, dy), lambda = atan2(dx, Math.sqrt(dy * dy + dz * dz));
  const radius = Math.sqrt(dx * dx + dy * dy + dz * dz);
  let best = Infinity;
  for (const row of context.rows) {
    const t = clamp((row.thetaFront - theta) / (row.thetaFront - row.thetaBack), 0, 1);
    best = Math.min(best, Math.abs(lambda - rowLambda(row, t)) * radius);
  }
  return best;
}

/** Root density (0..1) of candidate `slot`: soft hairline falloff, fade gradient, parting channel and braid rows. */
function rootDensity(context, slot) {
  const { style, groom, scalp } = context;
  const x = scalp.candidatePosition[slot * 3], y = scalp.candidatePosition[slot * 3 + 1], z = scalp.candidatePosition[slot * 3 + 2];
  const scalpMm = scalp.candidateScalp[slot];
  const threshold = candidateThreshold(context, slot);
  const above = scalpMm - threshold + (scalp.candidateNoise[slot] - 0.5) * 3.2;
  const soft = groom.hairlineSoftness;
  if (above <= -2.5 * soft) return 0;
  let density = smoothstep(-2.5 * soft, 4.5 * soft, above);
  const fade = style.fade * scalp.candidateRegions[slot * 7 + 2] * (1 - smoothstep(0, 45, scalpMm - threshold));
  density *= 1 - 0.82 * fade;
  if (groom.part === "side") {
    const distance = Math.abs(x - sidePartX(context, z));
    density *= lerp(1, smoothstep(0.00035, 0.0013, distance), smoothstep(-0.03, 0.0, z) * smoothstep(0.33, 0.36, y));
  } else if (groom.part === "center" || groom.part === "natural") {
    const partX = groom.part === "natural" ? 0.006 + context.partShift : context.partShift * 0.5;
    density *= lerp(1, smoothstep(0.0003, 0.0012, Math.abs(x - partX)), smoothstep(-0.02, 0.02, z) * smoothstep(0.34, 0.375, y));
  }
  if (context.rows) density *= lerp(0.05, 1, 1 - smoothstep(0.6, 1.1, rowDistance(context, x, y, z) / (groom.braids.bandMm / 1000)));
  return density;
}

/**
 * Combing direction (unnormalized, written to context.comb) at world point
 * (x, y, z) for a strand rooted on `side` of its parting (-1/+1). Near the
 * hairline every style blends into the natural growth from the crown whorl.
 */
function combDirection(context, x, y, z, side) {
  const { groom, whorl, comb } = context;
  const front = frontAt(x, z);
  const top = smoothstep(0.345, 0.392, y);
  const fringe = smoothstep(0.3, 0.75, front) * smoothstep(0.328, 0.372, y);
  const back = smoothstep(0.05, 0.65, -front);
  // Natural growth: away from the crown whorl, with a slight swirl around it.
  let gx = x - whorl[0], gy = y - whorl[1], gz = z - whorl[2];
  const distance = Math.sqrt(gx * gx + gy * gy + gz * gz) + 1e-6;
  gx /= distance; gy /= distance; gz /= distance;
  const swirl = Math.exp(-distance / 0.03) * 0.8;
  const swirled = gx + swirl * gz;
  gz -= swirl * gx;
  gx = swirled;
  let cx = gx, cy = gy, cz = gz;
  switch (groom.comb) {
    case "forward": {
      const k = Math.max(top, fringe) * (1 - back);
      cx = lerp(gx, 0.1 * side, k); cy = lerp(gy, -0.25, k); cz = lerp(gz, 1, k);
      break;
    }
    case "quiff": {
      const k = Math.max(top, fringe);
      cx = lerp(gx, 0, k); cy = lerp(gy, 0.1 + 0.45 * fringe, k); cz = lerp(gz, -1, k);
      break;
    }
    case "side-part": {
      const k = smoothstep(0.33, 0.37, y) * (1 - back * 0.6) * (0.35 + 0.65 * partWeight(context, y, z));
      if (side < 0) { cx = lerp(gx, -1, k); cy = lerp(gy, -0.05, k); cz = lerp(gz, 0.22 - 0.3 * back, k); }
      else { cx = lerp(gx, 1, k); cy = lerp(gy, -0.55, k); cz = lerp(gz, -0.25, k); }
      break;
    }
    case "center-part": {
      const k = smoothstep(0.3, 0.37, y);
      cx = lerp(gx, side * lerp(0.25, 1, partWeight(context, y, z)) * (1 - back), k); cy = lerp(gy, -0.45, k); cz = lerp(gz, -0.18, k);
      break;
    }
    case "tousled": {
      // Side-swept fringe, the rest falling naturally.
      const k = Math.max(top, fringe) * (1 - back);
      cx = lerp(gx, 0.85, k); cy = lerp(gy, -0.3, k); cz = lerp(gz, 0.42, k);
      break;
    }
    case "long": case "long-side": {
      const k = smoothstep(0.3, 0.37, y);
      cx = lerp(gx, side * 0.9 * lerp(0.2, 1, partWeight(context, y, z)) * (1 - back), k); cy = lerp(gy, -0.35, k); cz = lerp(gz, -0.55 - 0.25 * back, k);
      break;
    }
    case "outward": {
      const rx = x - CX, ry = y - CY, rz = z - CZ;
      const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) + 1e-9;
      cx = rx / rl + gx * 0.35; cy = ry / rl + gy * 0.35 - 0.12; cz = rz / rl + gz * 0.35;
      break;
    }
    case "bun": {
      const bun = context.bun;
      if (bun) { cx = bun.base[0] - x; cy = bun.base[1] - y; cz = bun.base[2] - z; } else { cx = 0; cy = 0.2; cz = -1; }
      break;
    }
    case "braid": {
      // Along the rows (backwards), converging slightly towards the nape.
      cx = -x * 1.5; cy = 0.1; cz = -1;
      break;
    }
    default: break;
  }
  comb[0] = cx; comb[1] = cy; comb[2] = cz;
}

/** Face zone the hair must not enter: in front of the cheeks, below the brows. */
function inFace(context, x, y, z) {
  return y < context.browTop + 0.005 && frontAt(x, z) > 0.6;
}

/**
 * Grow one guide from its root through the flow field with the head and
 * the jersey as colliders, into `store` at `offset` (xyz per step) and
 * `heights` (m above the head). Returns the arc length where it met the
 * face or entered the bun (Infinity if it never did).
 */
function growGuide(context, map, root, normal, side, random, length, steps, store, offset, heights, radii, heightOffset, liftScale = 1) {
  const { groom } = context;
  const comb = context.comb;
  const step = length / steps;
  let px = root[0], py = root[1], pz = root[2];
  const nx = normal[0], ny = normal[1], nz = normal[2];
  combDirection(context, px, py, pz, side);
  let along = comb[0] * nx + comb[1] * ny + comb[2] * nz;
  let tx = comb[0] - nx * along, ty = comb[1] - ny * along, tz = comb[2] - nz * along;
  let tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (tl < 1e-9) { tx = 0; ty = -1; tz = 0; tl = 1; }
  tx /= tl; ty /= tl; tz /= tl;
  const top = smoothstep(0.34, 0.39, py);
  // Hair rises more around the crown whorl, so the whorl itself stays covered.
  const whorl = context.whorl;
  const crown = Math.exp(-Math.hypot(px - whorl[0], py - whorl[1], pz - whorl[2]) / 0.022) * groom.crownLift;
  const lift = (lerp(groom.lift[1], groom.lift[0], top) + crown + (random[0] - 0.5) * 12) * liftScale * (PI / 180);
  const cosLift = Math.cos(lift), sinLift = Math.sin(lift);
  let dx = tx * cosLift + nx * sinLift, dy = ty * cosLift + ny * sinLift, dz = tz * cosLift + nz * sinLift;
  const layer = lerp(groom.layer[0], groom.layer[1], random[1]);
  const bump = 1 + (random[2] - 0.5) * 2 * groom.bumps;
  const ramp = Math.min(0.012, length * 0.35);
  store[offset] = px; store[offset + 1] = py; store[offset + 2] = pz; heights[heightOffset] = 0;
  radii[heightOffset] = Math.sqrt((px - CX) * (px - CX) + (py - CY) * (py - CY) + (pz - CZ) * (pz - CZ));
  let falling = false;
  let cut = Infinity;
  const bun = groom.comb === "bun" ? context.bun : null;
  const jersey = context.jersey;
  const guidePoint = context.point;
  for (let k = 1; k <= steps; k += 1) {
    const s = k * step;
    const rx = px - CX, ry = py - CY, rz = pz - CZ;
    const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
    const ux = rx / rl, uy = ry / rl, uz = rz / rl;
    combDirection(context, px, py, pz, side);
    if (groom.tangent) {
      along = comb[0] * ux + comb[1] * uy + comb[2] * uz;
      tx = comb[0] - ux * along; ty = comb[1] - uy * along; tz = comb[2] - uz * along;
    } else { tx = comb[0]; ty = comb[1]; tz = comb[2]; }
    tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    // Below the head's widest level hanging hair falls instead of hugging the ears and jaw.
    if (!falling && groom.gravity > 0 && uy < -0.02 && s > 0.02) falling = true;
    const follow = groom.follow * smoothstep(0, 0.006, s) * (falling ? 0.35 : 1);
    dx += (tx - dx) * follow; dy += (ty - dy) * follow; dz += (tz - dz) * follow;
    // Gravity grows along the strand and dominates once below the equator.
    dy -= groom.gravity * (falling ? 0.55 : 0.12 * smoothstep(0.04, 0.12, s));
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    const lx = px, ly = py, lz = pz;
    px += dx * step; py += dy * step; pz += dz * step;
    // Keep the strand at its layer of the hair volume, outside the head.
    const ox = px - CX, oy = py - CY, oz = pz - CZ;
    const r = Math.sqrt(ox * ox + oy * oy + oz * oz);
    // Exact surface at the root, the conservative collider 15 mm along the strand.
    map.reach = s >= 0.015 ? 1 : smoothstep(0, 0.015, s);
    const surface = headLookup(map, ox, oy, oz);
    map.reach = 1;
    const volume = map.lookup[0] * bump;
    const minimum = CLEARANCE + layer * volume * smoothstep(0, ramp, s);
    let height = r - surface;
    if (height < minimum) height = minimum;
    else if (!falling) {
      const maximum = CLEARANCE + volume * 1.08 + 0.0015;
      if (height > maximum) height = lerp(height, maximum, 0.7);
    }
    const scale = (surface + height) / r;
    px = CX + ox * scale; py = CY + oy * scale; pz = CZ + oz * scale;
    // Neck: hanging hair stays outside it (the radial map grazes the neck).
    if (context.neck && py < 0.28) {
      guidePoint[0] = px; guidePoint[1] = py; guidePoint[2] = pz;
      keepOutsideNeck(context.neck, guidePoint, 0, 0.0015);
      px = guidePoint[0]; pz = guidePoint[2];
    }
    // Shoulders: hanging hair rests on the jersey and slides down its slope.
    let resting = false;
    if (jersey && py < 0.24) {
      const top = jerseyHeight(jersey, px, pz);
      if (top > 0 && py < top + 0.003) {
        py = top + 0.003;
        resting = true;
      }
    }
    dx = px - lx; dy = py - ly; dz = pz - lz;
    const moved = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= moved; dy /= moved; dz /= moved;
    if (resting) {
      // Continue downhill along the jersey (finite-difference gradient), but
      // drape over the front or the back of the shoulders rather than slide
      // out along the shoulder line (no horizontal fan of ends).
      const gx = jerseyHeight(jersey, px + 0.004, pz) - jerseyHeight(jersey, px - 0.004, pz);
      const gz = jerseyHeight(jersey, px, pz + 0.004) - jerseyHeight(jersey, px, pz - 0.004);
      const gl = Math.sqrt(gx * gx + gz * gz);
      const hx = gl > 1e-5 ? -gx / gl : 0, hz = gl > 1e-5 ? -gz / gl : 0;
      dx = lerp(dx, hx, 0.25) * 0.3;
      dz = lerp(dz, hz, 0.25) * 0.45 + (pz < GNM_PLAYER_HAIR.neck.z ? -0.3 : 0.3);
      dy = -Math.max(gl / 0.008, 0.4);
      const l2 = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx /= l2; dy /= l2; dz /= l2;
    }
    store[offset + k * 3] = px; store[offset + k * 3 + 1] = py; store[offset + k * 3 + 2] = pz;
    heights[heightOffset + k] = height;
    // Radius about the head centre per guide point: strands interpolate it
    // instead of measuring every sample (the chord error is ~0.03 mm).
    radii[heightOffset + k] = Math.sqrt((px - CX) * (px - CX) + (py - CY) * (py - CY) + (pz - CZ) * (pz - CZ));
    if (cut === Infinity) {
      if (inFace(context, px, py, pz)) cut = Math.max(s - step, step);
      else if (bun && (px - bun.center[0]) ** 2 + (py - bun.center[1]) ** 2 + (pz - bun.center[2]) ** 2 < (bun.radius * 0.92) ** 2) cut = s;
      // Short cuts are trimmed around the ears instead of standing out over them.
      else if (!(groom.hang > 0) && s > 0.004 && overEar(context.scalp.mapEar, ox, oy, oz)) cut = Math.max(s - step, step);
    }
  }
  return cut;
}

/** Rotation (row-major 3x3, then the radial scale) taking unit a to unit b about the head centre. */
function writeRotation(ax, ay, az, bx, by, bz, scale, out, offset) {
  const vx = ay * bz - az * by, vy = az * bx - ax * bz, vz = ax * by - ay * bx;
  const c = ax * bx + ay * by + az * bz;
  const k = 1 / Math.max(1 + c, 1e-6);
  out[offset] = vx * vx * k + c; out[offset + 1] = vx * vy * k - vz; out[offset + 2] = vx * vz * k + vy;
  out[offset + 3] = vy * vx * k + vz; out[offset + 4] = vy * vy * k + c; out[offset + 5] = vy * vz * k - vx;
  out[offset + 6] = vz * vx * k - vy; out[offset + 7] = vz * vy * k + vx; out[offset + 8] = vz * vz * k + c;
  out[offset + 9] = scale;
}

/* ------------------------------------------------------------------------ */
/* Strand buffers                                                            */
/* ------------------------------------------------------------------------ */

/** Taper (t^2), root-shade ramp (smoothstep(0, 0.45, t)) and t per point index, cached per point count. */
const PROFILES = new Map();
function strandProfile(count) {
  if (!PROFILES.has(count)) {
    const taper = new Float64Array(count), ramp = new Float64Array(count), t = new Float64Array(count);
    for (let p = 0; p < count; p += 1) { t[p] = p / (count - 1); taper[p] = t[p] * t[p]; ramp[p] = smoothstep(0, 0.45, t[p]); }
    PROFILES.set(count, { taper, ramp, t });
  }
  return PROFILES.get(count);
}

/**
 * Strands written in place in the renderer's ribbon layout (two vertices
 * per centreline point). Tier 0 (the reduced level of detail) fills the
 * first region, tier 1 the rest; capacities are exact. `kindNames` maps the
 * diagnostic name of each strand kind to its value (scalp hair by default;
 * the beard and brows share the buffers with their own kinds).
 */
class StrandBuffers {
  constructor(tier0Points, tier1Points, kindNames = KIND) {
    const total = tier0Points + tier1Points;
    this.vertices = new Float32Array(total * 6);
    this.normals = new Float32Array(total * 6);
    this.uvs = new Float32Array(total * 6);
    this.surface = new Float32Array(total * 8);
    this.rootVertices = new Uint32Array(total * 2);
    this.cursor = [0, tier0Points];
    this.limit = [tier0Points, total];
    this.counts = [[], []];
    this.roots = [[], []];
    this.kindNames = kindNames;
    this.kinds = new Array(Math.max(...Object.values(kindNames)) + 1).fill(0);
  }
  /**
   * Append one strand of `count` centreline points to `tier`. Half-width (m)
   * is width * (1 - taper * t^2), or constant with a blunt 4% tip when
   * taper < 0; visibility rises from `shade` at the root to `tipShade` by
   * t = 0.45 (`flat`: constant `shade`). `boost` (per point, optional) is
   * the extra ribbon width of hanging hair, stored as the third uv component.
   */
  add(tier, xyz, count, rootVertex, random, kind, width, taper, shade, flat = false, tipShade = 1, boost = null) {
    const base = this.cursor[tier];
    if (base + count > this.limit[tier]) throw new Error("GNM player hair strand buffer overflow");
    const profile = strandProfile(count);
    const { vertices, normals, uvs, surface, rootVertices } = this;
    let lx = 0, ly = -1, lz = 0;
    for (let p = 0; p < count; p += 1) {
      const a = p > 0 ? p - 1 : 0, b = p < count - 1 ? p + 1 : count - 1;
      let tx = xyz[b * 3] - xyz[a * 3], ty = xyz[b * 3 + 1] - xyz[a * 3 + 1], tz = xyz[b * 3 + 2] - xyz[a * 3 + 2];
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl > 1e-12) { tx /= tl; ty /= tl; tz /= tl; lx = tx; ly = ty; lz = tz; } else { tx = lx; ty = ly; tz = lz; }
      const t = profile.t[p];
      const halfWidth = taper < 0 ? width * (t > 0.96 ? (1 - t) / 0.04 : 1) : width * (1 - taper * profile.taper[p]);
      const visibility = flat ? shade : shade + (tipShade - shade) * profile.ramp[p];
      const v = (base + p) * 2;
      const x = xyz[p * 3], y = xyz[p * 3 + 1], z = xyz[p * 3 + 2];
      vertices[v * 3] = x; vertices[v * 3 + 1] = y; vertices[v * 3 + 2] = z;
      vertices[v * 3 + 3] = x; vertices[v * 3 + 4] = y; vertices[v * 3 + 5] = z;
      normals[v * 3] = tx; normals[v * 3 + 1] = ty; normals[v * 3 + 2] = tz;
      normals[v * 3 + 3] = tx; normals[v * 3 + 4] = ty; normals[v * 3 + 5] = tz;
      const extra = boost ? boost[p] : 0;
      uvs[v * 3] = 0; uvs[v * 3 + 1] = t; uvs[v * 3 + 2] = extra; uvs[v * 3 + 3] = 1; uvs[v * 3 + 4] = t; uvs[v * 3 + 5] = extra;
      surface[v * 4] = halfWidth; surface[v * 4 + 1] = random; surface[v * 4 + 2] = visibility; surface[v * 4 + 3] = kind;
      surface[v * 4 + 4] = halfWidth; surface[v * 4 + 5] = random; surface[v * 4 + 6] = visibility; surface[v * 4 + 7] = kind;
      rootVertices[v] = rootVertex; rootVertices[v + 1] = rootVertex;
    }
    this.cursor[tier] += count;
    this.counts[tier].push(count);
    this.roots[tier].push(rootVertex);
    this.kinds[kind] += 1;
  }
  /** The finished mesh; tier 0 strands come first (the reduced level of detail). */
  finish(extra) {
    if (this.cursor[0] !== this.limit[0] || this.cursor[1] !== this.limit[1]) throw new Error("GNM player hair strand buffers were not filled exactly");
    const counts = [...this.counts[0], ...this.counts[1]];
    const pointsPerStrand = Uint16Array.from(counts);
    const { indices, reducedIndexCount } = stripIndices(pointsPerStrand, this.counts[0].length);
    // Ambient-occlusion occluders: the first third of the reduced tier (the
    // same strands in every level of detail).
    const aoStrands = Math.round(this.counts[0].length / 3);
    let aoIndexCount = 0;
    for (let strand = 0; strand < aoStrands; strand += 1) aoIndexCount += (pointsPerStrand[strand] - 1) * 6;
    return {
      vertices: this.vertices, normals: this.normals, uvs: this.uvs, surface: this.surface, rootVertices: this.rootVertices, indices,
      strandCount: counts.length,
      pointCount: this.limit[1],
      roots: Uint32Array.from([...this.roots[0], ...this.roots[1]]),
      pointsPerStrand,
      tiers: { reduced: this.counts[0].length, reducedIndexCount, full: counts.length, fullIndexCount: indices.length, ao: aoStrands, aoIndexCount },
      kinds: Object.fromEntries(Object.entries(this.kindNames).map(([name, value]) => [name, this.kinds[value]])),
      ...extra,
    };
  }
}

/**
 * Ribbon triangle indices for strands of the given point counts (cached by
 * the run-length signature: rebuilding the same style reuses the array).
 */
const INDEX_CACHE = new Map();
function stripIndices(pointsPerStrand, reducedStrands) {
  const runs = [];
  for (let strand = 0; strand < pointsPerStrand.length; strand += 1) {
    if (runs.length && runs.at(-1)[0] === pointsPerStrand[strand]) runs.at(-1)[1] += 1;
    else runs.push([pointsPerStrand[strand], 1]);
  }
  const key = `${reducedStrands}:${runs.map((run) => run.join("x")).join(",")}`;
  if (!INDEX_CACHE.has(key)) {
    let segments = 0, reducedSegments = 0;
    pointsPerStrand.forEach((count, strand) => { segments += count - 1; if (strand < reducedStrands) reducedSegments += count - 1; });
    const indices = new Uint32Array(segments * 6);
    let cursor = 0, point = 0;
    for (const count of pointsPerStrand) {
      for (let segment = 0; segment < count - 1; segment += 1) {
        const a = (point + segment) * 2;
        indices[cursor] = a; indices[cursor + 1] = a + 1; indices[cursor + 2] = a + 2;
        indices[cursor + 3] = a + 1; indices[cursor + 4] = a + 3; indices[cursor + 5] = a + 2;
        cursor += 6;
      }
      point += count;
    }
    if (INDEX_CACHE.size >= 8) INDEX_CACHE.delete(INDEX_CACHE.keys().next().value);
    INDEX_CACHE.set(key, { indices, reducedIndexCount: reducedSegments * 6 });
  }
  return INDEX_CACHE.get(key);
}

/** Empty hair mesh (hair hidden). */
export function emptyGnmPlayerHair() {
  return new StrandBuffers(0, 0).finish({ style: null, groom: null, guides: 0, lod: "none", babyHairs: 0, part: { type: 0, x0: 0, slope: 0 }, tipFade: 0.8 });
}

/**
 * Strand parameter t where scalp strands start to fade out: the last ~8 mm
 * of the style's longest strands (4-20% of t). A fixed fraction would fade
 * the lower centimetres of long hair, and alpha-to-coverage does not add up
 * faded tips into an opaque curtain.
 */
function tipFadeStart(groom) {
  return 1 - clamp(8 / Math.max(...groom.length), 0.04, 0.2);
}

/* ------------------------------------------------------------------------ */
/* Per-frame build                                                           */
/* ------------------------------------------------------------------------ */

/** Reusable per-scalp scratch for guide curves (builds are synchronous). */
const GUIDE_SCRATCH = new WeakMap();
function guideScratch(scalp) {
  if (!GUIDE_SCRATCH.has(scalp)) {
    const count = scalp.guideCandidates.length;
    GUIDE_SCRATCH.set(scalp, {
      state: new Uint8Array(count),
      store: new Float32Array(count * (MAX_GUIDE_STEPS + 1) * 3),
      heights: new Float32Array(count * (MAX_GUIDE_STEPS + 1)),
      radii: new Float32Array(count * (MAX_GUIDE_STEPS + 1)),
      steps: new Int32Array(count),
      step: new Float64Array(count),
      cut: new Float64Array(count),
      length: new Float64Array(count),
      direction: new Float64Array(count * 3),
      radius: new Float64Array(count),
      side: new Int8Array(count),
      grown: 0,
    });
  }
  const guides = GUIDE_SCRATCH.get(scalp);
  guides.state.fill(0);
  guides.grown = 0;
  return guides;
}

/**
 * Build the strand hair of one frame. `positions`/`normals` are the render
 * vertex arrays of the reconstructed mesh, `style` the appearance hair style
 * (null: hidden) and `seed` the profile seed. Options: `lod` ("full", or
 * "reduced" for the reduced tier only), `browTop` (m), `bust` (the jersey
 * mesh: { vertices, indices, collarVertexCount }) and `bun` ({ center,
 * radius, normal, base, rootVertex } of the bun core).
 */
export function buildGnmPlayerHair(scalp, positions, normals, style, seed, options = {}) {
  if (!style) return emptyGnmPlayerHair();
  const groom = gnmPlayerHairGroom(style);
  const context = styleContext(style, groom, scalp, seed >>> 0, { ...options, positions, skinVertex: scalp.skinVertex });
  const map = styleHeadMap(context, computeGnmPlayerHeadMap(scalp, positions, normals));
  const lod = options.lod === "reduced" ? "reduced" : "full";
  const reducedCount = Math.round(groom.count * GNM_PLAYER_HAIR.reducedFraction);
  const wanted = lod === "reduced" ? reducedCount : groom.count;
  // 1. Accept root candidates in their fixed shuffled order by density.
  const accepted = new Int32Array(wanted);
  let acceptedCount = 0;
  for (let slot = 0; slot < scalp.candidateCount && acceptedCount < wanted; slot += 1) {
    const density = rootDensity(context, slot);
    if (density > 0 && hashUnit(context.seed, slot, context.salt) < density) accepted[acceptedCount++] = slot;
  }
  // 2. Guides, grown on demand for the accepted roots into reusable storage.
  const guides = guideScratch(scalp);
  const frame = new Float64Array(6);
  const random = new Float64Array(3);
  const rootFrame = (slot, out) => {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; out[4] = 0; out[5] = 0;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = scalp.candidateTri[slot * 3 + corner], weight = scalp.candidateBary[slot * 3 + corner];
      out[0] += weight * positions[vertex * 3]; out[1] += weight * positions[vertex * 3 + 1]; out[2] += weight * positions[vertex * 3 + 2];
      out[3] += weight * normals[vertex * 3]; out[4] += weight * normals[vertex * 3 + 1]; out[5] += weight * normals[vertex * 3 + 2];
    }
    const length = Math.sqrt(out[3] * out[3] + out[4] * out[4] + out[5] * out[5]) || 1;
    out[3] /= length; out[4] /= length; out[5] /= length;
  };
  const growOn = (guide) => {
    if (guides.state[guide]) return;
    const slot = scalp.guideCandidates[guide];
    rootFrame(slot, frame);
    const tx = scalp.candidatePosition[slot * 3], ty = scalp.candidatePosition[slot * 3 + 1], tz = scalp.candidatePosition[slot * 3 + 2];
    const above = scalp.candidateScalp[slot] - candidateThreshold(context, slot);
    const lengthMm = Math.max(candidateLength(context, slot, above) * (1 + groom.jitter) * 1.12, 1.5);
    // Guide steps of 8 mm or more (at most 22 steps): strands sample the
    // guides linearly and run their own collision per point.
    const steps = clamp(Math.ceil(lengthMm / Math.max(8, lengthMm / 22)), 3, 36);
    random[0] = hashUnit(context.seed, guide, context.salt ^ 0x1b873593);
    random[1] = hashUnit(context.seed, guide, context.salt ^ 0x68e31da4);
    random[2] = hashUnit(context.seed, guide, context.salt ^ 0x5a17c2e1);
    const side = partSide(context, tx, tz);
    // Next to a parting the hair lies flatter, so it shades and half covers the part.
    const liftScale = 1 - 0.65 * partWeight(context, ty, tz) * (1 - smoothstep(0.002, 0.009, partDistance(context, tx, tz)));
    const root = [frame[0], frame[1], frame[2]];
    guides.cut[guide] = growGuide(context, map, root, [frame[3], frame[4], frame[5]], side, random, lengthMm / 1000, steps, guides.store, guide * (MAX_GUIDE_STEPS + 1) * 3, guides.heights, guides.radii, guide * (MAX_GUIDE_STEPS + 1), liftScale);
    guides.steps[guide] = steps;
    guides.length[guide] = lengthMm / 1000;
    guides.step[guide] = lengthMm / 1000 / steps;
    const dx = root[0] - CX, dy = root[1] - CY, dz = root[2] - CZ;
    const radius = Math.sqrt(dx * dx + dy * dy + dz * dz);
    guides.direction[guide * 3] = dx / radius; guides.direction[guide * 3 + 1] = dy / radius; guides.direction[guide * 3 + 2] = dz / radius;
    guides.radius[guide] = radius;
    guides.side[guide] = side;
    guides.state[guide] = 1;
    guides.grown += 1;
  };
  // 3. Exact storage: tier 0 = the first `reducedCount` roots plus the
  // reduced share of the bun and the plaits; tier 1 = everything else.
  const pointCount = groom.segments + 1;
  const scalpTier0 = Math.min(acceptedCount, reducedCount);
  const bunPlan = groom.bun && context.bun ? bunPlanOf(groom, lod) : null;
  const braidPlan = groom.braids ? braidPlanOf(context, map, positions, lod) : null;
  const tierPoints = [scalpTier0 * pointCount, (acceptedCount - scalpTier0) * pointCount];
  for (const plan of [bunPlan, braidPlan]) if (plan) { tierPoints[0] += plan.points[0]; tierPoints[1] += plan.points[1]; }
  const buffers = new StrandBuffers(tierPoints[0], tierPoints[1]);
  const scratch = {
    xyz: new Float64Array(pointCount * 3),
    heights: new Float64Array(pointCount),
    boost: new Float32Array(pointCount),
    rotations: new Float64Array(30),
    root: new Float64Array(6),
    weights: new Float64Array(3),
    ids: new Int32Array(3),
    guideInfo: new Float64Array(15),
    clumpProfile: Float64Array.from({ length: pointCount }, (_, p) => Math.pow(p / groom.segments, groom.clumpPower)),
    collision: { radii: map.radii, raw: map.raw, volume: null, reach: 1 },
    stream: new RandomStream(0, 0, 0),
  };
  let babyHairs = 0;
  for (let order = 0; order < acceptedCount; order += 1) {
    if (addScalpStrand(context, map, guides, growOn, accepted[order], rootFrame, scratch, buffers, order < reducedCount ? 0 : 1)) babyHairs += 1;
  }
  if (bunPlan) addBun(context, scratch.collision, buffers, bunPlan);
  if (braidPlan) addBraids(context, scratch.collision, buffers, braidPlan);
  return buffers.finish({ style: style.asset, groom: groom.label, lod, babyHairs, guides: guides.grown, part: partLine(context), tipFade: tipFadeStart(groom) });
}

/** One interpolated scalp strand into `tier`. Returns true when it is a hairline baby hair. */
function addScalpStrand(context, map, guides, growOn, slot, rootFrame, scratch, buffers, tier) {
  const { groom, seed, salt, scalp } = context;
  const { xyz, heights, rotations, root, weights, ids, guideInfo, clumpProfile, collision, boost } = scratch;
  const segments = groom.segments;
  const pointCount = segments + 1;
  rootFrame(slot, root);
  const tx = scalp.candidatePosition[slot * 3], ty = scalp.candidatePosition[slot * 3 + 1], tz = scalp.candidatePosition[slot * 3 + 2];
  const above = scalp.candidateScalp[slot] - candidateThreshold(context, slot);
  // Per-strand randoms, always drawn in the same order.
  const random = scratch.stream;
  random.state = mix32(seed ^ mix32(Math.imul(slot + 1, 0x9e3779b1) ^ salt)) || 0x9e3779b9;
  const babyDraw = random.next(), flyawayDraw = random.next(), lengthDraw = random.next(), babyLengthDraw = random.next(), cutDraw = random.next();
  const clumpDraw = random.next(), frizzDraw = random.next(), a1Draw = random.next(), a2Draw = random.next(), b1Draw = random.next(), b2Draw = random.next();
  const curlRadiusDraw = random.next(), curlPhaseDraw = random.next(), layerDraw = random.next(), widthDraw = random.next(), strandRandom = random.next();
  // Hairline band: finer, shorter baby hairs in the soft density falloff.
  const hairline = 1 - smoothstep(0.5, 6 * groom.hairlineSoftness, above);
  const baby = hairline > 0.35 && babyDraw < groom.baby * hairline;
  const flyaway = !baby && flyawayDraw < groom.flyaway;
  const hang = baby || flyaway ? 0 : groom.hang;
  let lengthMm = candidateLength(context, slot, above) * (1 + (lengthDraw - 0.5) * 2 * groom.jitter);
  lengthMm *= baby ? lerp(0.25, 0.6, babyLengthDraw) : lerp(1, 0.72, hairline);
  let side = partSide(context, tx, tz);
  const parted = partWeight(context, ty, tz) > 0.25;
  // A few strands beside a parting are combed across it: never a ruled line.
  // (They follow the other side's guides, so every point is collision checked.)
  const crossed = parted && partDistance(context, tx, tz) < 0.0025 && hashUnit(seed, slot, salt ^ 0x2c1b3c6d) < 0.18;
  if (crossed) side = -side;
  // Guides across a parting barely bend this strand; cuts come from the dominant guides.
  let total = 0, longest = 0;
  for (let k = 0; k < 3; k += 1) {
    const g = scalp.nearGuides[slot * 3 + k];
    growOn(g);
    ids[k] = g;
    weights[k] = scalp.guideWeights[slot * 3 + k] * (parted && guides.side[g] !== side ? 0.02 : 1);
    total += weights[k];
  }
  // A third guide with a small weight (under a quarter) is dropped (two-guide blend).
  const blended = weights[2] / total < 0.25 ? 2 : 3;
  if (blended === 2) { total -= weights[2]; weights[2] = 0; }
  let cut = Infinity;
  for (let k = 0; k < 3; k += 1) {
    weights[k] /= total;
    if (weights[k] > 0.2) { cut = Math.min(cut, guides.cut[ids[k]]); longest = Math.max(longest, guides.length[ids[k]]); }
  }
  // Strands stopped by the face end at uneven lengths above it (no blunt line).
  if (cut < lengthMm / 1000) cut *= 0.7 + 0.3 * cutDraw;
  const length = Math.max(Math.min(lengthMm / 1000, cut, longest), 0.0006);
  // Rotations about the head centre taking each guide root onto this root,
  // and per-guide sampling constants (length, fade start, 1/step, last segment, base).
  const bx = root[0] - CX, by = root[1] - CY, bz = root[2] - CZ;
  const br = Math.sqrt(bx * bx + by * by + bz * bz);
  for (let k = 0; k < 3; k += 1) {
    const g = ids[k];
    writeRotation(guides.direction[g * 3], guides.direction[g * 3 + 1], guides.direction[g * 3 + 2], bx / br, by / br, bz / br, br / guides.radius[g], rotations, k * 10);
    guideInfo[k * 5] = guides.length[g];
    guideInfo[k * 5 + 1] = guides.length[g] * 0.8;
    guideInfo[k * 5 + 2] = 1 / guides.step[g];
    guideInfo[k * 5 + 3] = guides.steps[g] - 1;
    guideInfo[k * 5 + 4] = g * (MAX_GUIDE_STEPS + 1);
  }
  // The clump centre is the nearest guide on this side of the parting.
  let clumpGuide = -1;
  for (let k = 0; k < blended && clumpGuide < 0; k += 1) if (!parted || guides.side[ids[k]] === side) clumpGuide = k;
  const clump = clumpGuide < 0 ? 0 : groom.clump * (0.7 + 0.6 * clumpDraw) * (baby ? 0.2 : 1);
  const store = guides.store, guideHeights = guides.heights, guideRadii = guides.radii;
  xyz[0] = root[0]; xyz[1] = root[1]; xyz[2] = root[2]; heights[0] = 0;
  for (let p = 1; p < pointCount; p += 1) {
    const s = (p / segments) * length;
    // Blend directions and radii about the head centre separately, so
    // diverging guides never average into a chord through the head.
    let vx = 0, vy = 0, vz = 0, radius = 0, h = 0, wsum = 0, gx = 0, gy = 0, gz = 0, gr = 0;
    for (let k = 0; k < blended; k += 1) {
      const info = k * 5;
      // A guide shorter than this point fades out instead of being extrapolated.
      let w = weights[k];
      if (s > guideInfo[info + 1]) {
        const f = Math.min((s - guideInfo[info + 1]) / (guideInfo[info] - guideInfo[info + 1]), 1);
        w *= 1 - 0.97 * f * f * (3 - 2 * f);
      }
      if (k === 0) w += 1e-9;
      // Linear sample of the guide at arc length s (extrapolated past its end).
      const fs = s * guideInfo[info + 2];
      const last = guideInfo[info + 3];
      const segment = fs < last ? Math.floor(fs) : last;
      const t = fs - segment;
      const base = guideInfo[info + 4] + segment;
      const o = base * 3;
      const qx = store[o] + (store[o + 3] - store[o]) * t - CX;
      const qy = store[o + 1] + (store[o + 4] - store[o + 1]) * t - CY;
      const qz = store[o + 2] + (store[o + 5] - store[o + 2]) * t - CZ;
      h += w * (guideHeights[base] + (guideHeights[base + 1] - guideHeights[base]) * (t < 1 ? t : 1));
      const qr = guideRadii[base] + (guideRadii[base + 1] - guideRadii[base]) * t;
      if (k === clumpGuide) { gx = qx; gy = qy; gz = qz; gr = qr; }
      const m = k * 10;
      vx += w * (rotations[m] * qx + rotations[m + 1] * qy + rotations[m + 2] * qz);
      vy += w * (rotations[m + 3] * qx + rotations[m + 4] * qy + rotations[m + 5] * qz);
      vz += w * (rotations[m + 6] * qx + rotations[m + 7] * qy + rotations[m + 8] * qz);
      radius += w * qr * rotations[m + 9];
      wsum += w;
    }
    radius /= wsum; h /= wsum;
    // Clump: pull towards the clump guide's own curve, strongest at the tip
    // (v / radius and g / gr are both unit-length directions up to guide spread).
    const pull = gr > 0 ? clump * clumpProfile[p] : 0;
    const keep = (1 - pull) / (wsum * radius || 1), towards = pull / (gr || 1);
    vx = vx * keep + gx * towards; vy = vy * keep + gy * towards; vz = vz * keep + gz * towards;
    radius += (gr - radius) * pull;
    const scale = radius / (Math.sqrt(vx * vx + vy * vy + vz * vz) || 1);
    xyz[p * 3] = CX + vx * scale; xyz[p * 3 + 1] = CY + vy * scale; xyz[p * 3 + 2] = CZ + vz * scale;
    heights[p] = h;
  }
  // Offsets across the strand: a smooth random deviation (per-strand cubic),
  // curl or wave (phase recurrences), flyaway lift and the random layer.
  const frizz = groom.frizz / 1000 * (flyaway ? 5 : baby ? 0.6 : 1) * (0.5 + frizzDraw);
  const a1 = (a1Draw - 0.5) * 2 * frizz, a2 = (a2Draw - 0.5) * 2 * frizz, b1 = (b1Draw - 0.5) * 1.2 * frizz, b2 = (b2Draw - 0.5) * 1.2 * frizz;
  const clumpId = clumpGuide >= 0 ? ids[clumpGuide] : ids[0];
  const clumpRandom = (k) => hashUnit(seed, clumpId, salt ^ k);
  let curlRadius = 0, curlCos = 1, curlSin = 0, curlStepCos = 1, curlStepSin = 0;
  if (groom.curl) {
    curlRadius = groom.curl[0] / 1000 * (0.75 + 0.5 * curlRadiusDraw);
    const pitch = groom.curl[1] / 1000 * (0.8 + 0.4 * clumpRandom(0x94d049bb));
    const phase = (clumpRandom(0x4cf5ad43) + 0.25 * curlPhaseDraw) * TAU;
    const delta = (length / segments / pitch) * TAU;
    curlCos = Math.cos(phase); curlSin = Math.sin(phase);
    curlStepCos = Math.cos(delta); curlStepSin = Math.sin(delta);
  }
  let waveAmplitude = 0, waveCos = 1, waveSin = 0, waveStepCos = 1, waveStepSin = 0;
  if (groom.wave) {
    waveAmplitude = groom.wave[0] / 1000 * (0.7 + 0.6 * clumpRandom(0x62a9d9ed));
    const wavelength = groom.wave[1] / 1000 * (0.85 + 0.3 * clumpRandom(0x6c8e9cf5));
    const phase = clumpRandom(0x1b56c4e9) * TAU, delta = (length / segments / wavelength) * TAU;
    waveCos = Math.cos(phase); waveSin = Math.sin(phase);
    waveStepCos = Math.cos(delta); waveStepSin = Math.sin(delta);
  }
  headLookup(map, root[0] - CX, root[1] - CY, root[2] - CZ);
  const layerOffset = (layerDraw - 0.6) * 0.35 * map.lookup[0];
  // Offsets towards the head (a negative layer, curls) widen the margin that triggers a collision check.
  const margin = 0.006 + Math.max(-layerOffset, 0) + curlRadius + frizz * 1.5;
  const jersey = context.jersey;
  boost[0] = 0;
  for (let p = 1; p < pointCount; p += 1) {
    const u = p / segments;
    const s = u * length;
    // Advance the curl and wave phases by one segment.
    let next = curlCos * curlStepCos - curlSin * curlStepSin;
    curlSin = curlSin * curlStepCos + curlCos * curlStepSin; curlCos = next;
    next = waveCos * waveStepCos - waveSin * waveStepSin;
    waveSin = waveSin * waveStepCos + waveCos * waveStepSin; waveCos = next;
    const a = p - 1, c = p < segments ? p + 1 : segments;
    let dx = xyz[c * 3] - xyz[a * 3], dy = xyz[c * 3 + 1] - xyz[a * 3 + 1], dz = xyz[c * 3 + 2] - xyz[a * 3 + 2];
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    const rx = xyz[p * 3] - CX, ry = xyz[p * 3 + 1] - CY, rz = xyz[p * 3 + 2] - CZ;
    // side = tangent x radial, up = side x tangent.
    let sx = dy * rz - dz * ry, sy = dz * rx - dx * rz, sz = dx * ry - dy * rx;
    const sl = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
    sx /= sl; sy /= sl; sz /= sl;
    const ux = sy * dz - sz * dy, uy = sz * dx - sx * dz, uz = sx * dy - sy * dx;
    const u2 = u * u;
    let across = a1 * u2 + a2 * u2 * u;
    let up = b1 * u2 + b2 * u2 * u + (flyaway ? frizz * 0.5 * u2 : 0);
    if (curlRadius > 0) {
      const ramp = s >= 0.006 ? 1 : (s / 0.006) * (s / 0.006) * (3 - 2 * (s / 0.006));
      across += curlRadius * ramp * curlCos;
      up += curlRadius * ramp * curlSin;
    }
    if (waveAmplitude > 0) across += waveAmplitude * smoothstep(0.03, 0.09, s) * waveSin;
    up += layerOffset * (s >= 0.012 ? 1 : smoothstep(0, 0.012, s));
    const px = xyz[p * 3] + sx * across + ux * up;
    const py = xyz[p * 3 + 1] + sy * across + uy * up;
    const pz = xyz[p * 3 + 2] + sz * across + uz * up;
    xyz[p * 3] = px; xyz[p * 3 + 1] = py; xyz[p * 3 + 2] = pz;
    // Safety: every non-root point keeps its clearance above the skin (always
    // checked near the surface, and within 2 cm of the ears and the neck,
    // where the collision proxy is irregular).
    const height = heights[p];
    if (crossed || height < margin || (py < 0.315 && height < 0.02)) {
      collision.reach = s >= 0.015 ? 1 : smoothstep(0, 0.015, s);
      keepOutside(collision, xyz, p * 3, CLEARANCE);
      collision.reach = 1;
    }
    if (context.neck && py < 0.28) keepOutsideNeck(context.neck, xyz, p * 3, 0.001);
    if (jersey && xyz[p * 3 + 1] < 0.24) {
      const top = jerseyHeight(jersey, xyz[p * 3], xyz[p * 3 + 2]);
      if (top > 0 && xyz[p * 3 + 1] < top + 0.003) {
        xyz[p * 3 + 1] = top + 0.003;
        // Lifted onto the collar under the jaw: the head surface wins.
        keepOutside(collision, xyz, p * 3, CLEARANCE);
      }
    }
    // Hanging hair (below the ear tops, or standing off the scalp) has no
    // painted scalp behind it: wider ribbons keep its coverage.
    if (hang > 0) {
      const off = Math.max(1 - smoothstep(0.27, 0.3, xyz[p * 3 + 1]), smoothstep(0.012, 0.025, height));
      boost[p] = hang * off * smoothstep(0.015, 0.035, s);
    }
  }
  // AO root: the dominant corner of the root triangle.
  let corner = 0;
  for (let k = 1; k < 3; k += 1) if (scalp.candidateBary[slot * 3 + k] > scalp.candidateBary[slot * 3 + corner]) corner = k;
  const halfWidth = groom.width / 1000 * (0.8 + 0.4 * widthDraw) * (baby ? 0.55 : flyaway ? 0.6 : lerp(1, 0.75, hairline));
  // Visibility: strands deeper in the volume (lower layer) stay darker along their length.
  buffers.add(tier, xyz, pointCount, scalp.candidateTri[slot * 3 + corner], strandRandom, baby ? KIND.baby : flyaway ? KIND.flyaway : KIND.scalp, halfWidth, 0.82, 0.5 + 0.3 * layerDraw, false, 0.62 + 0.38 * layerDraw, hang > 0 ? boost : null);
  return baby;
}

/* ------------------------------------------------------------------------ */
/* Bun and braids                                                            */
/* ------------------------------------------------------------------------ */

const BUN_POINTS = 21;

/** Bun wrap: strand count per tier and their point totals. */
function bunPlanOf(groom, lod) {
  const reduced = Math.round(groom.bun.strands * GNM_PLAYER_HAIR.reducedFraction);
  const count = lod === "reduced" ? reduced : groom.bun.strands;
  return { reduced, count, points: [reduced * BUN_POINTS, (count - reduced) * BUN_POINTS] };
}

/** Coiled bun: strands wound as flattened spirals over the bun core. */
function addBun(context, collision, buffers, plan) {
  const { groom, bun, seed, salt } = context;
  const xyz = new Float64Array(BUN_POINTS * 3);
  // Bun frame: its axis out of the head and two perpendicular directions.
  const [ax, ay, az] = bun.normal;
  const e1Length = Math.hypot(az, ax) || 1;
  const e1 = [-az / e1Length, 0, ax / e1Length];
  const e2 = [ay * e1[2] - az * e1[1], az * e1[0] - ax * e1[2], ax * e1[1] - ay * e1[0]];
  for (let index = 0; index < plan.count; index += 1) {
    const r = (k) => hashUnit(seed, index, salt ^ k);
    const turns = groom.bun.turns * (0.7 + 0.6 * r(11));
    const start = r(12) * TAU;
    const layer = r(13);
    const tilt = (r(14) - 0.5) * 0.9;
    const crown = 0.25 + 0.2 * r(15);
    for (let p = 0; p < BUN_POINTS; p += 1) {
      const t = p / (BUN_POINTS - 1);
      const angle = start + t * turns * TAU;
      // Spiral from the rim of the bun towards its crown.
      const polar = lerp(1.35, crown, t) + tilt * Math.sin(angle * 0.5);
      const radius = bun.radius * (0.99 + 0.12 * layer) * (1 + 0.04 * Math.sin(angle * 3 + start));
      const sinP = Math.sin(polar), cosP = Math.cos(polar), cosA = Math.cos(angle), sinA = Math.sin(angle);
      xyz[p * 3] = bun.center[0] + (e1[0] * cosA * sinP + e2[0] * sinA * sinP + ax * cosP * 0.9) * radius;
      xyz[p * 3 + 1] = bun.center[1] + (e1[1] * cosA * sinP + e2[1] * sinA * sinP + ay * cosP * 0.9) * radius * 0.9;
      xyz[p * 3 + 2] = bun.center[2] + (e1[2] * cosA * sinP + e2[2] * sinA * sinP + az * cosP * 0.9) * radius;
      keepOutside(collision, xyz, p * 3, 0.0005);
    }
    const halfWidth = groom.width / 1000 * (0.8 + 0.4 * r(16));
    buffers.add(index < plan.reduced ? 0 : 1, xyz, BUN_POINTS, bun.rootVertex, r(17), KIND.bun, halfWidth, 0.3, 0.72 + 0.28 * layer, true);
  }
}

/** Cornrow paths over the head (and their point counts) before any strand is written. */
function braidPlanOf(context, map, positions, lod) {
  const { groom, rows, scalp } = context;
  const fibers = groom.braids.fibers;
  const reducedFibers = Math.max(3, Math.round(fibers * GNM_PLAYER_HAIR.reducedFraction + 0.5));
  const usedFibers = lod === "reduced" ? reducedFibers : fibers;
  const pathSamples = 96;
  const points = [0, 0];
  const paths = rows.map((row) => {
    const path = new Float64Array(pathSamples * 3);
    const normal = new Float64Array(pathSamples * 3);
    let pathLength = 0;
    for (let k = 0; k < pathSamples; k += 1) {
      const t = k / (pathSamples - 1);
      const theta = lerp(row.thetaFront, row.thetaBack, t);
      const lambda = rowLambda(row, t);
      const dx = Math.sin(lambda), c = Math.cos(lambda);
      const dy = Math.cos(theta) * c, dz = Math.sin(theta) * c;
      const radius = headLookup(map, dx, dy, dz) + row.halfWidth * 0.55;
      path[k * 3] = CX + dx * radius; path[k * 3 + 1] = CY + dy * radius; path[k * 3 + 2] = CZ + dz * radius;
      normal[k * 3] = dx; normal[k * 3 + 1] = dy; normal[k * 3 + 2] = dz;
      if (k > 0) pathLength += Math.hypot(path[k * 3] - path[k * 3 - 3], path[k * 3 + 1] - path[k * 3 - 2], path[k * 3 + 2] - path[k * 3 - 1]);
    }
    const total = pathLength + row.tail;
    const count = Math.min(220, Math.ceil(total / (row.period / 5)) + 1);
    points[0] += 3 * reducedFibers * count;
    points[1] += 3 * (usedFibers - reducedFibers) * count;
    return { path, normal, pathLength, total, count, rootVertex: nearestRootVertex(scalp, positions, path[0], path[1], path[2]) };
  });
  return { paths, pathSamples, fibers: usedFibers, reducedFibers, points };
}

/**
 * Cornrows: rows running from the front hairline over the crown to the
 * nape, each a three-strand plait (figure-eight weave) of fibre bundles,
 * continuing as hanging braids below the nape.
 */
function addBraids(context, collision, buffers, plan) {
  const { groom, seed, salt, rows } = context;
  const { pathSamples } = plan;
  rows.forEach((row, rowIndex) => {
    const { path, normal: pathNormal, pathLength, total, count: points, rootVertex } = plan.paths[rowIndex];
    const xyz = new Float64Array(points * 3);
    const end = (pathSamples - 1) * 3;
    for (let bundle = 0; bundle < 3; bundle += 1) {
      for (let fiber = 0; fiber < plan.fibers; fiber += 1) {
        const index = (rowIndex * 3 + bundle) * 64 + fiber;
        const q = (k) => hashUnit(seed, index, salt ^ k);
        const angle = q(7) * TAU, spread = Math.sqrt(q(8)) * row.halfWidth * 0.34;
        const offsetA = Math.cos(angle) * spread, offsetB = Math.sin(angle) * spread;
        for (let p = 0; p < points; p += 1) {
          const s = (p / (points - 1)) * total;
          let cx, cy, cz, nx, ny, nz, tx, ty, tz;
          if (s <= pathLength) {
            const f = (s / pathLength) * (pathSamples - 1);
            const k = Math.min(Math.floor(f), pathSamples - 2), t = f - k;
            cx = lerp(path[k * 3], path[k * 3 + 3], t); cy = lerp(path[k * 3 + 1], path[k * 3 + 4], t); cz = lerp(path[k * 3 + 2], path[k * 3 + 5], t);
            nx = pathNormal[k * 3]; ny = pathNormal[k * 3 + 1]; nz = pathNormal[k * 3 + 2];
            tx = path[k * 3 + 3] - path[k * 3]; ty = path[k * 3 + 4] - path[k * 3 + 1]; tz = path[k * 3 + 5] - path[k * 3 + 2];
          } else {
            // Hanging tail: down and slightly back from the nape end.
            const hang = s - pathLength;
            cx = path[end]; cy = path[end + 1] - hang; cz = path[end + 2] - hang * 0.12;
            nx = 0; ny = 0; nz = -1; tx = 0; ty = -1; tz = -0.12;
          }
          const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
          tx /= tl; ty /= tl; tz /= tl;
          // Across the row = tangent x normal; up = the normal.
          let sx = ty * nz - tz * ny, sy = tz * nx - tx * nz, sz = tx * ny - ty * nx;
          const sl = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
          sx /= sl; sy /= sl; sz /= sl;
          const grow = smoothstep(0, 0.045, s) * (1 - 0.35 * smoothstep(pathLength, total, s));
          const weave = (s / row.period) * TAU + row.phase + bundle * (TAU / 3);
          const across = (Math.sin(weave) * row.halfWidth * 0.55 + offsetA) * lerp(0.35, 1, grow);
          const up = (Math.sin(2 * weave) * row.halfWidth * 0.28 + offsetB) * lerp(0.3, 1, grow);
          xyz[p * 3] = cx + sx * across + nx * up;
          xyz[p * 3 + 1] = cy + sy * across + ny * up;
          xyz[p * 3 + 2] = cz + sz * across + nz * up;
          keepOutside(collision, xyz, p * 3, 0.0004);
        }
        buffers.add(fiber < plan.reducedFibers ? 0 : 1, xyz, points, rootVertex, q(10), KIND.braid, groom.width / 1000 * 1.4 * (0.8 + 0.4 * q(9)), -1, 0.66 + 0.3 * q(11), true);
      }
    }
  });
}

/** Candidate root vertex nearest to a point (the AO texel of a structure). */
function nearestRootVertex(scalp, positions, x, y, z) {
  let best = scalp.candidateTri[0], distance = Infinity;
  for (let slot = 0; slot < scalp.candidateCount; slot += 7) {
    const vertex = scalp.candidateTri[slot * 3];
    const d = (positions[vertex * 3] - x) ** 2 + (positions[vertex * 3 + 1] - y) ** 2 + (positions[vertex * 3 + 2] - z) ** 2;
    if (d < distance) { distance = d; best = vertex; }
  }
  return best;
}

/* Shared with the beard and eyebrow strands (gnm-player-facial-hair.js). */
export { StrandBuffers, RandomStream, hashUnit, mix32, stringSalt, valueNoise, createGrid };
