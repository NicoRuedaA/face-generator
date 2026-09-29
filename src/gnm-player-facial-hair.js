/*
 * Sports Face GNM 3D player beard and eyebrows
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * DOM/WebGL-free strand beards and eyebrows shared by the WebGL2 renderer and
 * the tests. Strands use the scalp hair's ribbon layout and buffers (see
 * gnm-player-hair.js), so the same fibre shading, pigment gating, greying,
 * strand shadows, root AO, alpha-to-coverage and levels of detail apply.
 *
 * Once per asset, buildGnmPlayerFacialHairStatic() indexes the skin of the
 * brow and beard zones: walkable triangles with their edge neighbours
 * (welded across UV seams by official source vertex), stratified root
 * candidates in a fixed shuffled order (any prefix is a spatially uniform
 * subset, which gives the reduced level of detail) and blue-noise clump
 * seeds for the beard.
 *
 * Per reconstructed frame, a style accepts candidates by a soft density
 * field and grows each strand by walking the deformed skin (straightest
 * geodesics across triangle edges) through a growth field:
 *
 * - eyebrows follow the official brow fields: head hairs point up and
 *   slightly out, body hairs up and out (steeper from the lower edge,
 *   flatter from the upper edge, so they converge), tail hairs out and
 *   down along the style's arch; fine and stray hairs break the edges;
 * - beards follow regional rules: down on the cheeks, down and forward on
 *   the chin, down and out on the moustache, back under the jaw and down
 *   the neck with a swirl; they clump towards seed strands, and the full
 *   beard stands off the skin with volume that breaks the jawline.
 *
 * Each point sits at a lift profile above the skin along the interpolated
 * normal, so strands follow every identity and expression and never
 * penetrate the skin; walks stop at the lips, the mouth, the zone borders
 * and above the collar. Everything is deterministic (integer hashes and
 * per-strand xorshift streams, never an unseeded generator): the same
 * profile gives the same strands, the seed varies them, and nothing is
 * periodic.
 */

import { GNM_PLAYER_HAIR, StrandBuffers, RandomStream, hashUnit, mix32, stringSalt, valueNoise, createGrid } from "./gnm-player-hair.js";

/** Facial hair constants (lengths in millimetres unless the name says otherwise). */
export const GNM_PLAYER_FACIAL_HAIR = Object.freeze({
  version: "strand-facial-hair-v1",
  model: "surface-walked-clumped-strands",
  /** Strand kinds (surface.w, the hair shader's coverage classes): terminal hair, stray, fine (vellus) hair. */
  kinds: Object.freeze({ terminal: 0, stray: 1, fine: 2 }),
  /** Root candidates per mm² of skin. */
  candidateDensity: Object.freeze({ brow: 5, beard: 1 }),
  /** Beard clump seeds (blue noise, mm apart). */
  clumpSpacingMm: 4.2,
  /** Fraction of the candidate order in the reduced level of detail (thumbnails, direct fallback). */
  reducedFraction: GNM_PLAYER_HAIR.reducedFraction,
  /** Minimum height of every non-root point above the skin. */
  clearanceMm: 0.06,
  /** Beard points stay this far above the jersey's collar plane. */
  collarMarginMm: 5,
});

const KIND = GNM_PLAYER_FACIAL_HAIR.kinds;
const DEG = Math.PI / 180;
const CLEARANCE = GNM_PLAYER_FACIAL_HAIR.clearanceMm / 1000;
const ZONE = Object.freeze({ brow: 1, beard: 2 });

function clamp(value, low, high) { return value < low ? low : value > high ? high : value; }
function smoothstep(edge0, edge1, value) { const t = clamp((value - edge0) / (edge1 - edge0), 0, 1); return t * t * (3 - 2 * t); }
function lerp(a, b, t) { return a + (b - a) * t; }

/* ------------------------------------------------------------------------ */
/* Grooms                                                                    */
/* ------------------------------------------------------------------------ */

/*
 * Eyebrow grooms: the catalog shape (thickness, arch, peak, length, density,
 * angular, offset) places the roots; the groom sets the hairs. `fill` is the
 * accepted fraction of candidates in the core, `length` the body hair length
 * (head and tail hairs are shorter), `angleJitter` the per-hair angle
 * spread (degrees), `lift` the emergence angle range (degrees), `layer` the
 * lying height range (mm), `width` the root half-width (mm), `fine`/`stray`
 * the fractions of fine and stray hairs, `follow` how much a hair turns
 * with the local growth field, `core`/`edgeJitter` the solid part of the
 * band and the irregularity of its edges, `underlay` the faint root tint
 * of the skin under dense hair.
 */
const BROW_BASE = Object.freeze({
  fill: 0.62, segments: 4, length: 6.2, headLength: 4.2, tailLength: 5.2, jitter: 0.3, angleJitter: 6, lift: Object.freeze([6, 16]), layer: Object.freeze([0.12, 0.6]),
  width: 0.034, taper: 0.86, fine: 0.14, stray: 0.02, follow: 0.3, core: 0.82, edgeJitter: 0.34, underlay: 0.2, tipFade: 0.6, roughness: 0.19,
});

/** Groom per brow catalog asset. */
export const GNM_PLAYER_BROW_GROOMS = Object.freeze({
  "brows/soft": Object.freeze({ label: "soft natural", fill: 0.72, width: 0.031, fine: 0.2, edgeJitter: 0.4, underlay: 0.18 }),
  "brows/flat": Object.freeze({ label: "flat straight", fill: 0.74 }),
  "brows/arched": Object.freeze({ label: "high arch", fill: 0.72, length: 5.8 }),
  "brows/thick": Object.freeze({ label: "thick full", fill: 0.7, length: 7, width: 0.038, layer: Object.freeze([0.15, 0.75]), underlay: 0.26 }),
  "brows/short": Object.freeze({ label: "short", fill: 0.74, tailLength: 4.6 }),
  "brows/angular": Object.freeze({ label: "angular peak", fill: 0.74, follow: 0.36 }),
  "brows/low": Object.freeze({ label: "low set", fill: 0.72 }),
  "brows/high": Object.freeze({ label: "high set", fill: 0.72, width: 0.032 }),
});

/*
 * Beard grooms. `mode`: "stubble" (straight stubs) or "walk" (surface-walked
 * strands). `fill` is the accepted fraction of candidates in the core
 * (scaled by the catalog density); `length` is mm by region (cheek, jaw,
 * chin, moustache, neck); `angleJitter` the per-strand angle spread
 * (degrees); `lift` the emergence angle range (degrees); `height` the lying
 * height of the volume (mm); `clump` the pull of the tips towards their
 * clump seed; `frizz` the smooth random deviation at the tip (mm); `wave`
 * amplitude and wavelength (mm); `reach` raises the cheek line and lowers
 * the neckline (mm); `lipStop` the lip-mask range where strands stop;
 * `underlay` the root tint (and `follicles` the stubble darkening) of the
 * skin under the hair, graded by the same density.
 */
const BEARD_BASE = Object.freeze({
  mode: "walk", fill: 0.4, segments: 5, length: Object.freeze([5, 6, 7, 7, 4.5]), jitter: 0.3, angleJitter: 14, lift: Object.freeze([24, 38]), height: 1.8,
  width: 0.05, taper: 0.55, clump: 0.25, clumpPower: 1.4, frizz: 0.3, wave: null, follow: 0.35, full: 1, moustache: 1, goatee: 1, reach: 0,
  edgeJitter: 2.6, stray: 0.012, fine: 0.06, underlay: 0.36, follicles: 0.25, tipFade: 0.74, roughness: 0.22, lipStop: Object.freeze([0.3, 0.6]), cheekVolume: 0.6,
});

/** Groom per beard catalog asset ("beard/none" has none). */
export const GNM_PLAYER_BEARD_GROOMS = Object.freeze({
  "beard/stubble": Object.freeze({ label: "three-day stubble", mode: "stubble", fill: 0.52, segments: 2, length: Object.freeze([0.95, 1.05, 1.2, 1.15, 0.85]), jitter: 0.35, angleJitter: 18, lift: Object.freeze([38, 68]), height: 0, width: 0.045, taper: 0.22, clump: 0, frizz: 0, fine: 0.1, stray: 0, underlay: 0.26, follicles: 0.72, tipFade: 0.999, reach: 0 }),
  "beard/short": Object.freeze({ label: "short boxed beard", fill: 0.3, segments: 3, length: Object.freeze([4.2, 5.2, 6.6, 6.8, 4]), angleJitter: 9, lift: Object.freeze([20, 34]), height: 1.7, width: 0.054, clump: 0.3, frizz: 0.3, reach: 2, underlay: 0.42, follicles: 0.35 }),
  "beard/full": Object.freeze({ label: "full beard", fill: 0.25, segments: 5, length: Object.freeze([15, 23, 32, 11, 13]), jitter: 0.24, lift: Object.freeze([26, 42]), height: 8.5, cheekVolume: 0.38, width: 0.068, taper: 0.6, clump: 0.5, clumpPower: 1.2, frizz: 1.1, wave: Object.freeze([0.8, 11]), reach: 7, edgeJitter: 3.4, stray: 0.015, underlay: 0.5, follicles: 0.25, tipFade: 0.84, roughness: 0.25 }),
  "beard/goatee": Object.freeze({ label: "goatee and moustache", full: 0, fill: 0.55, segments: 6, length: Object.freeze([8, 9, 15, 10, 8]), lift: Object.freeze([22, 36]), height: 3.4, clump: 0.36, frizz: 0.6, wave: Object.freeze([0.4, 9]), reach: 2, underlay: 0.44, follicles: 0.3 }),
  "beard/moustache": Object.freeze({ label: "moustache", full: 0, goatee: 0, fill: 0.85, segments: 6, length: Object.freeze([9, 9, 9, 10, 9]), angleJitter: 10, lift: Object.freeze([16, 28]), height: 2.2, clump: 0.5, frizz: 0.4, reach: 0, underlay: 0.44, follicles: 0.3 }),
});

