/*
 * Sports Face GNM 3D player eyes
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * DOM/WebGL-free eye rig shared by the WebGL2 renderer and the tests.
 *
 * Once per asset it reads the official GNM topology: each eyelid margin is
 * the loop where the skin turns into the eye socket (the `eyeSocket` field),
 * crossed by short "spokes" of mesh vertices that run from the anterior lid
 * skin, over the margin, into the socket. Per reconstructed frame (identity,
 * local eye edits and expression presets included) it fits the eyeball and
 * cornea spheres and derives:
 *
 * - eyelash strands rooted on the anterior lid margin (upper and lower,
 *   tapered, clumped, seed-stable per-lash variation);
 * - the lid/eyeball contact line, as a polar table (eye occlusion) and as a
 *   thin tear-meniscus strip;
 * - per-vertex lash-line and wet-margin masks for the skin shader;
 * - seed-stable iris detail parameters and a lash pigment derived from the
 *   hair pigment.
 *
 * Everything is generated in code from the reconstructed vertices; there are
 * no textures or downloaded assets.
 */

import { getFaceValues, hashSeed, Randomizer } from "./face-model.js";
import { GNM_PLAYER_HAIR_COLORS } from "./gnm-player-model.js";

/** Rig constants. Lengths in millimetres, angles in degrees. */
export const GNM_PLAYER_EYES = Object.freeze({
  version: "eye-rig-v1",
  /** Polar lid-contact table entries per eye (uniform azimuth steps). */
  contactSamples: 32,
  /** Spoke rings: negative = anterior lid skin, 0 = margin loop, positive = socket side. */
  spokeDepths: Object.freeze({ min: -4, max: 5 }),
  lashes: Object.freeze({
    segments: 6,
    /** Neighbouring lashes gather in clumps of 2-4 whose tips converge. */
    clumpSize: Object.freeze([2, 4]),
    clumpPull: 0.8,
    upper: Object.freeze({ count: 96, lengthMm: Object.freeze([3.4, 9.4]), peak: 0.6, curlDeg: 66, tiltDeg: 8, splayDeg: Object.freeze([-3, 22]), rootHalfWidthMm: 0.068, rootDepth: Object.freeze([-1.15, -0.65]) }),
    lower: Object.freeze({ count: 30, lengthMm: Object.freeze([1.5, 3.8]), peak: 0.62, curlDeg: 30, tiltDeg: 9, splayDeg: Object.freeze([-2, 14]), rootHalfWidthMm: 0.03, rootDepth: Object.freeze([-1.15, -0.7]) }),
  }),
  tearLine: Object.freeze({ samples: 36, heightMm: Object.freeze({ upper: 0.12, lower: 0.24 }), liftMm: 0.02 }),
});

const DEPTH_COUNT = GNM_PLAYER_EYES.spokeDepths.max - GNM_PLAYER_EYES.spokeDepths.min + 1;
const DEPTH_OFFSET = -GNM_PLAYER_EYES.spokeDepths.min;

function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function smoothstep(edge0, edge1, value) { const t = clamp((value - edge0) / (edge1 - edge0), 0, 1); return t * t * (3 - 2 * t); }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function lengthOf(a) { return Math.hypot(a[0], a[1], a[2]); }
function normalize(a, fallback = [0, 0, 1]) { const l = lengthOf(a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [...fallback]; }
function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function point(positions, vertex) { return [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]]; }
/** Component of `vector` orthogonal to the unit `axis`. */
function orthogonal(vector, axis) { return sub(vector, scale(axis, dot(vector, axis))); }
function wrapAngle(angle) { return Math.atan2(Math.sin(angle), Math.cos(angle)); }

/**
 * Least-squares sphere through `vertices` of a flat xyz array (algebraic fit
 * |p|^2 = 2 c.p + d, solved with 4x4 normal equations).
 */
export function fitGnmPlayerSphere(positions, vertices) {
  const matrix = Array.from({ length: 4 }, () => new Float64Array(4));
  const rhs = new Float64Array(4);
  for (const vertex of vertices) {
    const x = positions[vertex * 3], y = positions[vertex * 3 + 1], z = positions[vertex * 3 + 2];
    const row = [2 * x, 2 * y, 2 * z, 1];
    const value = x * x + y * y + z * z;
    for (let i = 0; i < 4; i += 1) {
      rhs[i] += row[i] * value;
      for (let j = 0; j < 4; j += 1) matrix[i][j] += row[i] * row[j];
    }
  }
  for (let column = 0; column < 4; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 4; row += 1) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    [rhs[column], rhs[pivot]] = [rhs[pivot], rhs[column]];
    if (Math.abs(matrix[column][column]) < 1e-18) throw new Error("GNM player eye sphere fit is degenerate");
    for (let row = column + 1; row < 4; row += 1) {
      const factor = matrix[row][column] / matrix[column][column];
      for (let k = column; k < 4; k += 1) matrix[row][k] -= factor * matrix[column][k];
      rhs[row] -= factor * rhs[column];
    }
  }
  const solution = new Float64Array(4);
  for (let row = 3; row >= 0; row -= 1) {
    let sum = rhs[row];
    for (let k = row + 1; k < 4; k += 1) sum -= matrix[row][k] * solution[k];
    solution[row] = sum / matrix[row][row];
  }
  const center = [solution[0], solution[1], solution[2]];
  return { center, radius: Math.sqrt(solution[3] + dot(center, center)) };
}

function averagePoint(positions, vertices) {
  const sum = [0, 0, 0];
  for (const vertex of vertices) for (let axis = 0; axis < 3; axis += 1) sum[axis] += positions[vertex * 3 + axis];
  return scale(sum, 1 / Math.max(vertices.length, 1));
}