/** Resolved brow groom of a catalog brow style. */
export function gnmPlayerBrowGroom(style) {
  if (!style) return null;
  const groom = GNM_PLAYER_BROW_GROOMS[style.asset] ?? GNM_PLAYER_BROW_GROOMS["brows/soft"];
  return Object.freeze({ ...BROW_BASE, ...groom, asset: style.asset });
}

/** Resolved beard groom of a catalog beard style (null for "beard/none"). */
export function gnmPlayerBeardGroom(style) {
  if (!style || !(style.density > 0)) return null;
  const groom = GNM_PLAYER_BEARD_GROOMS[style.asset];
  if (!groom) return null;
  return Object.freeze({ ...BEARD_BASE, ...groom, asset: style.asset, density: style.density });
}

/* ------------------------------------------------------------------------ */
/* Density fields (roots and the skin underlay share them)                  */
/* ------------------------------------------------------------------------ */

/**
 * Catalog brow shape at browT = t, written into `out`: [centre offset (mm,
 * on browD), half-thickness (mm), d(centre)/dt (mm per unit t), extent along
 * the brow (0..1)]. Mirrors the retired painted brow.
 */
export function gnmPlayerBrowShape(style, t, out = new Float64Array(4)) {
  const peak = style.peak;
  const span = Math.max(peak, 1 - peak);
  const u = (t - peak) / span;
  const distance = Math.abs(u);
  out[0] = style.arch * (1 - (style.angular ? distance : distance * distance)) - 0.6 + (style.offset || 0);
  out[1] = style.thickness * 0.5 * lerp(1, 0.42, smoothstep(0.5, 1.05, t)) * lerp(0.82, 1, smoothstep(-0.05, 0.18, t));
  out[2] = -style.arch * (style.angular ? Math.sign(u) : 2 * u) / span;
  out[3] = smoothstep(-0.08, 0.04, t) * (1 - smoothstep(style.length - 0.1, style.length + 0.02, t));
  return out;
}

const SHAPE = new Float64Array(4);
/**
 * Brow hair density (0..1) at brow coordinates (t, d mm) with an edge noise
 * value (0..1): roots stop short of the catalog length (the hairs reach
 * it), the band is a little narrower than the catalog thickness (hairs
 * grow across it), and the edges are irregular with a few sparse strays.
 */
export function gnmPlayerBrowDensity(style, groom, t, d, noise) {
  if (t < -0.2 || t > style.length + 0.05) return 0;
  const shape = gnmPlayerBrowShape(style, t, SHAPE);
  const along = smoothstep(-0.07, 0.05, t) * (1 - smoothstep(style.length - 0.2, style.length - 0.03, t));
  if (along <= 0) return 0;
  const q = Math.abs(d - shape[0]) / Math.max(shape[1], 0.4);
  const edge = groom.core + (noise - 0.5) * groom.edgeJitter;
  let across = 1 - smoothstep(edge - 0.32, edge + 0.12, q);
  // Sparse stray hairs just outside the edge (never a stencilled outline).
  across += 0.07 * (1 - smoothstep(1.0, 1.55, q)) * smoothstep(0.3, 0.7, noise);
  const head = lerp(0.7, 1, smoothstep(0.0, 0.16, t));
  const tail = lerp(1, 0.6, smoothstep(0.62, 1.0, t / style.length));
  return clamp(along * Math.min(across, 1) * head * tail, 0, 1) * style.density;
}

/**
 * Beard hair density (0..1) from the official beard and mouth fields (mm),
 * an edge noise value (0..1) and the static posterior gate (see
 * buildGnmPlayerFacialHairStatic): the full-beard region under a soft,
 * irregular cheek line and above a soft neckline, the moustache over the
 * upper lip up to the nostrils, the chin goatee and the links around the
 * mouth corners; never on the lips or inside the mouth.
 */
export function gnmPlayerBeardDensity(groom, upper, lower, dx, dy, front, lip, mouthSock, noise, posterior = 1) {
  // The official lip mask is smoothed a few millimetres past the red lip:
  // hair grows up to where the red lip begins (the shader's lip colour).
  if (mouthSock > 0.2 || lip > 0.4) return 0;
  const lipGate = 1 - smoothstep(0.14, 0.34, lip);
  const jitter = (noise - 0.5) * 2 * groom.edgeJitter;
  const adx = Math.abs(dx);
  let full = 0;
  if (groom.full) {
    const cheek = 1 - smoothstep(-8.5, 1.5, upper - groom.reach + 4.5 + jitter);
    const neck = smoothstep(-7, 4, lower + groom.reach - 1.5 + jitter);
    full = cheek * neck * posterior * smoothstep(0.08, 0.42, front + (noise - 0.5) * 0.14);
    // Sparser towards the cheek line and down the neck, densest on the chin and jaw.
    full *= lerp(0.72, 1, smoothstep(-16, -4, -upper + groom.reach)) * lerp(0.78, 1, smoothstep(0, 14, lower + groom.reach));
  }
  const frontGate = smoothstep(0.55, 0.8, front);
  let moustache = 0, goatee = 0;
  if (groom.moustache) {
    moustache = smoothstep(5, 9, dy) * (1 - smoothstep(19.5, 23, dy + adx * 0.14 + jitter * 0.3)) * (1 - smoothstep(22, 29, adx + Math.max(dy - 15, 0) * 0.5 + jitter * 0.5));
  }
  if (groom.goatee) {
    const chin = (1 - smoothstep(11, 19, adx + Math.max(-dy - 30, 0) * 0.5 + jitter * 0.5)) * smoothstep(-51, -42, dy + jitter * 0.5) * (1 - smoothstep(-10, -6, dy));
    const link = (1 - smoothstep(2.5, 6.5, Math.abs(adx - (22 + dy * 0.1)) + jitter * 0.3)) * smoothstep(-33, -22, dy) * (1 - smoothstep(4, 10, dy));
    goatee = Math.max(chin, link);
  }
  return clamp(Math.max(full, frontGate * Math.max(moustache, goatee)) * lipGate, 0, 1);
}

/* ------------------------------------------------------------------------ */
/* Static zone data                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Static per-asset facial hair data. `positions` are template render
 * positions, `sourceIds` the official source vertex of each render vertex,
 * `skinTriangles` render-vertex skin triangles, `fields` per-render-vertex
 * official fields (browT, browD, beardUpper, beardLower, mouthDX, mouthDY,
 * scalpFront, lip, mouthSock, ear, eyeSocket) and `landmarks` the template
 * landmarks (68 x 3).
 */