/** Eye-local frame: axis (gaze, towards the pupil), up (world up made orthogonal), right = up x axis. */
function eyeFrame(positions, eye) {
  const sphere = fitGnmPlayerSphere(positions, eye.sclera);
  const pupil = averagePoint(positions, eye.pupil);
  const axis = normalize(sub(pupil, sphere.center));
  const up = normalize(orthogonal([0, 1, 0], axis), [0, 1, 0]);
  return { center: sphere.center, radius: sphere.radius, axis, up, right: cross(up, axis), pupil };
}

/**
 * The iris is a nearly flat, slightly conical disc; identities can tilt it
 * against the eyeball's centre-to-pupil axis by several degrees. Fit it as a
 * plane z = a x + b y + c in the eye frame (least squares), through the pupil
 * centre, and measure the limbus radius on that plane.
 */
function fitIrisPlane(positions, eye, frame) {
  const matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const rhs = [0, 0, 0];
  for (const vertex of eye.iris) {
    const offset = sub(point(positions, vertex), frame.center);
    const row = [dot(offset, frame.right), dot(offset, frame.up), 1];
    const height = dot(offset, frame.axis);
    for (let i = 0; i < 3; i += 1) {
      rhs[i] += row[i] * height;
      for (let j = 0; j < 3; j += 1) matrix[i][j] += row[i] * row[j];
    }
  }
  const determinant = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const base = determinant(matrix);
  const [a, b] = Math.abs(base) > 1e-24 ? [0, 1].map((column) => determinant(matrix.map((row, i) => row.map((value, j) => (j === column ? rhs[i] : value)))) / base) : [0, 0];
  const normal = normalize(sub(sub(frame.axis, scale(frame.right, a)), scale(frame.up, b)), frame.axis);
  let radius = 0;
  for (const vertex of eye.limbus) radius += lengthOf(orthogonal(sub(point(positions, vertex), frame.pupil), normal));
  return { center: frame.pupil, normal, radius: radius / Math.max(eye.limbus.length, 1) };
}

function azimuthOf(frame, position) {
  const offset = sub(position, frame.center);
  return Math.atan2(dot(offset, frame.up), dot(offset, frame.right));
}

/**
 * Static eye topology from the official template (source vertex ids).
 *
 * @param {object} input
 * @param {Float32Array} input.template source-space template positions
 * @param {Uint32Array} input.skinTriangles skin triangles (source ids)
 * @param {(key: string, vertex: number) => number} input.field decoded appearance field of a source vertex
 * @param {Float64Array} input.landmarks 68 template landmarks (iBUG order)
 * @param {Array<{interior: Uint32Array, cornea: Uint32Array}>} input.eyeVertices both eyeballs (source ids)
 */