export function buildGnmPlayerFacialHairStatic({ positions, sourceIds, skinTriangles, fields, landmarks }) {
  const f = fields;
  const renderCount = positions.length / 3;
  const lm = (index, axis) => landmarks[index * 3 + axis];
  // Template gates: brows stay above the upper lids; the moustache stays below the nostrils.
  const lidTop = [Math.max(lm(37, 1), lm(38, 1)), Math.max(lm(43, 1), lm(44, 1))];
  const subnasale = lm(33, 1);
  const alarX = Math.max(Math.abs(lm(31, 0)), Math.abs(lm(35, 0)));
  // Posterior gate of the beard: the official neck line follows the jaw
  // contour (landmarks 2..14) only, so below the jaw angle the beard ends
  // at the jaw angle's azimuth about the ear axis (the neckline curves up
  // behind it towards the earlobe); above it the front gate applies.
  const azimuthOf = (x, z) => Math.atan2(Math.abs(x), z - 0.017451);
  const jawAngle = [2, 14].map((index) => ({ azimuth: azimuthOf(lm(index, 0), lm(index, 2)), y: lm(index, 1) }));
  const posterior = new Float32Array(renderCount);
  const vertexZone = new Uint8Array(renderCount);
  const noise = new Float32Array(renderCount);
  const browVertices = [];
  const beardVertices = [];
  for (let v = 0; v < renderCount; v += 1) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    let zone = 0;
    if (f.browT[v] > -0.35 && f.browT[v] < 1.5 && f.browD[v] > -14 && f.browD[v] < 16 && f.scalpFront[v] > 0.3 && f.eyeSocket[v] < 0.35 && f.ear[v] < 0.2 && y > lidTop[x < 0 ? 0 : 1] + 0.0015) zone |= ZONE.brow;
    const nose = y > subnasale - 0.0008 && Math.abs(x) < alarX + 0.005;
    if (f.ear[v] < 0.35 && f.eyeSocket[v] < 0.2 && f.mouthSock[v] < 0.5 && f.beardUpper[v] < 18 && f.beardLower[v] > -24 && f.scalpFront[v] > -0.15 && !nose) zone |= ZONE.beard;
    vertexZone[v] = zone;
    if (!zone) continue;
    // Static edge noise per render vertex (template position, ~4 mm lattice).
    noise[v] = valueNoise(x * 260, y * 260, z * 260, 0x1f83d9ab);
    // Below the jaw angle the edge slants forward and is as irregular as the others.
    const jaw = jawAngle[x < 0 ? 0 : 1];
    const edge = jaw.azimuth - 5 * Math.max(jaw.y - y, 0) + (noise[v] - 0.5) * 0.08;
    posterior[v] = lerp(1 - smoothstep(edge - 0.09, edge + 0.05, azimuthOf(x, z)), 1, smoothstep(jaw.y - 0.004, jaw.y + 0.008, y));
    if (zone & ZONE.brow) browVertices.push(v);
    if (zone & ZONE.beard) beardVertices.push(v);
  }
  // Walkable triangles of both zones.
  const triList = [];
  const zoneList = [];
  const areaList = [];
  for (let item = 0; item < skinTriangles.length; item += 3) {
    const a = skinTriangles[item], b = skinTriangles[item + 1], c = skinTriangles[item + 2];
    const zone = vertexZone[a] & vertexZone[b] & vertexZone[c];
    if (!zone) continue;
    const abx = positions[b * 3] - positions[a * 3], aby = positions[b * 3 + 1] - positions[a * 3 + 1], abz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const acx = positions[c * 3] - positions[a * 3], acy = positions[c * 3 + 1] - positions[a * 3 + 1], acz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const area = 0.5 * Math.sqrt((aby * acz - abz * acy) ** 2 + (abz * acx - abx * acz) ** 2 + (abx * acy - aby * acx) ** 2);
    if (!(area > 1e-10)) continue;
    triList.push(a, b, c);
    zoneList.push(zone);
    areaList.push(area);
  }
  const triCount = zoneList.length;
  const tri = Uint32Array.from(triList);
  const zone = Uint8Array.from(zoneList);
  // Edge neighbours (edge k is opposite corner k), welded by source vertex.
  const neighbor = new Int32Array(triCount * 3).fill(-1);
  const neighborCorners = new Uint8Array(triCount * 6);
  const owners = new Map();
  const cornerOf = (t, source) => (sourceIds[tri[t * 3]] === source ? 0 : sourceIds[tri[t * 3 + 1]] === source ? 1 : 2);
  for (let t = 0; t < triCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const sa = sourceIds[tri[t * 3 + ((k + 1) % 3)]], sb = sourceIds[tri[t * 3 + ((k + 2) % 3)]];
      const key = sa < sb ? sa * 65536 + sb : sb * 65536 + sa;
      const other = owners.get(key);
      if (other === undefined) { owners.set(key, t * 3 + k); continue; }
      if (other < 0) continue;
      const u = Math.floor(other / 3), m = other % 3;
      neighbor[t * 3 + k] = u;
      neighbor[u * 3 + m] = t;
      neighborCorners[(t * 3 + k) * 2] = cornerOf(u, sa);
      neighborCorners[(t * 3 + k) * 2 + 1] = cornerOf(u, sb);
      neighborCorners[(u * 3 + m) * 2] = cornerOf(t, sourceIds[tri[u * 3 + ((m + 1) % 3)]]);
      neighborCorners[(u * 3 + m) * 2 + 1] = cornerOf(t, sourceIds[tri[u * 3 + ((m + 2) % 3)]]);
      owners.set(key, -1);
    }
  }
  const brow = buildCandidates(ZONE.brow, GNM_PLAYER_FACIAL_HAIR.candidateDensity.brow, 0x6a09e667, ["browT", "browD"]);
  const beard = buildCandidates(ZONE.beard, GNM_PLAYER_FACIAL_HAIR.candidateDensity.beard, 0xbb67ae85, ["beardUpper", "beardLower", "mouthDX", "mouthDY", "scalpFront", "lip", "mouthSock", "posterior"]);
  // Blue-noise clump seeds: dart throwing over a uniform prefix of the beard candidates.
  const spacing = GNM_PLAYER_FACIAL_HAIR.clumpSpacingMm / 1000;
  const spacing2 = spacing * spacing;
  const grid = createGrid(spacing);
  const seeds = [];
  const bp = beard.position;
  const tries = Math.min(beard.count, Math.round(beard.count * 0.4));
  for (let slot = 0; slot < tries; slot += 1) {
    const x = bp[slot * 3], y = bp[slot * 3 + 1], z = bp[slot * 3 + 2];
    let blocked = false;
    grid.visit(x, y, z, 1, false, (other) => {
      const ox = bp[other * 3] - x, oy = bp[other * 3 + 1] - y, oz = bp[other * 3 + 2] - z;
      blocked = ox * ox + oy * oy + oz * oz < spacing2;
      return blocked;
    });
    if (blocked) continue;
    grid.insert(slot, x, y, z);
    seeds.push(slot);
  }
  // Nearest seed of every beard candidate (the seed grid's cells hold one seed at most per spacing).
  const clump = new Int32Array(beard.count).fill(-1);
  let bestDistance = Infinity, best = -1, qx = 0, qy = 0, qz = 0;
  const consider = (seedSlot) => {
    const ox = bp[seedSlot * 3] - qx, oy = bp[seedSlot * 3 + 1] - qy, oz = bp[seedSlot * 3 + 2] - qz;
    const distance = ox * ox + oy * oy + oz * oz;
    if (distance < bestDistance) { bestDistance = distance; best = seedSlot; }
    return false;
  };
  const seedIndex = new Map(seeds.map((slot, index) => [slot, index]));
  for (let slot = 0; slot < beard.count; slot += 1) {
    qx = bp[slot * 3]; qy = bp[slot * 3 + 1]; qz = bp[slot * 3 + 2];
    bestDistance = Infinity; best = -1;
    grid.visit(qx, qy, qz, 1, false, consider);
    if (best < 0) grid.visit(qx, qy, qz, 2, true, consider);
    clump[slot] = best < 0 ? -1 : seedIndex.get(best);
  }
  beard.clump = clump;
  beard.seeds = Uint32Array.from(seeds);
  return {
    version: GNM_PLAYER_FACIAL_HAIR.version,
    renderCount,
    fields: f,
    posterior,
    triangles: { count: triCount, tri, zone, neighbor, neighborCorners },
    noise,
    browVertices: Uint32Array.from(browVertices),
    beardVertices: Uint32Array.from(beardVertices),
    brow,
    beard,
    // Per-style candidate lists (density > 0), filled on first use.
    cache: new Map(),
  };

  /*
   * Stratified area-weighted candidates on the zone's triangles (R2
   * low-discrepancy points per triangle), then one fixed global shuffle.
   * Each keeps its triangle, barycentric weights, template position, the
   * interpolated fields it needs and an edge noise value.
   */
  function buildCandidates(zoneBit, perMm2, salt, keys) {
    const triIndex = [];
    const bary = [];
    let stream = salt >>> 0;
    const next = () => { stream = (stream + 0x6d2b79f5) >>> 0; return mix32(stream) / 4294967296; };
    for (let t = 0; t < triCount; t += 1) {
      if (!(zone[t] & zoneBit)) continue;
      const count = Math.floor(perMm2 * areaList[t] * 1e6 + next());
      const o1 = next(), o2 = next();
      for (let k = 0; k < count; k += 1) {
        let u = (o1 + k * 0.7548776662466927) % 1, v = (o2 + k * 0.5698402909980532) % 1;
        if (u + v > 1) { u = 1 - u; v = 1 - v; }
        triIndex.push(t);
        bary.push(1 - u - v, u, v);
      }
    }
    const total = triIndex.length;
    const order = Uint32Array.from({ length: total }, (_, index) => index);
    for (let index = total - 1; index > 0; index -= 1) {
      const swap = Math.floor(next() * (index + 1));
      const value = order[index]; order[index] = order[swap]; order[swap] = value;
    }
    const out = { count: total, tri: new Int32Array(total), bary: new Float32Array(total * 3), position: new Float32Array(total * 3), noise: new Float32Array(total) };
    const sources = keys.map((key) => (key === "posterior" ? posterior : f[key]));
    const targets = keys.map((key) => (out[key] = new Float32Array(total)));
    for (let slot = 0; slot < total; slot += 1) {
      const source = order[slot];
      const t = triIndex[source];
      out.tri[slot] = t;
      const w0 = bary[source * 3], w1 = bary[source * 3 + 1], w2 = bary[source * 3 + 2];
      out.bary[slot * 3] = w0; out.bary[slot * 3 + 1] = w1; out.bary[slot * 3 + 2] = w2;
      const a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
      const x = w0 * positions[a * 3] + w1 * positions[b * 3] + w2 * positions[c * 3];
      const y = w0 * positions[a * 3 + 1] + w1 * positions[b * 3 + 1] + w2 * positions[c * 3 + 1];
      const z = w0 * positions[a * 3 + 2] + w1 * positions[b * 3 + 2] + w2 * positions[c * 3 + 2];
      out.position[slot * 3] = x; out.position[slot * 3 + 1] = y; out.position[slot * 3 + 2] = z;
      for (let k = 0; k < sources.length; k += 1) targets[k][slot] = w0 * sources[k][a] + w1 * sources[k][b] + w2 * sources[k][c];
      out.noise[slot] = valueNoise(x * 260, y * 260, z * 260, 0x1f83d9ab);
    }
    return out;
  }
}

/**
 * Candidates of one style with a positive density (in candidate order) and
 * their acceptance probabilities; static per asset and style, so a frame
 * only hashes them against the seed.
 */
function styleCandidates(data, key, count, probability) {
  let entry = data.cache.get(key);
  if (!entry) {
    const slots = [];
    const values = [];
    for (let slot = 0; slot < count; slot += 1) {
      const value = probability(slot);
      if (value > 0) { slots.push(slot); values.push(value); }
    }
    entry = { slots: Int32Array.from(slots), probability: Float32Array.from(values) };
    data.cache.set(key, entry);
  }
  return entry;
}

/* ------------------------------------------------------------------------ */
/* Surface walker                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Walks the deformed skin along straightest geodesics: a position is a
 * triangle and barycentric weights, a direction a unit vector in that
 * triangle's plane; crossing an edge unfolds the direction into the
 * neighbour's plane (same angle to the shared edge). Walks stay inside
 * their zone and stop at its border.
 */
class SurfaceWalker {
  constructor(data) {
    this.data = data;
    this.positions = null;
    this.normals = null;
    this.mask = 0;
    this.tri = -1;
    this.b = new Float64Array(3);
    this.dir = new Float64Array(3);
    this.p = new Float64Array(9);
    this.e1 = new Float64Array(3);
    this.e2 = new Float64Array(3);
    this.n = new Float64Array(3);
    this.gram = new Float64Array(4);
  }
  setFrame(positions, normals) { this.positions = positions; this.normals = normals; }
  enter(tri) {
    const { positions, p, e1, e2, n, gram } = this;
    const corners = this.data.triangles.tri;
    this.tri = tri;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = corners[tri * 3 + corner] * 3;
      p[corner * 3] = positions[vertex]; p[corner * 3 + 1] = positions[vertex + 1]; p[corner * 3 + 2] = positions[vertex + 2];
    }
    e1[0] = p[3] - p[0]; e1[1] = p[4] - p[1]; e1[2] = p[5] - p[2];
    e2[0] = p[6] - p[0]; e2[1] = p[7] - p[1]; e2[2] = p[8] - p[2];
    const g11 = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2];
    const g12 = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2];
    const g22 = e2[0] * e2[0] + e2[1] * e2[1] + e2[2] * e2[2];
    const det = g11 * g22 - g12 * g12;
    gram[0] = g11; gram[1] = g12; gram[2] = g22; gram[3] = det > 1e-24 ? 1 / det : 0;
    n[0] = e1[1] * e2[2] - e1[2] * e2[1]; n[1] = e1[2] * e2[0] - e1[0] * e2[2]; n[2] = e1[0] * e2[1] - e1[1] * e2[0];
    const length = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) || 1;
    n[0] /= length; n[1] /= length; n[2] /= length;
  }
  start(tri, b0, b1, b2, mask) {
    this.mask = mask;
    this.enter(tri);
    this.b[0] = b0; this.b[1] = b1; this.b[2] = b2;
  }
  /** Set the direction from (x, y, z), projected onto the current plane; false if degenerate. */
  setDirection(x, y, z) {
    const n = this.n;
    const along = x * n[0] + y * n[1] + z * n[2];
    let dx = x - along * n[0], dy = y - along * n[1], dz = z - along * n[2];
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(length > 1e-9)) return false;
    dx /= length; dy /= length; dz /= length;
    this.dir[0] = dx; this.dir[1] = dy; this.dir[2] = dz;
    return true;
  }
  /** In-plane gradient of a per-vertex field (per metre) into `out`. */
  gradient(field, out) {
    const corners = this.data.triangles.tri;
    const t = this.tri * 3;
    const f0 = field[corners[t]], d1 = field[corners[t + 1]] - f0, d2 = field[corners[t + 2]] - f0;
    const { e1, e2, gram } = this;
    const a = (d1 * gram[2] - d2 * gram[1]) * gram[3];
    const b = (d2 * gram[0] - d1 * gram[1]) * gram[3];
    out[0] = a * e1[0] + b * e2[0]; out[1] = a * e1[1] + b * e2[1]; out[2] = a * e1[2] + b * e2[2];
  }
  /** Interpolated per-vertex field at the current position. */
  field(field) {
    const corners = this.data.triangles.tri;
    const t = this.tri * 3, b = this.b;
    return b[0] * field[corners[t]] + b[1] * field[corners[t + 1]] + b[2] * field[corners[t + 2]];
  }
  /** Interpolated per-vertex fields at the current position into out (one value per field). */
  fields(list, out) {
    const corners = this.data.triangles.tri;
    const t = this.tri * 3, b = this.b;
    const a = corners[t], c = corners[t + 1], d = corners[t + 2];
    for (let index = 0; index < list.length; index += 1) {
      const field = list[index];
      out[index] = b[0] * field[a] + b[1] * field[c] + b[2] * field[d];
    }
  }
  /** Surface point and unit interpolated normal at the current position into out (6 values). */
  point(out) {
    const corners = this.data.triangles.tri;
    const { positions, normals, b } = this;
    const t = this.tri * 3;
    const a = corners[t] * 3, c = corners[t + 1] * 3, d = corners[t + 2] * 3;
    out[0] = b[0] * positions[a] + b[1] * positions[c] + b[2] * positions[d];
    out[1] = b[0] * positions[a + 1] + b[1] * positions[c + 1] + b[2] * positions[d + 1];
    out[2] = b[0] * positions[a + 2] + b[1] * positions[c + 2] + b[2] * positions[d + 2];
    let nx = b[0] * normals[a] + b[1] * normals[c] + b[2] * normals[d];
    let ny = b[0] * normals[a + 1] + b[1] * normals[c + 1] + b[2] * normals[d + 1];
    let nz = b[0] * normals[a + 2] + b[1] * normals[c + 2] + b[2] * normals[d + 2];
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    out[3] = nx / length; out[4] = ny / length; out[5] = nz / length;
  }
  /** Render vertex of the dominant corner (the ambient-occlusion texel of a root). */
  dominantVertex() {
    const b = this.b;
    const corner = b[0] >= b[1] && b[0] >= b[2] ? 0 : b[1] >= b[2] ? 1 : 2;
    return this.data.triangles.tri[this.tri * 3 + corner];
  }
  /** Walk `distance` (m) along the surface; false when the zone border stops it first. */
  step(distance) {
    const { b, dir, e1, e2, gram } = this;
    const { neighbor, neighborCorners, zone } = this.data.triangles;
    let remaining = distance;
    for (let crossing = 0; crossing < 24 && remaining > 1e-12; crossing += 1) {
      const r1 = dir[0] * e1[0] + dir[1] * e1[1] + dir[2] * e1[2];
      const r2 = dir[0] * e2[0] + dir[1] * e2[1] + dir[2] * e2[2];
      const v1 = (gram[2] * r1 - gram[1] * r2) * gram[3];
      const v2 = (gram[0] * r2 - gram[1] * r1) * gram[3];
      const v0 = -v1 - v2;
      let exit = -1, time = remaining;
      if (v0 < 0 && -b[0] / v0 < time) { time = -b[0] / v0; exit = 0; }
      if (v1 < 0 && -b[1] / v1 < time) { time = -b[1] / v1; exit = 1; }
      if (v2 < 0 && -b[2] / v2 < time) { time = -b[2] / v2; exit = 2; }
      if (time < 0) time = 0;
      b[0] += v0 * time; b[1] += v1 * time; b[2] += v2 * time;
      remaining -= time;
      if (exit < 0) break;
      b[exit] = 0;
      const next = neighbor[this.tri * 3 + exit];
      if (next < 0 || !(zone[next] & this.mask)) {
        this.normalizeBary();
        return false;
      }
      // Unfold the direction across the shared edge (corners a -> c of this triangle).
      const a = (exit + 1) % 3, c = (exit + 2) % 3;
      const p = this.p;
      let ex = p[c * 3] - p[a * 3], ey = p[c * 3 + 1] - p[a * 3 + 1], ez = p[c * 3 + 2] - p[a * 3 + 2];
      const el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
      ex /= el; ey /= el; ez /= el;
      const along = dir[0] * ex + dir[1] * ey + dir[2] * ez;
      const across = Math.sqrt(Math.max(1 - along * along, 0));
      const ba = b[a], bc = b[c];
      const slot = (this.tri * 3 + exit) * 2;
      const na = neighborCorners[slot], nc = neighborCorners[slot + 1];
      const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
      this.enter(next);
      const opposite = 3 - na - nc;
      const q = this.p;
      let wx = q[opposite * 3] - ax, wy = q[opposite * 3 + 1] - ay, wz = q[opposite * 3 + 2] - az;
      const wAlong = wx * ex + wy * ey + wz * ez;
      wx -= wAlong * ex; wy -= wAlong * ey; wz -= wAlong * ez;
      const wl = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
      dir[0] = along * ex + across * wx / wl;
      dir[1] = along * ey + across * wy / wl;
      dir[2] = along * ez + across * wz / wl;
      b[na] = ba; b[nc] = bc; b[opposite] = 0;
      this.normalizeBary();
    }
    this.normalizeBary();
    return true;
  }
  normalizeBary() {
    const b = this.b;
    if (b[0] < 0) b[0] = 0;
    if (b[1] < 0) b[1] = 0;
    if (b[2] < 0) b[2] = 0;
    const sum = b[0] + b[1] + b[2] || 1;
    b[0] /= sum; b[1] /= sum; b[2] /= sum;
  }
}