export function buildGnmPlayerEyeTopology({ template, skinTriangles, field, landmarks, eyeVertices }) {
  const neighbors = new Map();
  for (let index = 0; index < skinTriangles.length; index += 3) {
    for (let edge = 0; edge < 3; edge += 1) {
      const a = skinTriangles[index + edge], b = skinTriangles[index + (edge + 1) % 3];
      if (a === b) continue;
      if (!neighbors.has(a)) neighbors.set(a, new Set());
      if (!neighbors.has(b)) neighbors.set(b, new Set());
      neighbors.get(a).add(b);
      neighbors.get(b).add(a);
    }
  }
  const eyes = eyeVertices.map((vertices) => {
    const interior = Array.from(vertices.interior);
    const eye = {
      sclera: Uint32Array.from(interior.filter((vertex) => field("irisAngle", vertex) >= 26)),
      pupil: Uint32Array.from(interior.filter((vertex) => field("irisAngle", vertex) <= 7.5)),
      iris: Uint32Array.from(interior.filter((vertex) => field("irisAngle", vertex) <= 20)),
      limbus: Uint32Array.from(interior.filter((vertex) => field("irisAngle", vertex) >= 20 && field("irisAngle", vertex) <= 23.5)),
      dome: Uint32Array.from(Array.from(vertices.cornea).filter((vertex) => field("irisAngle", vertex) <= 16)),
    };
    if (eye.sclera.length < 32 || eye.pupil.length < 1 || eye.iris.length < 16 || eye.limbus.length < 8 || eye.dome.length < 8) throw new Error("GNM player eye topology is incomplete");
    const frame = eyeFrame(template, eye);
    const side = frame.center[0] < 0 ? -1 : 1;
    // iBUG 68: 36-41 is the subject's right eye (x < 0), 42-47 the left eye.
    const [innerLandmark, outerLandmark] = side < 0 ? [39, 36] : [42, 45];
    const near = (vertex) => lengthOf(sub(point(template, vertex), frame.center)) < 0.03;
    const socket = (vertex) => field("eyeSocket", vertex) >= 0.5;
    const ring0 = [...neighbors.keys()].filter((vertex) => near(vertex) && !socket(vertex) && [...neighbors.get(vertex)].some(socket));
    if (ring0.length < 24) throw new Error("GNM player eyelid margin loop is incomplete");
    const azimuth = new Map(ring0.map((vertex) => [vertex, azimuthOf(frame, point(template, vertex))]));
    ring0.sort((a, b) => azimuth.get(a) - azimuth.get(b));
    // Breadth-first ring depth from the margin: socket side positive, skin side negative.
    const depth = new Map(ring0.map((vertex) => [vertex, 0]));
    let frontier = ring0;
    for (let step = 1; step <= Math.max(GNM_PLAYER_EYES.spokeDepths.max, -GNM_PLAYER_EYES.spokeDepths.min); step += 1) {
      const next = [];
      for (const vertex of frontier) {
        for (const candidate of neighbors.get(vertex)) {
          if (depth.has(candidate) || !near(candidate)) continue;
          const signed = socket(candidate) ? step : -step;
          if (signed > GNM_PLAYER_EYES.spokeDepths.max || signed < GNM_PLAYER_EYES.spokeDepths.min) continue;
          depth.set(candidate, signed);
          next.push(candidate);
        }
      }
      frontier = next;
    }
    // Spokes: from each margin vertex, walk ring by ring to the neighbour whose
    // azimuth is closest to the margin vertex (inwards and outwards).
    const spokes = new Int32Array(ring0.length * DEPTH_COUNT);
    ring0.forEach((root, spoke) => {
      const base = spoke * DEPTH_COUNT;
      spokes[base + DEPTH_OFFSET] = root;
      const target = azimuth.get(root);
      for (const direction of [1, -1]) {
        let current = root;
        for (let step = 1; step <= (direction > 0 ? GNM_PLAYER_EYES.spokeDepths.max : -GNM_PLAYER_EYES.spokeDepths.min); step += 1) {
          let best = -1;
          let bestDelta = Infinity;
          for (const candidate of neighbors.get(current)) {
            if (depth.get(candidate) !== direction * step) continue;
            const delta = Math.abs(wrapAngle(azimuthOf(frame, point(template, candidate)) - target));
            if (delta < bestDelta) { bestDelta = delta; best = candidate; }
          }
          if (best >= 0) current = best;
          spokes[base + DEPTH_OFFSET + direction * step] = current;
        }
      }
    });
    const nearestSpoke = (landmark) => {
      const target = [landmarks[landmark * 3], landmarks[landmark * 3 + 1], landmarks[landmark * 3 + 2]];
      let best = 0;
      ring0.forEach((vertex, index) => { if (lengthOf(sub(point(template, vertex), target)) < lengthOf(sub(point(template, ring0[best]), target))) best = index; });
      return best;
    };
    const innerSpoke = nearestSpoke(innerLandmark);
    const outerSpoke = nearestSpoke(outerLandmark);
    const count = ring0.length;
    const walk = (step) => {
      const path = [innerSpoke];
      for (let index = innerSpoke; index !== outerSpoke;) { index = (index + step + count) % count; path.push(index); }
      return path;
    };
    const arcs = [walk(1), walk(-1)];
    const lift = (path) => dot(sub(point(template, ring0[path[path.length >> 1]]), frame.center), frame.up);
    const [upperPath, lowerPath] = lift(arcs[0]) > lift(arcs[1]) ? arcs : [arcs[1], arcs[0]];
    const lid = (path) => {
      const t = new Float64Array(path.length);
      for (let index = 1; index < path.length; index += 1) t[index] = t[index - 1] + lengthOf(sub(point(template, ring0[path[index]]), point(template, ring0[path[index - 1]])));
      const total = t[path.length - 1] || 1;
      for (let index = 0; index < path.length; index += 1) t[index] /= total;
      return Object.freeze({ spokes: Int32Array.from(path), t });
    };
    // Anterior skin around the eye (never the socket lining): lash collision set.
    const collision = [...neighbors.keys()].filter((vertex) => !socket(vertex) && lengthOf(sub(point(template, vertex), frame.center)) < 0.026 && (depth.get(vertex) ?? -1) <= 0);
    return Object.freeze({
      side,
      innerLandmark,
      outerLandmark,
      sclera: eye.sclera,
      pupil: eye.pupil,
      iris: eye.iris,
      limbus: eye.limbus,
      dome: eye.dome,
      spokeCount: count,
      spokes,
      innerSpoke,
      outerSpoke,
      lids: Object.freeze({ upper: lid(upperPath), lower: lid(lowerPath) }),
      collision: Uint32Array.from(collision),
    });
  });
  return Object.freeze({ version: GNM_PLAYER_EYES.version, eyes: Object.freeze(eyes.sort((a, b) => a.side - b.side)) });
}

/** Source id of a spoke at ring `depth` (see GNM_PLAYER_EYES.spokeDepths). */
export function gnmPlayerSpokeVertex(eye, spoke, depth) {
  return eye.spokes[spoke * DEPTH_COUNT + DEPTH_OFFSET + depth];
}

/**
 * Static per-source-vertex skin masks (two floats per vertex):
 * 0 = lash-line darkening at the anterior lid margin (upper lid stronger);
 * 1 = wet posterior margin / inner-canthus (caruncle) tissue.
 */
export function gnmPlayerEyeSurfaceMasks(topology, sourceVertexCount, template) {
  const masks = new Float32Array(sourceVertexCount * 2);
  const raise = (vertex, channel, value) => { masks[vertex * 2 + channel] = Math.max(masks[vertex * 2 + channel], value); };
  for (const eye of topology.eyes) {
    for (const [name, strength] of [["upper", 1], ["lower", 0.55]]) {
      const lid = eye.lids[name];
      lid.spokes.forEach((spoke, index) => {
        const t = lid.t[index];
        // Sparse lashes at the inner corner, a full line towards the outer corner.
        const fade = strength * smoothstep(0.02, 0.22, t) * (1 - 0.3 * smoothstep(0.9, 1, t));
        raise(gnmPlayerSpokeVertex(eye, spoke, -1), 0, fade * 0.85);
        raise(gnmPlayerSpokeVertex(eye, spoke, 0), 0, fade);
        raise(gnmPlayerSpokeVertex(eye, spoke, -2), 0, fade * 0.2);
        raise(gnmPlayerSpokeVertex(eye, spoke, 0), 1, 0.35);
        for (let depth = 1; depth <= 3; depth += 1) raise(gnmPlayerSpokeVertex(eye, spoke, depth), 1, 1);
      });
    }
    // Inner canthus: the whole socket-side surface near the inner corner is
    // caruncle / plica tissue.
    const inner = point(template, gnmPlayerSpokeVertex(eye, eye.innerSpoke, 0));
    for (let spoke = 0; spoke < eye.spokeCount; spoke += 1) {
      for (let depth = 0; depth <= GNM_PLAYER_EYES.spokeDepths.max; depth += 1) {
        const vertex = gnmPlayerSpokeVertex(eye, spoke, depth);
        const distance = lengthOf(sub(point(template, vertex), inner));
        raise(vertex, 1, 1 - smoothstep(0.0035, 0.0065, distance));
      }
    }
  }
  return masks;
}

/**
 * Per-frame eye rig from reconstructed source positions: eyeball and cornea
 * spheres, gaze frame, lid spokes and the lid/eyeball contact line.
 */
export function computeGnmPlayerEyeRig(topology, positions, normals = null) {
  const eyes = topology.eyes.map((eye) => {
    const frame = eyeFrame(positions, eye);
    const cornea = fitGnmPlayerSphere(positions, eye.dome);
    const irisDepth = dot(sub(frame.pupil, frame.center), frame.axis);
    const iris = fitIrisPlane(positions, eye, frame);
    const toCornea = sub(frame.center, cornea.center);
    // Outer envelope of the eyeball: the scleral sphere or the corneal dome.
    const envelope = (direction) => {
      const b = dot(direction, toCornea);
      const discriminant = b * b - (dot(toCornea, toCornea) - cornea.radius * cornea.radius);
      return Math.max(frame.radius, discriminant >= 0 ? -b + Math.sqrt(discriminant) : 0);
    };
    const profiles = new Float64Array(eye.spokeCount * DEPTH_COUNT * 3);
    for (let spoke = 0; spoke < eye.spokeCount; spoke += 1) {
      for (let slot = 0; slot < DEPTH_COUNT; slot += 1) {
        const vertex = eye.spokes[spoke * DEPTH_COUNT + slot];
        for (let axis = 0; axis < 3; axis += 1) profiles[(spoke * DEPTH_COUNT + slot) * 3 + axis] = positions[vertex * 3 + axis];
      }
    }
    const profilePoint = (spoke, depth) => {
      const offset = (spoke * DEPTH_COUNT + DEPTH_OFFSET + depth) * 3;
      return [profiles[offset], profiles[offset + 1], profiles[offset + 2]];
    };
    // Contact: first point from the margin inwards where the lid reaches the
    // eyeball envelope (interpolated), projected onto the envelope.
    const contactDepth = new Float64Array(eye.spokeCount);
    const contacts = new Float64Array(eye.spokeCount * 3);
    const contactPolar = new Float64Array(eye.spokeCount * 2);
    for (let spoke = 0; spoke < eye.spokeCount; spoke += 1) {
      const gap = (depth) => {
        const offset = sub(profilePoint(spoke, depth), frame.center);
        return lengthOf(offset) - envelope(normalize(offset));
      };
      let found = -1;
      let previous = gap(0);
      if (previous <= 0) found = 0;
      for (let depth = 1; found < 0 && depth <= GNM_PLAYER_EYES.spokeDepths.max; depth += 1) {
        const current = gap(depth);
        if (current <= 0) found = depth - 1 + previous / Math.max(previous - current, 1e-9);
        previous = current;
      }
      if (found < 0) {
        let best = Infinity;
        for (let depth = 0; depth <= GNM_PLAYER_EYES.spokeDepths.max; depth += 1) { const value = gap(depth); if (value < best) { best = value; found = depth; } }
      }
      const low = Math.floor(found), high = Math.min(low + 1, GNM_PLAYER_EYES.spokeDepths.max);
      const raw = lerp3(profilePoint(spoke, low), profilePoint(spoke, high), found - low);
      const direction = normalize(sub(raw, frame.center));
      const contact = add(frame.center, scale(direction, envelope(direction)));
      contactDepth[spoke] = found;
      contacts.set(contact, spoke * 3);
      contactPolar[spoke * 2] = azimuthOf(frame, contact);
      contactPolar[spoke * 2 + 1] = Math.acos(clamp(dot(direction, frame.axis), -1, 1));
    }
    return {
      side: eye.side,
      ...frame,
      cornea: { center: cornea.center, radius: cornea.radius, apex: add(cornea.center, scale(frame.axis, cornea.radius)) },
      irisDepth,
      iris,
      envelope,
      profiles,
      profilePoint,
      contactDepth,
      contacts,
      contactPolar,
      contactTable: gnmPlayerContactTable(contactPolar, eye.spokeCount),
      innerCanthus: profilePoint(eye.innerSpoke, 0),
      outerCanthus: profilePoint(eye.outerSpoke, 0),
      openingCenter: averagePoint(contacts, Array.from({ length: eye.spokeCount }, (_, index) => index)),
      skin: normals ? skinGrid(positions, normals, eye.collision) : null,
    };
  });
  return { eyes };
}

/** Collision grid cell (m): every skin vertex within one cell of a query is found. */
const GRID_CELL = 0.0012;

/**
 * Dense uniform grid (counting sort) over the anterior eye-region skin for
 * nearest-vertex queries; built per frame from the reconstructed vertices.
 */