/* ------------------------------------------------------------------------ */
/* Shared per-frame helpers                                                   */
/* ------------------------------------------------------------------------ */

/** Empty facial hair mesh (no beard, or brows hidden). */
export function emptyGnmPlayerFacialHair(part = "beard") {
  return new StrandBuffers(0, 0, KIND).finish({ part, style: null, groom: null, lod: "none", tipFade: 0.8, roughness: 0.2 });
}

/** Resample `count` points of a polyline (xyz) to `target` points evenly spaced along it (in place, scratch in tmp). */
function resample(xyz, count, target, tmp) {
  if (count === target) return;
  let total = 0;
  const cumulative = tmp.cumulative;
  cumulative[0] = 0;
  for (let p = 1; p < count; p += 1) {
    total += Math.hypot(xyz[p * 3] - xyz[p * 3 - 3], xyz[p * 3 + 1] - xyz[p * 3 - 2], xyz[p * 3 + 2] - xyz[p * 3 - 1]);
    cumulative[p] = total;
  }
  const out = tmp.points;
  let segment = 0;
  for (let p = 0; p < target; p += 1) {
    const s = total * (p / (target - 1));
    while (segment < count - 2 && cumulative[segment + 1] < s) segment += 1;
    const length = cumulative[segment + 1] - cumulative[segment];
    const u = count < 2 || length <= 1e-12 ? 0 : clamp((s - cumulative[segment]) / length, 0, 1);
    const a = segment * 3, b = Math.min(segment + 1, count - 1) * 3;
    out[p * 3] = xyz[a] + (xyz[b] - xyz[a]) * u;
    out[p * 3 + 1] = xyz[a + 1] + (xyz[b + 1] - xyz[a + 1]) * u;
    out[p * 3 + 2] = xyz[a + 2] + (xyz[b + 2] - xyz[a + 2]) * u;
  }
  for (let index = 0; index < target * 3; index += 1) xyz[index] = out[index];
}

/** Render vertex of the dominant corner of a candidate's root triangle (its ambient-occlusion texel). */
function candidateRootVertex(data, candidates, slot) {
  const b0 = candidates.bary[slot * 3], b1 = candidates.bary[slot * 3 + 1], b2 = candidates.bary[slot * 3 + 2];
  const corner = b0 >= b1 && b0 >= b2 ? 0 : b1 >= b2 ? 1 : 2;
  return data.triangles.tri[candidates.tri[slot] * 3 + corner];
}

/**
 * Accepted candidates of a style for this seed, in candidate order: each
 * listed candidate is accepted when its hash is below its probability
 * (`extra`, optional, can still reject it). Tier 0 holds the candidates in
 * the reduced prefix of the candidate order; the reduced build stops there.
 */
function acceptCandidates(list, count, lod, seed, salt, extra = null) {
  const reducedSlots = Math.round(count * GNM_PLAYER_FACIAL_HAIR.reducedFraction);
  const limit = lod === "reduced" ? reducedSlots : count;
  const accepted = [];
  let reduced = 0;
  const { slots, probability } = list;
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    if (slot >= limit) break;
    if (hashUnit(seed, slot, salt) >= probability[index]) continue;
    if (extra && !extra(slot)) continue;
    accepted.push(slot);
    if (slot < reducedSlots) reduced += 1;
  }
  return { accepted, reduced };
}

/* ------------------------------------------------------------------------ */
/* Eyebrows                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Growth angle (radians, from the lateral brow direction towards "up") of a
 * brow hair at brow coordinate t, normalized across-position a (-1 lower
 * edge, +1 upper edge), centre-line rise angle `rise` and the angle of the
 * vertical in the same frame (`vertical`, radians): head hairs point up and
 * slightly out, body hairs up and out along the brow (steeper from the
 * lower edge, flatter from the upper edge, so they converge), tail hairs
 * out and down along the arch.
 */
function browGrowthAngle(style, t, a, rise, vertical) {
  const head = 1 - smoothstep(0.02, 0.22, t);
  const tail = smoothstep(style.peak + 0.02, style.peak + 0.26, t);
  const body = rise + (24 - 15 * a) * DEG;
  const tailAngle = rise - (7 + 6 * a) * DEG;
  const headAngle = vertical - (15 + 6 * a) * DEG;
  return lerp(lerp(body, tailAngle, tail), headAngle, head);
}

function browStyleKey(style) {
  return `brow:${style.asset}:${style.thickness}:${style.arch}:${style.peak}:${style.length}:${style.density}:${style.angular ? 1 : 0}:${style.offset || 0}`;
}

/**
 * Build the eyebrow strands of one frame. `positions`/`normals` are the
 * render vertex arrays of the reconstructed mesh, `style` the catalog brow
 * style and `seed` the profile seed. Options: `lod` ("full" or "reduced").
 */