function skinGrid(positions, normals, vertices) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const vertex of vertices) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], positions[vertex * 3 + axis]);
      max[axis] = Math.max(max[axis], positions[vertex * 3 + axis]);
    }
  }
  const size = [0, 1, 2].map((axis) => Math.max(1, Math.floor((max[axis] - min[axis]) / GRID_CELL) + 1));
  const cellOf = (vertex) => {
    const x = Math.min(size[0] - 1, Math.floor((positions[vertex * 3] - min[0]) / GRID_CELL));
    const y = Math.min(size[1] - 1, Math.floor((positions[vertex * 3 + 1] - min[1]) / GRID_CELL));
    const z = Math.min(size[2] - 1, Math.floor((positions[vertex * 3 + 2] - min[2]) / GRID_CELL));
    return x + size[0] * (y + size[1] * z);
  };
  const starts = new Int32Array(size[0] * size[1] * size[2] + 1);
  for (const vertex of vertices) starts[cellOf(vertex) + 1] += 1;
  for (let cell = 1; cell < starts.length; cell += 1) starts[cell] += starts[cell - 1];
  const cursor = starts.slice(0, -1);
  const order = new Int32Array(vertices.length);
  for (const vertex of vertices) order[cursor[cellOf(vertex)]++] = vertex;
  /**
   * Signed distance (along vertex normals) to the skin: the most negative of
   * the three nearest vertices within 1.6 mm (robust in the canthal creases,
   * where neighbouring normals disagree), or null when no skin is that close.
   */
  const signedDistance = (p) => {
    const cx = Math.floor((p[0] - min[0]) / GRID_CELL), cy = Math.floor((p[1] - min[1]) / GRID_CELL), cz = Math.floor((p[2] - min[2]) / GRID_CELL);
    if (cx < -1 || cy < -1 || cz < -1 || cx > size[0] || cy > size[1] || cz > size[2]) return null;
    const nearest = [[-1, Infinity], [-1, Infinity], [-1, Infinity]];
    for (let z = Math.max(cz - 1, 0); z <= Math.min(cz + 1, size[2] - 1); z += 1) {
      for (let y = Math.max(cy - 1, 0); y <= Math.min(cy + 1, size[1] - 1); y += 1) {
        for (let x = Math.max(cx - 1, 0); x <= Math.min(cx + 1, size[0] - 1); x += 1) {
          const cell = x + size[0] * (y + size[1] * z);
          for (let item = starts[cell]; item < starts[cell + 1]; item += 1) {
            const vertex = order[item];
            const ex = p[0] - positions[vertex * 3], ey = p[1] - positions[vertex * 3 + 1], ez = p[2] - positions[vertex * 3 + 2];
            const distance = ex * ex + ey * ey + ez * ez;
            if (distance >= nearest[2][1]) continue;
            nearest[2] = [vertex, distance];
            nearest.sort((a, b) => a[1] - b[1]);
          }
        }
      }
    }
    let result = null;
    for (const [vertex, distance] of nearest) {
      // Beyond ~1.6 mm the tangent plane of a curved lid says nothing reliable.
      if (vertex < 0 || distance > 0.0016 * 0.0016) continue;
      const normal = [normals[vertex * 3], normals[vertex * 3 + 1], normals[vertex * 3 + 2]];
      const signed = (p[0] - positions[vertex * 3]) * normal[0] + (p[1] - positions[vertex * 3 + 1]) * normal[1] + (p[2] - positions[vertex * 3 + 2]) * normal[2];
      if (!result || signed < result.distance) result = { distance: signed, normal };
    }
    return result;
  };
  return { signedDistance };
}

/**
 * Keep a strand outside the eyeball envelope and in front of the anterior
 * lid skin: any point closer than `clearance` is pushed out, and the rest of
 * the strand follows the same offset (the strand bends away, never through).
 */
function resolveStrandCollisions(centre, eyeRig, clearance) {
  for (let index = 1; index < centre.length; index += 1) {
    let offset = [0, 0, 0];
    const fromCenter = sub(centre[index], eyeRig.center);
    const distance = lengthOf(fromCenter);
    const direction = scale(fromCenter, 1 / Math.max(distance, 1e-9));
    const eyeGap = distance - eyeRig.envelope(direction);
    if (eyeGap < clearance) offset = scale(direction, clearance - eyeGap);
    const skin = eyeRig.skin?.signedDistance(add(centre[index], offset));
    if (skin && skin.distance < clearance) offset = add(offset, scale(skin.normal, clearance - skin.distance));
    if (offset[0] === 0 && offset[1] === 0 && offset[2] === 0) continue;
    for (let rest = index; rest < centre.length; rest += 1) centre[rest] = add(centre[rest], offset);
  }
}

/**
 * Resample the contact line (azimuth, polar angle) pairs to a periodic table
 * of polar angles at uniform azimuths: entry i is at azimuth
 * -pi + (i + 0.5) * 2pi / samples.
 */
export function gnmPlayerContactTable(contactPolar, count, samples = GNM_PLAYER_EYES.contactSamples) {
  const entries = Array.from({ length: count }, (_, index) => [contactPolar[index * 2], contactPolar[index * 2 + 1]]).sort((a, b) => a[0] - b[0]);
  const table = new Float32Array(samples);
  for (let sample = 0; sample < samples; sample += 1) {
    const azimuth = -Math.PI + ((sample + 0.5) * 2 * Math.PI) / samples;
    let after = entries.findIndex((entry) => entry[0] >= azimuth);
    if (after < 0) after = 0;
    const before = (after - 1 + entries.length) % entries.length;
    const span = wrapAngle(entries[after][0] - entries[before][0]) || 1e-9;
    const t = clamp(wrapAngle(azimuth - entries[before][0]) / (span < 0 ? span + 2 * Math.PI : span), 0, 1);
    table[sample] = entries[before][1] + (entries[after][1] - entries[before][1]) * t;
  }
  return table;
}

/**
 * Position on a lid at arc parameter t (0 inner canthus .. 1 outer canthus):
 * the bracketing spokes `a`, `b` and the blend `f` between them.
 */
function lidSample(lid, t) {
  let low = 1, high = lid.t.length - 1;
  while (low < high) { const middle = (low + high) >> 1; if (lid.t[middle] < t) low = middle + 1; else high = middle; }
  const t0 = lid.t[low - 1], t1 = lid.t[low];
  return { a: lid.spokes[low - 1], b: lid.spokes[low], f: clamp((t - t0) / Math.max(t1 - t0, 1e-9), 0, 1) };
}

/** Interpolated lid profile point at fractional ring `depth` for a lid sample. */
function lidAt(rig, sample, depth) {
  const low = Math.floor(depth), w = depth - low, high = w > 0 ? low + 1 : low;
  const { profiles } = rig;
  const result = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    const pa = profiles[(sample.a * DEPTH_COUNT + DEPTH_OFFSET + low) * 3 + axis] * (1 - w) + profiles[(sample.a * DEPTH_COUNT + DEPTH_OFFSET + high) * 3 + axis] * w;
    const pb = profiles[(sample.b * DEPTH_COUNT + DEPTH_OFFSET + low) * 3 + axis] * (1 - w) + profiles[(sample.b * DEPTH_COUNT + DEPTH_OFFSET + high) * 3 + axis] * w;
    result[axis] = pa + (pb - pa) * sample.f;
  }
  return result;
}

/** Interpolated lid/eyeball contact point and its fractional ring depth. */
function lidContact(rig, sample) {
  const { a, b, f } = sample;
  return {
    point: [0, 1, 2].map((axis) => rig.contacts[a * 3 + axis] + (rig.contacts[b * 3 + axis] - rig.contacts[a * 3 + axis]) * f),
    depth: rig.contactDepth[a] + (rig.contactDepth[b] - rig.contactDepth[a]) * f,
  };
}

/** Source vertex of the nearer spoke of a lid sample at ring `depth`. */
function lidSource(eye, sample, depth) {
  return gnmPlayerSpokeVertex(eye, sample.f < 0.5 ? sample.a : sample.b, Math.round(depth));
}

/** Inverse CDF of a positive density on [0, 1] (tabulated), for stratified lash roots. */
function inverseDensity(density, samples = 128) {
  const cumulative = new Float64Array(samples + 1);
  for (let index = 0; index < samples; index += 1) cumulative[index + 1] = cumulative[index] + density((index + 0.5) / samples);
  return (u) => {
    const target = clamp(u, 0, 1) * cumulative[samples];
    let low = 0, high = samples - 1;
    while (low < high) { const middle = (low + high) >> 1; if (cumulative[middle + 1] < target) low = middle + 1; else high = middle; }
    const span = cumulative[low + 1] - cumulative[low] || 1;
    return (low + (target - cumulative[low]) / span) / samples;
  };
}

// Sparse at the inner canthus, densest over the outer two thirds.
const LASH_DENSITY = Object.freeze({
  upper: inverseDensity((t) => 0.03 + smoothstep(0.04, 0.32, t) * (0.55 + 0.45 * smoothstep(0.2, 0.62, t)) * (1 - 0.35 * smoothstep(0.86, 1, t))),
  lower: inverseDensity((t) => 0.02 + smoothstep(0.18, 0.5, t) * (1 - 0.3 * smoothstep(0.86, 1, t))),
});

/**
 * Eyelash strands for both eyes. Strand vertices hold centreline points (two
 * per point, one per ribbon side); the renderer expands them into
 * view-aligned ribbons of at least a fraction of a pixel with coverage alpha.
 *
 * Returns positions, unit tangents (`normals`), uvs (side, root-to-tip t),
 * `surface` (half-width in metres, per-strand random, lower-lid flag, 0),
 * the source vertex of each strand root and triangle indices.
 */