export function buildGnmPlayerBrows(data, positions, normals, style, seed, options = {}) {
  const groom = gnmPlayerBrowGroom(style);
  if (!groom) return emptyGnmPlayerFacialHair("brow");
  seed >>>= 0;
  const lod = options.lod === "reduced" ? "reduced" : "full";
  const c = data.brow;
  // One salt for every brow style: the same follicles, a different shape.
  const salt = stringSalt("brows");
  const list = styleCandidates(data, browStyleKey(style), c.count, (slot) => gnmPlayerBrowDensity(style, groom, c.browT[slot], c.browD[slot], c.noise[slot]) * groom.fill);
  const { accepted, reduced } = acceptCandidates(list, c.count, lod, seed, salt);
  const pointCount = groom.segments + 1;
  const buffers = new StrandBuffers(reduced * pointCount, (accepted.length - reduced) * pointCount, KIND);
  const walker = new SurfaceWalker(data);
  walker.setFrame(positions, normals);
  const { browT, browD } = data.fields;
  const xyz = new Float64Array(pointCount * 3);
  const frame = new Float64Array(6);
  const gradT = new Float64Array(3), gradD = new Float64Array(3);
  const shape = new Float64Array(4);
  const tmp = { cumulative: new Float64Array(pointCount), points: new Float64Array(pointCount * 3) };
  const random = new RandomStream(0, 0, 0);
  const kinds = { fine: 0, stray: 0 };
  // Lateral (L) and up (U) brow directions of the walker's triangle (field
  // gradients) and the surface length of a unit of t and of browD, cached
  // per triangle.
  const axes = new Float64Array(6);
  let axesTri = -1, axesValid = false, tScale = 0, dScale = 0, vertical = 0;
  const updateAxes = () => {
    if (walker.tri === axesTri) return axesValid;
    axesTri = walker.tri;
    walker.gradient(browT, gradT);
    walker.gradient(browD, gradD);
    let lx = gradT[0], ly = gradT[1], lz = gradT[2];
    tScale = Math.sqrt(lx * lx + ly * ly + lz * lz);
    axesValid = tScale > 1e-6;
    if (!axesValid) return false;
    lx /= tScale; ly /= tScale; lz /= tScale;
    const along = gradD[0] * lx + gradD[1] * ly + gradD[2] * lz;
    let ux = gradD[0] - along * lx, uy = gradD[1] - along * ly, uz = gradD[2] - along * lz;
    dScale = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (!(dScale > 1e-6)) {
      // Fall back to "up" from the plane normal.
      const n = walker.n;
      ux = n[1] * lz - n[2] * ly; uy = n[2] * lx - n[0] * lz; uz = n[0] * ly - n[1] * lx;
      if (uy < 0) { ux = -ux; uy = -uy; uz = -uz; }
      dScale = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
      ux /= dScale; uy /= dScale; uz /= dScale;
      dScale = 1000;
    } else { ux /= dScale; uy /= dScale; uz /= dScale; }
    axes[0] = lx; axes[1] = ly; axes[2] = lz; axes[3] = ux; axes[4] = uy; axes[5] = uz;
    // The vertical (world up) in the (L, U) frame: head hairs are set against it.
    vertical = Math.atan2(uy, ly);
    return true;
  };
  // Target growth angle at brow coordinates (t, d) in the current triangle.
  const targetAngle = (t, d) => {
    gnmPlayerBrowShape(style, t, shape);
    const rise = Math.atan((shape[2] * tScale) / dScale);
    const a = clamp((d - shape[0]) / Math.max(shape[1], 0.4), -1.6, 1.6);
    return browGrowthAngle(style, t, a, rise, vertical);
  };
  const setAngle = (angle) => {
    const cs = Math.cos(angle), sn = Math.sin(angle);
    walker.setDirection(cs * axes[0] + sn * axes[3], cs * axes[1] + sn * axes[4], cs * axes[2] + sn * axes[5]);
  };
  for (let order = 0; order < accepted.length; order += 1) {
    const slot = accepted[order];
    walker.start(c.tri[slot], c.bary[slot * 3], c.bary[slot * 3 + 1], c.bary[slot * 3 + 2], ZONE.brow);
    random.state = mix32(seed ^ mix32(Math.imul(slot + 1, 0x9e3779b1) ^ salt)) || 0x9e3779b9;
    const lengthDraw = random.next(), angleDraw = random.next(), liftDraw = random.next(), layerDraw = random.next(), widthDraw = random.next();
    const fineDraw = random.next(), strayDraw = random.next(), bendDraw = random.next(), strandRandom = random.next();
    const t0 = c.browT[slot], d0 = c.browD[slot];
    walker.point(frame);
    const rootVertex = walker.dominantVertex();
    xyz[0] = frame[0]; xyz[1] = frame[1]; xyz[2] = frame[2];
    const hasAxes = updateAxes();
    gnmPlayerBrowShape(style, t0, shape);
    const edge = Math.abs(d0 - shape[0]) / Math.max(shape[1], 0.4);
    // Fine hairs along the edges and in the head; a few stray hairs.
    const fine = fineDraw < groom.fine + 0.4 * smoothstep(0.7, 1.2, edge) + 0.2 * (1 - smoothstep(0.02, 0.14, t0));
    const stray = !fine && strayDraw < groom.stray;
    if (fine) kinds.fine += 1; else if (stray) kinds.stray += 1;
    // Low-frequency angle variation from the static noise plus a per-hair jitter.
    const jitter = ((angleDraw - 0.5) * 2 * groom.angleJitter + (c.noise[slot] - 0.5) * 10) * DEG * (stray ? 3.5 : 1);
    const bend = (bendDraw - 0.5) * 2 * 2 * DEG * 1000; // radians per metre along the hair
    const head = 1 - smoothstep(0.02, 0.2, t0), tail = smoothstep(style.peak + 0.02, style.peak + 0.26, t0);
    let lengthMm = lerp(lerp(groom.length, groom.tailLength, tail), groom.headLength, head);
    lengthMm *= (1 + (lengthDraw - 0.5) * 2 * groom.jitter) * (fine ? 0.55 : 1) * (stray ? 1.3 : 1);
    const step = lengthMm / 1000 / groom.segments;
    const lift = lerp(groom.lift[0], groom.lift[1], liftDraw) * DEG * (stray ? 1.8 : 1);
    const layer = lerp(groom.layer[0], groom.layer[1], layerDraw) / 1000 * (stray ? 1.6 : 1);
    const decay = Math.exp(-step * Math.tan(lift) / layer);
    let remaining = 1;
    if (hasAxes) setAngle(targetAngle(t0, d0) + jitter);
    else walker.setDirection(frame[0] < 0 ? -1 : 1, 0.3, 0);
    let count = 1;
    const turn = bend * step;
    for (let p = 1; p < pointCount; p += 1) {
      if (!walker.step(step)) break;
      // Turn gently towards the local growth field, plus the hair's own bend
      // (a small rotation), in the (L, U) plane.
      if (updateAxes()) {
        const dir = walker.dir;
        let cl = dir[0] * axes[0] + dir[1] * axes[1] + dir[2] * axes[2];
        let cu = dir[0] * axes[3] + dir[1] * axes[4] + dir[2] * axes[5];
        const target = targetAngle(walker.field(browT), walker.field(browD)) + jitter;
        cl += (Math.cos(target) - cl) * groom.follow;
        cu += (Math.sin(target) - cu) * groom.follow;
        const bl = cl - turn * cu, bu = cu + turn * cl;
        walker.setDirection(bl * axes[0] + bu * axes[3], bl * axes[1] + bu * axes[4], bl * axes[2] + bu * axes[5]);
      }
      walker.point(frame);
      remaining *= decay;
      const height = Math.max(layer * (1 - remaining), CLEARANCE);
      xyz[p * 3] = frame[0] + frame[3] * height;
      xyz[p * 3 + 1] = frame[1] + frame[4] * height;
      xyz[p * 3 + 2] = frame[2] + frame[5] * height;
      count += 1;
    }
    if (count < 2) {
      // Stopped at the zone border at once: a short stub off the skin.
      walker.point(frame);
      xyz[3] = xyz[0] + frame[3] * CLEARANCE * 2; xyz[4] = xyz[1] + frame[4] * CLEARANCE * 2; xyz[5] = xyz[2] + frame[5] * CLEARANCE * 2;
      count = 2;
    }
    resample(xyz, count, pointCount, tmp);
    const halfWidth = groom.width / 1000 * (0.8 + 0.4 * widthDraw) * (fine ? 0.6 : stray ? 0.8 : 1);
    buffers.add(order < reduced ? 0 : 1, xyz, pointCount, rootVertex, strandRandom, fine ? KIND.fine : stray ? KIND.stray : KIND.terminal, halfWidth, groom.taper, 0.55 + 0.3 * layerDraw, false, 0.8 + 0.2 * layerDraw);
  }
  return buffers.finish({ part: "brow", style: style.asset, groom: groom.label, lod, tipFade: groom.tipFade, roughness: groom.roughness, fine: kinds.fine, stray: kinds.stray });
}

/* ------------------------------------------------------------------------ */
/* Beard                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Regional weights of a beard point into out: [moustache, chin, under the
 * jaw, neck, jaw (lower face)], from the mouth offsets and beard heights
 * (mm) and the y of the skin normal.
 */
function beardRegions(dx, dy, upper, lower, normalY, out) {
  const adx = Math.abs(dx);
  out[0] = smoothstep(8, 12, dy) * (1 - smoothstep(24, 32, adx));
  out[1] = (1 - smoothstep(-12, -6, dy)) * (1 - smoothstep(18, 30, adx)) * (1 - smoothstep(0.35, 0.7, -normalY));
  out[2] = smoothstep(0.25, 0.65, -normalY);
  out[3] = (1 - smoothstep(4, 20, lower)) * (1 - out[2]);
  out[4] = 1 - smoothstep(-34, -16, upper);
  return out;
}

/** Regional length (mm) of a beard strand from its region weights. */
function beardLength(groom, regions) {
  const lengths = groom.length;
  let length = lerp(lengths[0], lengths[1], regions[4]);
  length = lerp(length, lengths[2], regions[1]);
  length = lerp(length, lengths[3], regions[0]);
  return lerp(length, lengths[4], Math.max(regions[3], regions[2] * 0.5));
}

/**
 * Beard growth direction (world, unnormalized) at a point with world x and
 * mouth offset dx (mm) and the region weights, into out: down on the
 * cheeks and jaw, down and forward on the chin, down and out on the
 * moustache, down and inwards on the neck, back towards the throat under
 * the jaw (where down is along the normal).
 */
function beardFlow(x, dx, regions, out) {
  const side = x < 0 ? -1 : 1;
  const moustache = regions[0], chin = regions[1], under = regions[2], neck = regions[3];
  let fx = -side * 0.05, fy = -1, fz = 0.18;
  fx += (-x * 7 - fx) * chin; fz += (0.5 - fz) * chin;
  const outwards = side * (0.3 + 1.1 * smoothstep(1.5, 20, Math.abs(dx)));
  fx += (outwards - fx) * moustache; fz += (0.22 - fz) * moustache;
  fx += (-side * 0.28 - fx) * neck; fz += (-0.08 - fz) * neck;
  fx += (-x * 5 - fx) * under; fy += (-0.3 - fy) * under; fz += (-1 - fz) * under;
  out[0] = fx; out[1] = fy; out[2] = fz;
}

function beardStyleKey(groom) {
  return `beard:${groom.asset}:${groom.density}`;
}

/**
 * Stubble: straight stubs standing off the skin from each root's
 * interpolated frame (at most ~1.5 mm long, far shorter than the skin's
 * curvature radius, so no walk is needed).
 */
function addStubble(data, c, positions, normals, groom, accepted, reduced, buffers, random, seed, salt, kinds) {
  const tri = data.triangles.tri;
  const xyz = new Float64Array(9);
  const regions = new Float64Array(5);
  const flow = new Float64Array(3);
  for (let order = 0; order < accepted.length; order += 1) {
    const slot = accepted[order];
    random.state = mix32(seed ^ mix32(Math.imul(slot + 1, 0x9e3779b1) ^ salt)) || 0x9e3779b9;
    const lengthDraw = random.next(), liftDraw = random.next(), angleDraw = random.next(), fineDraw = random.next(), widthDraw = random.next(), strandRandom = random.next();
    const t = c.tri[slot] * 3;
    const a = tri[t] * 3, b = tri[t + 1] * 3, d = tri[t + 2] * 3;
    const w0 = c.bary[slot * 3], w1 = c.bary[slot * 3 + 1], w2 = c.bary[slot * 3 + 2];
    const x = w0 * positions[a] + w1 * positions[b] + w2 * positions[d];
    const y = w0 * positions[a + 1] + w1 * positions[b + 1] + w2 * positions[d + 1];
    const z = w0 * positions[a + 2] + w1 * positions[b + 2] + w2 * positions[d + 2];
    let nx = w0 * normals[a] + w1 * normals[b] + w2 * normals[d];
    let ny = w0 * normals[a + 1] + w1 * normals[b + 1] + w2 * normals[d + 1];
    let nz = w0 * normals[a + 2] + w1 * normals[b + 2] + w2 * normals[d + 2];
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const fine = fineDraw < groom.fine;
    if (fine) kinds.fine += 1;
    beardRegions(c.mouthDX[slot], c.mouthDY[slot], c.beardUpper[slot], c.beardLower[slot], ny, regions);
    const length = beardLength(groom, regions) * (1 + (lengthDraw - 0.5) * 2 * groom.jitter) * (fine ? 0.55 : 1) / 1000;
    beardFlow(x, c.mouthDX[slot], regions, flow);
    // In the tangent plane, turned by the swirl and the per-stub jitter.
    const along = flow[0] * nx + flow[1] * ny + flow[2] * nz;
    let dx = flow[0] - along * nx, dy = flow[1] - along * ny, dz = flow[2] - along * nz;
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dl > 1e-9) { dx /= dl; dy /= dl; dz /= dl; } else { dx = 0; dy = -1; dz = 0; }
    const swirl = ((c.noise[slot] - 0.5) * 2 * (10 + 30 * regions[3]) + (angleDraw - 0.5) * 2 * groom.angleJitter) * DEG;
    const cs = Math.cos(swirl), sn = Math.sin(swirl);
    const rx = dx * cs + (ny * dz - nz * dy) * sn, ry = dy * cs + (nz * dx - nx * dz) * sn, rz = dz * cs + (nx * dy - ny * dx) * sn;
    const lift = lerp(groom.lift[0], groom.lift[1], liftDraw) * DEG;
    const cosLift = Math.cos(lift), sinLift = Math.sin(lift);
    const ux = rx * cosLift + nx * sinLift, uy = ry * cosLift + ny * sinLift, uz = rz * cosLift + nz * sinLift;
    for (let p = 0; p < 3; p += 1) {
      const s = (p / 2) * length;
      xyz[p * 3] = x + ux * s; xyz[p * 3 + 1] = y + uy * s; xyz[p * 3 + 2] = z + uz * s;
    }
    const halfWidth = groom.width / 1000 * (0.8 + 0.4 * widthDraw) * (fine ? 0.55 : 1);
    const corner = w0 >= w1 && w0 >= w2 ? 0 : w1 >= w2 ? 1 : 2;
    buffers.add(order < reduced ? 0 : 1, xyz, 3, tri[t + corner], strandRandom, fine ? KIND.fine : KIND.terminal, halfWidth, groom.taper, 0.6 + 0.3 * liftDraw, false, 0.85 + 0.15 * liftDraw);
  }
}

/**
 * Build the beard strands of one frame. `positions`/`normals` are the
 * render vertex arrays of the reconstructed mesh, `style` the catalog
 * beard style and `seed` the profile seed. Options: `lod` ("full" or
 * "reduced") and `collarPlane` ([height, z] of the jersey's collar plane:
 * beard points stay above it).
 */