export function buildGnmPlayerLashes(topology, rig, seed) {
  const config = GNM_PLAYER_EYES.lashes;
  const points = config.segments + 1;
  const strands = [];
  const counts = { upper: 0, lower: 0 };
  topology.eyes.forEach((eye, eyeIndex) => {
    const eyeRig = rig.eyes[eyeIndex];
    for (const name of ["upper", "lower"]) {
      const lid = eye.lids[name];
      const settings = config[name];
      const random = new Randomizer(hashSeed(`gnm-player:lashes:${seed >>> 0}:${eye.side}:${name}`));
      const lashes = [];
      for (let index = 0; index < settings.count; index += 1) {
        // Fixed number of draws per lash keeps the sequence aligned.
        const draws = Array.from({ length: 8 }, () => random.nextFloat());
        const t = LASH_DENSITY[name]((index + 0.5 + (draws[0] - 0.5) * 0.9) / settings.count);
        const sample = lidSample(lid, t);
        const rootDepth = settings.rootDepth[0] + (settings.rootDepth[1] - settings.rootDepth[0]) * draws[1];
        const margin = lidAt(eyeRig, sample, 0);
        const tangent = normalize(sub(lidAt(eyeRig, lidSample(lid, Math.min(t + 0.02, 1)), -0.5), lidAt(eyeRig, lidSample(lid, Math.max(t - 0.02, 0)), -0.5)));
        // Forward = gaze axis made orthogonal to the lid; away = off the eye opening.
        const forward = normalize(orthogonal(eyeRig.axis, tangent), eyeRig.axis);
        let away = normalize(cross(tangent, forward));
        if (dot(away, orthogonal(sub(margin, eyeRig.openingCenter), eyeRig.axis)) < 0) away = scale(away, -1);
        // Lashes of the inner half are combed towards the vertical instead of
        // fanning out radially with the lid curvature.
        const vertical = normalize(orthogonal(name === "upper" ? eyeRig.up : scale(eyeRig.up, -1), forward), away);
        away = normalize(add(scale(away, 1 - 0.5 * (1 - smoothstep(0.3, 0.75, t))), scale(vertical, 0.5 * (1 - smoothstep(0.3, 0.75, t)))), away);
        // Emerge from just inside the lid margin (away from the opening), so no
        // gap shows at the root and the root never touches the eyeball.
        const root = add(lidAt(eyeRig, sample, rootDepth), scale(away, 0.0001));
        // Longest just past mid-lid, short at both canthi (shortest nasally).
        const lengthProfile = 1 - ((t - settings.peak) / (t < settings.peak ? settings.peak + 0.02 : 1.05 - settings.peak)) ** 2;
        const length = (settings.lengthMm[0] + (settings.lengthMm[1] - settings.lengthMm[0]) * clamp(lengthProfile, 0, 1)) * (0.84 + 0.26 * draws[2]) / 1000;
        const splay = (settings.splayDeg[0] + (settings.splayDeg[1] - settings.splayDeg[0]) * t + (draws[3] - 0.5) * 10) * (Math.PI / 180);
        const tilt = (settings.tiltDeg + (draws[4] - 0.5) * 10) * (Math.PI / 180);
        const curl = settings.curlDeg * (0.82 + 0.3 * draws[5]) * (Math.PI / 180);
        // Initial direction: forward, tilted towards the opening, splayed along the lid.
        let direction = normalize(add(scale(forward, Math.cos(tilt)), scale(away, -Math.sin(tilt))));
        direction = normalize(add(scale(direction, Math.cos(splay)), scale(tangent, Math.sin(splay))));
        const bend = normalize(orthogonal(away, direction), away);
        const centre = [root];
        let current = root;
        const step = length / config.segments;
        for (let segment = 0; segment < config.segments; segment += 1) {
          const u = (segment + 0.5) / config.segments;
          const angle = curl * u ** 0.85;
          const heading = normalize(add(scale(direction, Math.cos(angle)), scale(bend, Math.sin(angle))));
          current = add(current, scale(heading, step));
          centre.push(current);
        }
        lashes.push({ centre, t, random: draws[6], width: settings.rootHalfWidthMm * (0.85 + 0.3 * draws[7]) / 1000, root: lidSource(eye, sample, -1), lower: name === "lower" ? 1 : 0 });
      }
      // Clumps of 2-4 neighbouring lashes pull their tips together (seed-stable sizes).
      const clumps = new Randomizer(hashSeed(`gnm-player:lash-clumps:${seed >>> 0}:${eye.side}:${name}`));
      for (let start = 0; start < lashes.length;) {
        const size = config.clumpSize[0] + Math.floor(clumps.nextFloat() * (config.clumpSize[1] - config.clumpSize[0] + 1));
        const clump = lashes.slice(start, start + size);
        start += size;
        const tip = scale(clump.reduce((sum, lash) => add(sum, lash.centre[points - 1]), [0, 0, 0]), 1 / clump.length);
        for (const lash of clump) {
          const offset = sub(tip, lash.centre[points - 1]);
          lash.centre = lash.centre.map((value, index) => add(value, scale(offset, config.clumpPull * (index / (points - 1)) ** 2)));
        }
      }
      for (const lash of lashes) resolveStrandCollisions(lash.centre, eyeRig, 0.00012 + lash.width);
      strands.push(...lashes);
      counts[name] += lashes.length;
    }
  });
  const vertexCount = strands.length * points * 2;
  const vertices = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const surface = new Float32Array(vertexCount * 4);
  const roots = new Uint32Array(strands.length);
  const indices = new Uint32Array(strands.length * config.segments * 6);
  strands.forEach((strand, index) => {
    roots[index] = strand.root;
    for (let p = 0; p < points; p += 1) {
      const t = p / (points - 1);
      const previous = strand.centre[Math.max(p - 1, 0)], next = strand.centre[Math.min(p + 1, points - 1)];
      const tangent = normalize(sub(next, previous));
      // Thick, dark root tapering quickly to a fine tip.
      const halfWidth = strand.width * (1 - 0.9 * t ** 0.8);
      for (let side = 0; side < 2; side += 1) {
        const vertex = (index * points + p) * 2 + side;
        for (let axis = 0; axis < 3; axis += 1) {
          vertices[vertex * 3 + axis] = strand.centre[p][axis];
          normals[vertex * 3 + axis] = tangent[axis];
        }
        uvs[vertex * 2] = side;
        uvs[vertex * 2 + 1] = t;
        surface[vertex * 4] = halfWidth;
        surface[vertex * 4 + 1] = strand.random;
        surface[vertex * 4 + 2] = strand.lower;
      }
    }
    for (let segment = 0; segment < config.segments; segment += 1) {
      const a = (index * points + segment) * 2;
      indices.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], (index * config.segments + segment) * 6);
    }
  });
  return { vertices, normals, uvs, surface, roots, indices, strandCount: strands.length, counts, pointsPerStrand: points };
}

/**
 * Thin tear meniscus along each lid/eyeball contact: a concave fillet
 * (quadratic Bezier in cross-section) from the eyeball surface into the
 * posterior lid margin. Drawn as wet glass; it never casts shadows.
 */
export function buildGnmPlayerTearLine(topology, rig) {
  const { samples, heightMm, liftMm } = GNM_PLAYER_EYES.tearLine;
  const profile = [0, 1 / 3, 2 / 3, 1];
  const vertices = [], normals = [], uvs = [], indices = [], roots = [];
  topology.eyes.forEach((eye, eyeIndex) => {
    const eyeRig = rig.eyes[eyeIndex];
    for (const name of ["upper", "lower"]) {
      const lid = eye.lids[name];
      const height = heightMm[name] / 1000;
      const base = vertices.length / 3;
      for (let index = 0; index <= samples; index += 1) {
        const t = index / samples;
        const sample = lidSample(lid, t);
        const { point: contact, depth: contactDepth } = lidContact(eyeRig, sample);
        const normal = normalize(sub(contact, eyeRig.center));
        const envelopeNormal = eyeRig.envelope(normal) > eyeRig.radius + 1e-6 ? normalize(sub(contact, eyeRig.cornea.center)) : normal;
        const along = normalize(sub(lidContact(eyeRig, lidSample(lid, Math.min(t + 0.02, 1))).point, lidContact(eyeRig, lidSample(lid, Math.max(t - 0.02, 0))).point));
        let open = normalize(cross(envelopeNormal, along));
        if (dot(open, sub(eyeRig.openingCenter, contact)) < 0) open = scale(open, -1);
        // Lid side: towards the anterior margin along the lid profile, kept above the eyeball.
        const lidDirection = normalize(add(normalize(sub(lidAt(eyeRig, sample, Math.max(contactDepth - 1, -1)), contact)), scale(envelopeNormal, 0.35)), envelopeNormal);
        const lift = scale(envelopeNormal, liftMm / 1000);
        // Taper the meniscus into both canthi.
        const taper = smoothstep(0, 0.08, t) * smoothstep(1, 0.92, t);
        const eyeEnd = add(add(contact, scale(open, height * (0.35 + 0.65 * taper))), lift);
        const lidEnd = add(add(contact, scale(lidDirection, height * (0.35 + 0.65 * taper))), lift);
        const corner = add(contact, lift);
        profile.forEach((s, row) => {
          const position = add(add(scale(eyeEnd, (1 - s) ** 2), scale(corner, 2 * s * (1 - s))), scale(lidEnd, s * s));
          const derivative = add(scale(sub(corner, eyeEnd), 2 * (1 - s)), scale(sub(lidEnd, corner), 2 * s));
          // Cross-section normal, pointing away from the corner (the air side).
          let meniscusNormal = normalize(cross(along, derivative), envelopeNormal);
          if (dot(meniscusNormal, sub(position, corner)) < 0 && dot(meniscusNormal, envelopeNormal) < 0) meniscusNormal = scale(meniscusNormal, -1);
          vertices.push(...position);
          normals.push(...meniscusNormal);
          uvs.push(s, 1);
          roots.push(lidSource(eye, sample, clamp(contactDepth, 0, GNM_PLAYER_EYES.spokeDepths.max)));
          if (index < samples && row < profile.length - 1) {
            const a = base + index * profile.length + row;
            const b = a + profile.length;
            indices.push(a, b, a + 1, a + 1, b, b + 1);
          }
        });
      }
    }
  });
  return { vertices: Float32Array.from(vertices), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), roots: Uint32Array.from(roots) };
}

/**
 * Seed-stable iris and sclera detail. It depends only on the seed, so every
 * other control (including the iris colour) leaves it unchanged.
 */
export function gnmPlayerIrisDetail(profile) {
  const random = new Randomizer(hashSeed(`gnm-player:iris:${profile.seed >>> 0}`));
  const next = () => random.nextFloat();
  const round = (value) => Number(value.toFixed(4));
  return Object.freeze({
    offset: Object.freeze([round(next() * 64), round(next() * 64)]),
    pupil: round(0.27 + 0.07 * next()),
    collarette: round(0.34 + 0.12 * next()),
    fiberContrast: round(0.55 + 0.35 * next()),
    crypts: round(0.35 + 0.5 * next()),
    limbalRing: round(0.55 + 0.35 * next()),
    centralTint: round(next() < 0.45 ? 0.15 + 0.45 * next() : 0.04 * next()),
    vessels: round(0.55 + 0.45 * next()),
  });
}

function srgbToLinearChannel(value) { return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; }
function linearToSrgbChannel(value) { return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055; }

/**
 * Lash pigment (sRGB 0..1) from the scalp hair base pigment: darker than the
 * scalp hair; blond and red lashes stay lighter than black ones but darken
 * towards the root. Age greying is not applied (lashes rarely grey).
 */
export function gnmPlayerLashPigment(profile) {
  const hex = GNM_PLAYER_HAIR_COLORS[getFaceValues(profile).hairColor];
  const hair = [1, 3, 5].map((index) => srgbToLinearChannel(Number.parseInt(hex.slice(index, index + 2), 16) / 255));
  const luminance = 0.2126 * hair[0] + 0.7152 * hair[1] + 0.0722 * hair[2];
  const light = smoothstep(0.02, 0.3, luminance);
  const toSrgb = (factor, floor) => hair.map((value) => Number(linearToSrgbChannel(Math.max(value * factor, floor)).toFixed(4)));
  return Object.freeze({ root: Object.freeze(toSrgb(0.3 - 0.18 * light, 0.004)), tip: Object.freeze(toSrgb(0.62 - 0.17 * light, 0.006)) });
}