export function buildGnmPlayerBeard(data, positions, normals, style, seed, options = {}) {
  const groom = gnmPlayerBeardGroom(style);
  if (!groom) return emptyGnmPlayerFacialHair("beard");
  seed >>>= 0;
  const lod = options.lod === "reduced" ? "reduced" : "full";
  const c = data.beard;
  // One salt for every beard style: the same follicles, different grooming.
  const salt = stringSalt("beard");
  const collar = options.collarPlane ?? null;
  const collarMargin = GNM_PLAYER_FACIAL_HAIR.collarMarginMm / 1000;
  const aboveCollar = (x, y, z) => !collar || y + 0.12 * (z - collar[1]) >= collar[0] + collarMargin;
  const tri = data.triangles.tri;
  const rootAxis = (slot, axis) => {
    const t = c.tri[slot] * 3;
    return c.bary[slot * 3] * positions[tri[t] * 3 + axis] + c.bary[slot * 3 + 1] * positions[tri[t + 1] * 3 + axis] + c.bary[slot * 3 + 2] * positions[tri[t + 2] * 3 + axis];
  };
  const fill = groom.fill * lerp(0.6, 1, groom.density);
  const list = styleCandidates(data, beardStyleKey(groom), c.count, (slot) => gnmPlayerBeardDensity(groom, c.beardUpper[slot], c.beardLower[slot], c.mouthDX[slot], c.mouthDY[slot], c.scalpFront[slot], c.lip[slot], c.mouthSock[slot], c.noise[slot], c.posterior[slot]) * fill);
  const { accepted, reduced } = acceptCandidates(list, c.count, lod, seed, salt, (slot) => aboveCollar(rootAxis(slot, 0), rootAxis(slot, 1), rootAxis(slot, 2)));
  const pointCount = groom.segments + 1;
  const buffers = new StrandBuffers(reduced * pointCount, (accepted.length - reduced) * pointCount, KIND);
  const walker = new SurfaceWalker(data);
  walker.setFrame(positions, normals);
  const { lip, mouthSock, beardUpper, beardLower, mouthDX, mouthDY } = data.fields;
  const walkFields = [lip, mouthSock, mouthDX, mouthDY, beardUpper, beardLower];
  const here = new Float64Array(walkFields.length);
  const xyz = new Float64Array(pointCount * 3);
  const surface = new Float64Array(pointCount * 6);
  const heights = new Float64Array(pointCount);
  const frame = new Float64Array(6);
  const regions = new Float64Array(5);
  const flow = new Float64Array(3);
  const tmp = { cumulative: new Float64Array(pointCount), points: new Float64Array(pointCount * 3) };
  const random = new RandomStream(0, 0, 0);
  const kinds = { fine: 0, stray: 0 };
  const stubble = groom.mode === "stubble";
  // Clump seed strands, grown on demand (the average hair: no per-strand jitter).
  const seedCount = c.seeds.length;
  const seedState = groom.clump > 0 ? new Uint8Array(seedCount) : null;
  const seedPoints = groom.clump > 0 ? new Float32Array(seedCount * pointCount * 3) : null;
  const seedXyz = new Float64Array(pointCount * 3);
  const seedSurface = new Float64Array(pointCount * 6);
  const seedHeights = new Float64Array(pointCount);

  /**
   * Grow one strand from candidate `slot` into `out` (points), `outSurface`
   * (skin point and normal per point) and `outHeights`. `draws` are the
   * per-strand randoms (null: a clump seed's average hair). Returns the
   * number of points grown (the walk can stop early).
   */
  const grow = (slot, draws, out, outSurface, outHeights) => {
    walker.start(c.tri[slot], c.bary[slot * 3], c.bary[slot * 3 + 1], c.bary[slot * 3 + 2], ZONE.beard);
    walker.point(frame);
    for (let k = 0; k < 6; k += 1) outSurface[k] = frame[k];
    out[0] = frame[0]; out[1] = frame[1]; out[2] = frame[2];
    outHeights[0] = 0;
    beardRegions(c.mouthDX[slot], c.mouthDY[slot], c.beardUpper[slot], c.beardLower[slot], frame[4], regions);
    const fine = draws ? draws[5] : 0;
    const length = beardLength(groom, regions) * (draws ? 1 + (draws[0] - 0.5) * 2 * groom.jitter : 1) * (fine ? 0.55 : 1) / 1000;
    const step = length / groom.segments;
    const lift = lerp(groom.lift[0], groom.lift[1], draws ? draws[1] : 0.5) * DEG;
    beardFlow(frame[0], c.mouthDX[slot], regions, flow);
    if (!walker.setDirection(flow[0], flow[1], flow[2])) walker.setDirection(0, -1, 0.2);
    // A low-frequency swirl (stronger on the neck) and a per-strand angle jitter.
    const swirl = ((c.noise[slot] - 0.5) * 2 * (10 + 30 * regions[3]) + (draws ? (draws[2] - 0.5) * 2 * groom.angleJitter : 0)) * DEG;
    if (swirl !== 0) {
      const dir = walker.dir, n = walker.n, cs = Math.cos(swirl), sn = Math.sin(swirl);
      walker.setDirection(dir[0] * cs + (n[1] * dir[2] - n[2] * dir[1]) * sn, dir[1] * cs + (n[2] * dir[0] - n[0] * dir[2]) * sn, dir[2] * cs + (n[0] * dir[1] - n[1] * dir[0]) * sn);
    }
    // Lying height: rises at the lift angle and saturates in the style's
    // volume (layered), which is flatter on the cheeks and the moustache and
    // fullest at the jaw, the chin and under the jaw.
    const layer = draws ? lerp(0.35, 1, draws[3]) : 0.7;
    const regional = lerp(lerp(groom.cheekVolume, 1, Math.max(regions[4], regions[1], regions[2] * 0.9, regions[3] * 0.7)), groom.cheekVolume, regions[0]);
    const volume = Math.max(groom.height * layer * regional, 0.15) / 1000;
    const decay = Math.exp(-step * Math.tan(lift) / volume);
    const lipStop = draws ? lerp(groom.lipStop[0], groom.lipStop[1], draws[4]) : 0.3;
    // Smooth random deviation (cubic) across the strand and a wave.
    const frizz = groom.frizz / 1000 * (draws ? 0.5 + draws[6] : 1);
    const a1 = draws ? (draws[7] - 0.5) * 2 * frizz : 0, a2 = draws ? (draws[8] - 0.5) * 2 * frizz : 0;
    const waveAmplitude = groom.wave ? groom.wave[0] / 1000 * (draws ? 0.6 + 0.8 * draws[9] : 1) : 0;
    const wavePhase = draws ? draws[10] * Math.PI * 2 : 0;
    const waveNumber = groom.wave ? (Math.PI * 2) / (groom.wave[1] / 1000) : 0;
    const cs = Math.cos(swirl), sn = Math.sin(swirl);
    let count = 1, remaining = 1;
    for (let p = 1; p < pointCount; p += 1) {
      if (!walker.step(step)) break;
      walker.fields(walkFields, here);
      if (here[0] > lipStop || here[1] > 0.05) break;
      const s = p * step;
      const u = p / groom.segments;
      walker.point(frame);
      beardRegions(here[2], here[3], here[4], here[5], frame[4], regions);
      beardFlow(frame[0], here[2], regions, flow);
      // Steer towards the local flow, keeping the strand's own swirl.
      const dir = walker.dir, n = walker.n;
      const along = flow[0] * n[0] + flow[1] * n[1] + flow[2] * n[2];
      let tx = flow[0] - along * n[0], ty = flow[1] - along * n[1], tz = flow[2] - along * n[2];
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl > 1e-9) {
        tx /= tl; ty /= tl; tz /= tl;
        const rx = tx * cs + (n[1] * tz - n[2] * ty) * sn, ry = ty * cs + (n[2] * tx - n[0] * tz) * sn, rz = tz * cs + (n[0] * ty - n[1] * tx) * sn;
        walker.setDirection(dir[0] + (rx - dir[0]) * groom.follow, dir[1] + (ry - dir[1]) * groom.follow, dir[2] + (rz - dir[2]) * groom.follow);
      }
      remaining *= decay;
      const height = Math.max(volume * (1 - remaining), CLEARANCE);
      // Frizz and wave run across the strand (side = normal x direction).
      let across = a1 * u * u + a2 * u * u * u;
      if (waveAmplitude > 0) across += waveAmplitude * smoothstep(0.1, 0.4, u) * Math.sin(s * waveNumber + wavePhase);
      const sx = n[1] * dir[2] - n[2] * dir[1], sy = n[2] * dir[0] - n[0] * dir[2], sz = n[0] * dir[1] - n[1] * dir[0];
      const x = frame[0] + frame[3] * height + sx * across;
      const y = frame[1] + frame[4] * height + sy * across;
      const z = frame[2] + frame[5] * height + sz * across;
      if (!aboveCollar(x, y, z)) break;
      out[p * 3] = x; out[p * 3 + 1] = y; out[p * 3 + 2] = z;
      for (let k = 0; k < 6; k += 1) outSurface[p * 6 + k] = frame[k];
      outHeights[p] = height;
      count += 1;
    }
    return count;
  };

  const draws = new Float64Array(11);
  if (stubble) {
    addStubble(data, c, positions, normals, groom, accepted, reduced, buffers, random, seed, salt, kinds);
    return buffers.finish({ part: "beard", style: style.asset, groom: groom.label, lod, tipFade: groom.tipFade, roughness: groom.roughness, fine: kinds.fine, stray: kinds.stray });
  }
  for (let order = 0; order < accepted.length; order += 1) {
    const slot = accepted[order];
    random.state = mix32(seed ^ mix32(Math.imul(slot + 1, 0x9e3779b1) ^ salt)) || 0x9e3779b9;
    for (let k = 0; k < 11; k += 1) draws[k] = random.next();
    const fineDraw = random.next(), strayDraw = random.next(), widthDraw = random.next(), clumpDraw = random.next(), strandRandom = random.next();
    const fine = fineDraw < groom.fine;
    const stray = !fine && strayDraw < groom.stray;
    if (fine) kinds.fine += 1; else if (stray) kinds.stray += 1;
    draws[5] = fine ? 1 : 0;
    let count = grow(slot, draws, xyz, surface, heights);
    const rootVertex = candidateRootVertex(data, c, slot);
    if (count < 2) {
      xyz[3] = xyz[0] + surface[3] * CLEARANCE * 2; xyz[4] = xyz[1] + surface[4] * CLEARANCE * 2; xyz[5] = xyz[2] + surface[5] * CLEARANCE * 2;
      for (let k = 0; k < 6; k += 1) surface[6 + k] = surface[k];
      heights[1] = CLEARANCE * 2;
      count = 2;
    }
    // Clumping: pull the strand towards its seed strand, strongest at the
    // tip, then restore its clearance above its own skin points.
    const seedIndex = seedPoints && !stray && count === pointCount ? c.clump[slot] : -1;
    if (seedIndex >= 0 && !seedState[seedIndex]) {
      // State 1: a usable seed strand; 2: degenerate (stopped at once, e.g. rooted on the lip).
      const grown = grow(c.seeds[seedIndex], null, seedXyz, seedSurface, seedHeights);
      if (grown >= 2) {
        resample(seedXyz, grown, pointCount, tmp);
        seedPoints.set(seedXyz.subarray(0, pointCount * 3), seedIndex * pointCount * 3);
      }
      seedState[seedIndex] = grown >= 2 ? 1 : 2;
    }
    if (seedIndex >= 0 && seedState[seedIndex] === 1) {
      const strength = groom.clump * (0.6 + 0.8 * clumpDraw) * (fine ? 0.4 : 1);
      const base = seedIndex * pointCount * 3;
      for (let p = 1; p < pointCount; p += 1) {
        const pull = strength * Math.pow(p / groom.segments, groom.clumpPower);
        const o = p * 3;
        xyz[o] += (seedPoints[base + o] - xyz[o]) * pull;
        xyz[o + 1] += (seedPoints[base + o + 1] - xyz[o + 1]) * pull;
        xyz[o + 2] += (seedPoints[base + o + 2] - xyz[o + 2]) * pull;
        const q = p * 6;
        const height = (xyz[o] - surface[q]) * surface[q + 3] + (xyz[o + 1] - surface[q + 1]) * surface[q + 4] + (xyz[o + 2] - surface[q + 2]) * surface[q + 5];
        const minimum = Math.max(CLEARANCE, heights[p] * 0.4);
        if (height < minimum) {
          xyz[o] += surface[q + 3] * (minimum - height);
          xyz[o + 1] += surface[q + 4] * (minimum - height);
          xyz[o + 2] += surface[q + 5] * (minimum - height);
        }
      }
    }
    resample(xyz, count, pointCount, tmp);
    const halfWidth = groom.width / 1000 * (0.8 + 0.4 * widthDraw) * (fine ? 0.55 : stray ? 0.75 : 1);
    buffers.add(order < reduced ? 0 : 1, xyz, pointCount, rootVertex, strandRandom, fine ? KIND.fine : stray ? KIND.stray : KIND.terminal, halfWidth, groom.taper, 0.5 + 0.35 * draws[3], false, 0.78 + 0.22 * draws[3]);
  }
  return buffers.finish({ part: "beard", style: style.asset, groom: groom.label, lod, tipFade: groom.tipFade, roughness: groom.roughness, fine: kinds.fine, stray: kinds.stray });
}

/* ------------------------------------------------------------------------ */
/* Skin underlay                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Per-render-vertex facial hair density for the skin underlay (x: beard,
 * y: brows), from the same density functions and edge noise as the roots,
 * so the root tint and the stubble darkening never extend past the hair
 * and fade with it. Zero outside the zones (and for "beard/none").
 */
export function gnmPlayerFacialHairUnderlay(data, beardStyle, browStyle) {
  const out = new Float32Array(data.renderCount * 2);
  const f = data.fields;
  const beard = gnmPlayerBeardGroom(beardStyle);
  if (beard) {
    // The tint runs up to the red lip and fades under the shader's lip colour
    // (no untinted ring between the lip and the beard).
    for (const v of data.beardVertices) {
      const fields = [f.beardUpper[v], f.beardLower[v], f.mouthDX[v], f.mouthDY[v], f.scalpFront[v]];
      out[v * 2] = gnmPlayerBeardDensity(beard, ...fields, Math.min(f.lip[v], 0.13), f.mouthSock[v], data.noise[v], data.posterior[v]) * (1 - smoothstep(0.22, 0.6, f.lip[v]));
    }
  }
  const brow = gnmPlayerBrowGroom(browStyle);
  if (brow) {
    for (const v of data.browVertices) out[v * 2 + 1] = gnmPlayerBrowDensity(browStyle, brow, f.browT[v], f.browD[v], data.noise[v]);
  }
  return out;
}
