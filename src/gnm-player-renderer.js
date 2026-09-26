/*
 * Sports Face GNM 3D player renderer (Phase 8, opt-in)
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * Dependency-free WebGL2 renderer for `sports/gnm-3d-player-v1`. It loads the
 * render-only official GNM GLB plus the offline player-generator payload,
 * reconstructs each player's official GNM identity on the CPU, computes smooth
 * normals and draws skin, eyes (with a transparent cornea pass), teeth,
 * tongue, a painted + volumetric hair shell, procedural glasses and bun, and
 * a procedural jersey bust. Painting uses procedural fields over official
 * regions: no official textures are used. Any failure falls back to the 2D
 * GNM SVG renderer.
 */

import { renderGnmMorphFace } from "./morph-renderer.js";
import { parseWebglGlb, sha256Bytes, WEBGL_OFFICIAL_ASSET_URL, WEBGL_CAMERA_LIMITS } from "./webgl-renderer.js";
import {
  GNM_PLAYER_METADATA_URL,
  GNM_PLAYER_PAYLOAD_URL,
  GNM_PLAYER_RENDER_STYLE,
  buildGnmPlayerTemplate,
  computeGnmPlayerNormals,
  describeGnmPlayerMapping,
  gnmPlayerAppearance,
  gnmPlayerExpression,
  gnmPlayerFeatureZ,
  gnmPlayerHairShell,
  gnmPlayerLandmarks,
  measureGnmPlayerFeatures,
  parseGnmPlayerPayload,
  reconstructGnmPlayerPositions,
  sampleGnmPlayerIdentity,
} from "./gnm-player-model.js";

export { GNM_PLAYER_RENDER_STYLE };
export const GNM_PLAYER_DEFAULT_CAMERA = Object.freeze({ yaw: 0.38, pitch: -0.06, distance: 1 });
export const GNM_PLAYER_FIELD_OF_VIEW = 0.40;
export const GNM_PLAYER_LIGHTING = Object.freeze({ model: "studio-key-fill-rim-v1", toneMapping: "aces-filmic", skinWrap: 0.38, space: "view" });
const TARGET = Object.freeze([0, 0.246, 0.018]);
const BASE_DISTANCE = 1.0;
const COMPONENT = Object.freeze({ skin: 0, eye: 1, teeth: 2, tongue: 3, hair: 4, cornea: 5, jersey: 6, frame: 7, lens: 8, bun: 9 });
const FALLBACK_MESSAGE = "GNM 3D player no disponible; se ha usado el renderer GNM SVG.";
const canvasState = new WeakMap();
let resourcePromise = null;

function fail(message) { throw new Error(message); }
function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
function srgbToLinear(rgb) { return rgb.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)); }

export function clampGnmPlayerCamera(camera = GNM_PLAYER_DEFAULT_CAMERA) {
  const read = (key) => (camera?.[key] !== null && Number.isFinite(Number(camera?.[key])) ? Number(camera[key]) : GNM_PLAYER_DEFAULT_CAMERA[key]);
  return {
    yaw: clamp(read("yaw"), WEBGL_CAMERA_LIMITS.yaw[0], WEBGL_CAMERA_LIMITS.yaw[1]),
    pitch: clamp(read("pitch"), -0.9, 0.9),
    distance: clamp(read("distance"), WEBGL_CAMERA_LIMITS.distance[0], WEBGL_CAMERA_LIMITS.distance[1]),
  };
}

function typedCopy(asset, accessorIndex, Type, components) {
  const accessor = asset.json.accessors[accessorIndex];
  const view = asset.json.bufferViews[accessor.bufferView];
  const offset = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const length = accessor.count * components * Type.BYTES_PER_ELEMENT;
  if (offset + length > asset.binary.byteLength) fail("GNM player GLB accessor exceeds its buffer");
  return new Type(asset.binary.buffer.slice(asset.binary.byteOffset + offset, asset.binary.byteOffset + offset + length));
}

/** Build render-order static data (combined buffers, index ranges, fields). */
export function buildGnmPlayerStatic(asset, model) {
  if (!asset?.official) fail("GNM player requires the official render GLB");
  const primitives = asset.json.meshes[0].primitives;
  const counts = primitives.map((primitive) => asset.json.accessors[primitive.attributes.POSITION].count);
  const renderCount = counts.reduce((sum, count) => sum + count, 0);
  const positions = new Float32Array(renderCount * 3);
  const uvs = new Float32Array(renderCount * 2);
  const sourceIds = new Uint32Array(renderCount);
  const componentIndices = [];
  let offset = 0;
  primitives.forEach((primitive, index) => {
    positions.set(typedCopy(asset, primitive.attributes.POSITION, Float32Array, 3), offset * 3);
    uvs.set(typedCopy(asset, primitive.attributes.TEXCOORD_0, Float32Array, 2), offset * 2);
    const ids = typedCopy(asset, primitive.extras?.sourceVertexIndicesAccessor, Uint32Array, 1);
    if (ids.length !== counts[index]) fail("GNM player source ids do not match the render vertices");
    sourceIds.set(ids, offset);
    const indexAccessor = asset.json.accessors[primitive.indices];
    const local = typedCopy(asset, primitive.indices, indexAccessor.componentType === 5123 ? Uint16Array : Uint32Array, 1);
    const global = new Uint32Array(local.length);
    for (let item = 0; item < local.length; item += 1) global[item] = local[item] + offset;
    componentIndices.push({ name: primitive.extras.componentName, indices: global });
    offset += counts[index];
  });
  const template = buildGnmPlayerTemplate(model.vertexCount, positions, sourceIds);
  const field = (key) => model.fieldIndex.get(key).index * model.vertexCount;
  const rawField = (key, vertex) => model.fields[field(key) + sourceIds[vertex]];
  const attributes = Array.from({ length: 5 }, () => new Uint8Array(renderCount * 4));
  for (let vertex = 0; vertex < renderCount; vertex += 1) {
    const source = sourceIds[vertex];
    for (let slot = 0; slot < 20; slot += 1) attributes[slot >> 2][vertex * 4 + (slot & 3)] = model.fields[slot * model.vertexCount + source];
  }
  const decoded = (key, vertex) => {
    const spec = model.fieldIndex.get(key);
    return spec.min + (rawField(key, vertex) / 255) * (spec.max - spec.min);
  };
  const byName = Object.fromEntries(componentIndices.map((entry) => [entry.name, entry.indices]));
  const eyeInterior = [];
  const cornea = [];
  for (const name of ["left_eye", "right_eye"]) {
    const indices = byName[name];
    for (let item = 0; item < indices.length; item += 3) {
      const triangle = [indices[item], indices[item + 1], indices[item + 2]];
      (triangle.every((vertex) => decoded("cornea", vertex) >= 0.5) ? cornea : eyeInterior).push(...triangle);
    }
  }
  const shell = [];
  const skin = byName.skin;
  for (let item = 0; item < skin.length; item += 3) {
    const triangle = [skin[item], skin[item + 1], skin[item + 2]];
    if (triangle.every((vertex) => decoded("scalpHeight", vertex) > -62 && decoded("ear", vertex) < 0.5 && decoded("eyeSocket", vertex) < 0.5 && decoded("mouthSock", vertex) < 0.5)) shell.push(...triangle);
  }
  const ranges = {};
  const parts = [
    ["skin", skin],
    ["eye", Uint32Array.from(eyeInterior)],
    ["teeth", Uint32Array.from([...byName.upper_teeth_and_gums, ...byName.lower_teeth_and_gums])],
    ["tongue", byName.tongue],
    ["cornea", Uint32Array.from(cornea)],
    ["hair", Uint32Array.from(shell)],
  ];
  const total = parts.reduce((sum, [, indices]) => sum + indices.length, 0);
  const indices = new Uint32Array(total);
  let cursor = 0;
  for (const [name, part] of parts) {
    indices.set(part, cursor);
    ranges[name] = { start: cursor, count: part.length };
    cursor += part.length;
  }
  const allTriangles = new Uint32Array(componentIndices.reduce((sum, entry) => sum + entry.indices.length, 0));
  cursor = 0;
  for (const entry of componentIndices) {
    for (let item = 0; item < entry.indices.length; item += 1) allTriangles[cursor + item] = sourceIds[entry.indices[item]];
    cursor += entry.indices.length;
  }
  const scalp = new Float32Array(renderCount);
  const front = new Float32Array(renderCount);
  const skinVertex = new Uint8Array(renderCount);
  for (const vertex of skin) skinVertex[vertex] = 1;
  for (let vertex = 0; vertex < renderCount; vertex += 1) {
    scalp[vertex] = decoded("scalpHeight", vertex);
    front[vertex] = decoded("scalpFront", vertex);
  }
  const neckLoop = neckBoundaryLoop(skin, sourceIds, template);
  const anchors = model.metadata.fieldAnchors;
  const bunTarget = [0, (anchors.earTopMm + 72) / 1000, (anchors.earCenterZmm - 62) / 1000];
  let bunAnchor = -1;
  let bunDistance = Infinity;
  for (const vertex of skin) {
    const source = sourceIds[vertex];
    if (Math.abs(template[source * 3]) > 0.006 || decoded("scalpHeight", vertex) <= 0) continue;
    const distance = Math.hypot(template[source * 3] - bunTarget[0], template[source * 3 + 1] - bunTarget[1], template[source * 3 + 2] - bunTarget[2]);
    if (distance < bunDistance) { bunDistance = distance; bunAnchor = source; }
  }
  if (bunAnchor < 0) fail("GNM player bun anchor was not found");
  return { renderCount, positions, uvs, sourceIds, template, attributes, indices, ranges, sourceTriangles: allTriangles, scalp, front, skinVertex, neckLoop, bunAnchor };
}

/** Ordered open-boundary loop of the skin (neck cut), in source ids. */
function neckBoundaryLoop(skinIndices, sourceIds, template) {
  const edges = new Map();
  for (let item = 0; item < skinIndices.length; item += 3) {
    const triangle = [sourceIds[skinIndices[item]], sourceIds[skinIndices[item + 1]], sourceIds[skinIndices[item + 2]]];
    for (let corner = 0; corner < 3; corner += 1) {
      const a = triangle[corner];
      const b = triangle[(corner + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  const neighbors = new Map();
  for (const [key, count] of edges) {
    if (count !== 1) continue;
    const [a, b] = key.split(":").map(Number);
    if (!neighbors.has(a)) neighbors.set(a, []);
    if (!neighbors.has(b)) neighbors.set(b, []);
    neighbors.get(a).push(b);
    neighbors.get(b).push(a);
  }
  const lowest = [...neighbors.keys()].reduce((best, vertex) => (template[vertex * 3 + 1] < template[best * 3 + 1] ? vertex : best));
  const loop = [lowest];
  let previous = -1;
  let current = lowest;
  while (loop.length <= neighbors.size) {
    const next = neighbors.get(current).find((vertex) => vertex !== previous);
    if (next === undefined || next === lowest) break;
    loop.push(next);
    previous = current;
    current = next;
  }
  if (loop.length < 32) fail("GNM player neck boundary loop is incomplete");
  return Uint32Array.from(loop);
}

async function loadGnmPlayerResources() {
  if (!resourcePromise) {
    resourcePromise = (async () => {
      const [glbResponse, metadataResponse, payloadResponse] = await Promise.all([fetch(WEBGL_OFFICIAL_ASSET_URL), fetch(GNM_PLAYER_METADATA_URL), fetch(GNM_PLAYER_PAYLOAD_URL)]);
      if (!glbResponse.ok || !metadataResponse.ok || !payloadResponse.ok) fail("GNM player assets could not be fetched");
      const [glb, metadata, payload] = await Promise.all([glbResponse.arrayBuffer(), metadataResponse.json(), payloadResponse.arrayBuffer()]);
      const [glbHash, payloadHash] = await Promise.all([sha256Bytes(glb), sha256Bytes(payload)]);
      if (payloadHash !== metadata.payload?.sha256 || glbHash !== metadata.source?.renderGlb?.sha256) fail("GNM player payload or render GLB hash is invalid");
      const asset = parseWebglGlb(glb);
      const model = parseGnmPlayerPayload(metadata, payload);
      return { model, asset, staticData: buildGnmPlayerStatic(asset, model) };
    })().catch((error) => {
      resourcePromise = null;
      throw error;
    });
  }
  return resourcePromise;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    fail(`GNM player shader compilation failed: ${log}`);
  }
  return shader;
}

function link(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) fail(`GNM player program link failed: ${gl.getProgramInfoLog(program)}`);
  return program;
}

const MESH_VERTEX = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUv;
layout(location=3) in vec4 aFieldA;
layout(location=4) in vec4 aFieldB;
layout(location=5) in vec4 aFieldC;
layout(location=6) in vec4 aFieldD;
layout(location=7) in vec4 aFieldE;
uniform mat4 uProjection;
uniform mat4 uView;
uniform vec4 uFieldMin[5];
uniform vec4 uFieldMax[5];
out vec3 vViewPosition;
out vec3 vViewNormal;
out vec3 vObject;
out vec2 vUv;
out vec4 vA;
out vec4 vB;
out vec4 vC;
out vec4 vD;
out vec4 vE;
void main() {
  vec4 view = uView * vec4(aPosition, 1.0);
  vViewPosition = view.xyz;
  vViewNormal = mat3(uView) * aNormal;
  vObject = aPosition;
  vUv = aUv;
  vA = mix(uFieldMin[0], uFieldMax[0], aFieldA);
  vB = mix(uFieldMin[1], uFieldMax[1], aFieldB);
  vC = mix(uFieldMin[2], uFieldMax[2], aFieldC);
  vD = mix(uFieldMin[3], uFieldMax[3], aFieldD);
  vE = mix(uFieldMin[4], uFieldMax[4], aFieldE);
  gl_Position = uProjection * view;
}`;

const MESH_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vViewPosition;
in vec3 vViewNormal;
in vec3 vObject;
in vec2 vUv;
in vec4 vA; // lip, mouthSock, teeth, cornea
in vec4 vB; // irisAngle(deg), freckleZone, ear, eyeSocket
in vec4 vC; // scalpHeight(mm), scalpFront(cos azimuth), neckHeight(mm), scarDist(mm)
in vec4 vD; // browT, browD(mm), blushZone, faceMask
in vec4 vE; // beardUpper(mm), beardLower(mm), mouthDX(mm), mouthDY(mm)
uniform int uComponent;
uniform vec3 uSkin;
uniform vec3 uLip;
uniform vec3 uIris;
uniform vec3 uHair;
uniform vec3 uBeard;
uniform vec3 uBrow;
uniform vec3 uKitPrimary;
uniform vec3 uKitSecondary;
uniform vec4 uHairStyle;   // hairline, back, fade, thickness
uniform vec4 uHairStyle2;  // top, texture, pattern(0 plain,1 curly,2 braids,3 bun), visible
uniform vec4 uBeardStyle;  // full, moustache, goatee, density
uniform vec4 uBrowStyle;   // thickness, arch, peak, length
uniform vec4 uFlags;       // freckles, scar, ageShading, beardReach
uniform float uBrowDensity;
uniform vec2 uIrisAngles;  // pupil max, iris max (deg)
uniform mat4 uView;
uniform int uDebugField;   // -1 off, 0..19 normalized field, 20 normals
uniform vec4 uFieldMin[5];
uniform vec4 uFieldMax[5];
out vec4 color;

float hash31(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i), n100 = hash31(i + vec3(1,0,0)), n010 = hash31(i + vec3(0,1,0)), n110 = hash31(i + vec3(1,1,0));
  float n001 = hash31(i + vec3(0,0,1)), n101 = hash31(i + vec3(1,0,1)), n011 = hash31(i + vec3(0,1,1)), n111 = hash31(i + vec3(1,1,1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
vec3 safeNormalize(vec3 value, vec3 fallback) {
  float lengthSquared = dot(value, value);
  return lengthSquared > 1e-12 ? value * inversesqrt(lengthSquared) : fallback;
}
float hairThreshold(float front) {
  float frontWeight = smoothstep(0.15, 0.85, front);
  float backWeight = smoothstep(0.05, 0.75, -front);
  return uHairStyle.x * frontWeight + uHairStyle.y * backWeight;
}
float hairCoverage(float scalp, float front) {
  float threshold = hairThreshold(front);
  float jitter = (noise3(vObject * 380.0) - 0.5) * 2.4 + (noise3(vObject * 1500.0) - 0.5) * 0.8;
  return smoothstep(threshold - 2.2, threshold + 1.6, scalp + jitter);
}
float hairShellThickness(float scalp, float front) {
  float above = scalp - hairThreshold(front);
  if (above <= 0.0) return 0.0;
  float volume = uHairStyle.w + uHairStyle2.x * smoothstep(18.0, 60.0, above);
  float fade = 1.0 - uHairStyle.z * (1.0 - smoothstep(0.15, 0.85, front)) * (1.0 - smoothstep(8.0, 38.0, above));
  return volume * fade * smoothstep(0.0, 6.0, above);
}
vec3 hairAlbedo(out float grain, out float fine, out float clumps) {
  grain = noise3(vObject * vec3(3200.0, 1100.0, 900.0));
  fine = noise3(vObject * vec3(7000.0, 2600.0, 2200.0));
  clumps = noise3(vObject * 420.0);
  float pattern = 1.0;
  if (uHairStyle2.z > 0.5 && uHairStyle2.z < 1.5) pattern = 0.7 + 0.5 * smoothstep(0.3, 0.85, noise3(vObject * 950.0));
  if (uHairStyle2.z > 1.5 && uHairStyle2.z < 2.5) pattern = 0.58 + 0.42 * smoothstep(-0.3, 0.9, sin(vObject.x * 560.0));
  return uHair * (0.36 + 0.22 * grain + 0.14 * fine + 0.14 * clumps) * pattern;
}
float browCoverage() {
  float t = vD.x;
  float d = vD.y;
  if (t < -0.3 || t > 1.4) return 0.0;
  float peak = uBrowStyle.z;
  float span = max(peak, 1.0 - peak);
  float arch = uBrowStyle.y * (1.0 - pow((t - peak) / span, 2.0));
  float center = arch - 0.6;
  float half_ = uBrowStyle.x * 0.5 * mix(1.0, 0.42, smoothstep(0.5, 1.05, t)) * mix(0.82, 1.0, smoothstep(-0.05, 0.18, t));
  float along = smoothstep(-0.08, 0.04, t) * (1.0 - smoothstep(uBrowStyle.w - 0.1, uBrowStyle.w + 0.02, t));
  float across = 1.0 - smoothstep(half_ - 0.9, half_ + 0.5, abs(d - center));
  float strands = 0.55 + 0.45 * noise3(vec3(t * 90.0, d * 1.6, 0.0));
  return along * across * strands * uBrowDensity;
}
float beardCoverage() {
  if (uBeardStyle.w <= 0.0) return 0.0;
  float reach = uFlags.w;
  float breakup = noise3(vObject * 520.0) * 6.0 - 3.0;
  float full = (1.0 - smoothstep(-9.0, 2.0, vE.x - reach + 6.0 + breakup)) * smoothstep(-5.0, 6.0, vE.y + reach + breakup);
  float dx = abs(vE.z);
  float dy = vE.w;
  float moustache = (1.0 - smoothstep(17.0, 27.0, dx + max(dy - 6.0, 0.0) * 0.6 + breakup * 0.5)) * smoothstep(0.8, 4.0, dy) * (1.0 - smoothstep(9.0, 14.0, dy + dx * 0.08));
  float goatee = (1.0 - smoothstep(11.0, 19.0, dx + max(-dy - 26.0, 0.0) * 0.7 + breakup * 0.5)) * smoothstep(-42.0, -33.0, dy) * (1.0 - smoothstep(-8.0, -4.0, dy));
  float link = (1.0 - smoothstep(2.5, 5.5, abs(dx - (23.0 + dy * 0.12)))) * smoothstep(-30.0, -21.0, dy) * (1.0 - smoothstep(1.0, 5.0, dy));
  float frontGate = smoothstep(0.55, 0.8, vC.y);
  float coverage = max(uBeardStyle.x * full, frontGate * max(uBeardStyle.y * moustache, uBeardStyle.z * max(goatee, link)));
  coverage *= (1.0 - vA.x) * (1.0 - vA.y) * (1.0 - vB.z);
  float strands = 0.4 + 0.6 * noise3(vObject * vec3(3400.0, 1200.0, 3400.0));
  return coverage * uBeardStyle.w * mix(strands, 1.0, uBeardStyle.w * 0.4);
}
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 toSrgb(vec3 linear) {
  return mix(linear * 12.92, 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, linear));
}
void main() {
  vec3 viewDirection = safeNormalize(-vViewPosition, vec3(0.0, 0.0, 1.0));
  vec3 normal = safeNormalize(vViewNormal, viewDirection);
  normal = faceforward(normal, -viewDirection, normal);
  if (uDebugField >= 0) {
    if (uDebugField == 20) { color = vec4(normal * 0.5 + 0.5, 1.0); return; }
    vec4 fields[5] = vec4[5](vA, vB, vC, vD, vE);
    int group = uDebugField / 4;
    int channel = uDebugField - group * 4;
    float value = (fields[group][channel] - uFieldMin[group][channel]) / max(uFieldMax[group][channel] - uFieldMin[group][channel], 1e-6);
    color = vec4(mix(vec3(0.05, 0.1, 0.45), vec3(1.0, 0.85, 0.2), clamp(value, 0.0, 1.0)), 1.0);
    return;
  }
  vec3 albedo = uSkin;
  float roughness = 0.52;
  float f0 = 0.028;
  float wrap = 0.38;
  float sheen = 0.0;
  if (uComponent == 0) {
    float variation = noise3(vObject * 900.0) * 0.6 + noise3(vObject * 180.0) * 0.4;
    albedo *= 0.965 + 0.07 * variation;
    albedo = mix(albedo, albedo * vec3(1.07, 0.86, 0.84), vD.z * 0.42);
    albedo = mix(albedo, albedo * vec3(0.94, 0.74, 0.74), vB.w * 0.65);
    albedo = mix(albedo, uLip, smoothstep(0.15, 0.85, vA.x));
    roughness = mix(roughness, 0.36, vA.x);
    albedo = mix(albedo, vec3(0.28, 0.07, 0.07), vA.y);
    if (uFlags.x > 0.5) {
      float spots = smoothstep(0.72, 0.8, noise3(vObject * 1400.0)) * smoothstep(0.2, 0.6, vB.y);
      albedo = mix(albedo, albedo * vec3(0.72, 0.58, 0.5), spots * 0.55);
    }
    if (uFlags.y > 0.5) {
      float scar = (1.0 - smoothstep(0.6, 1.3, vC.w)) * (1.0 - vB.w);
      albedo = mix(albedo, albedo * vec3(1.12, 0.93, 0.93) + vec3(0.03), scar * 0.8);
    }
    albedo *= mix(1.0, 0.93, uFlags.z * vD.w * (1.0 - vA.x));
    float brow = browCoverage();
    albedo = mix(albedo, uBrow, clamp(brow, 0.0, 1.0));
    float beard = beardCoverage();
    albedo = mix(albedo, uBeard, clamp(beard, 0.0, 1.0));
    roughness = mix(roughness, 0.7, max(brow, beard));
    if (uHairStyle2.w > 0.5) {
      float hair = hairCoverage(vC.x, vC.y);
      float grain;
      float fine;
      float clumps;
      vec3 painted = hairAlbedo(grain, fine, clumps);
      float strands = 0.55 + 0.45 * grain;
      albedo = mix(albedo, painted, hair * mix(strands, 1.0, smoothstep(0.6, 1.0, hair)));
      roughness = mix(roughness, 0.62, hair);
    }
    float collar = 1.0 - smoothstep(2.5, 4.0, vC.z);
    albedo = mix(albedo, uKitSecondary, collar);
    roughness = mix(roughness, 0.8, collar);
  } else if (uComponent == 1) {
    float angle = vB.x;
    float pupil = 1.0 - smoothstep(uIrisAngles.x - 1.2, uIrisAngles.x + 0.3, angle);
    float iris = 1.0 - smoothstep(uIrisAngles.y - 1.0, uIrisAngles.y + 0.6, angle);
    vec3 sclera = vec3(0.60, 0.58, 0.55) * mix(1.0, 0.78, smoothstep(35.0, 90.0, angle));
    sclera = mix(sclera, vec3(0.62, 0.42, 0.40), smoothstep(50.0, 90.0, angle) * 0.3);
    float fibers = noise3(vec3(vUv * 420.0, angle * 0.4));
    vec3 irisColor = uIris * (0.72 + 0.55 * fibers) * mix(1.0, 0.55, smoothstep(uIrisAngles.y - 5.0, uIrisAngles.y, angle));
    irisColor = mix(irisColor, uIris * 1.25 + vec3(0.03), (1.0 - smoothstep(uIrisAngles.x, uIrisAngles.x + 4.0, angle)) * 0.35);
    albedo = mix(sclera, irisColor, iris);
    albedo = mix(albedo, vec3(0.015), pupil);
    albedo *= 0.82;
    roughness = 0.35;
    wrap = 0.1;
  } else if (uComponent == 2) {
    albedo = mix(vec3(0.72, 0.36, 0.36), vec3(0.90, 0.87, 0.78), vA.z);
    roughness = mix(0.5, 0.3, vA.z);
    wrap = 0.2;
  } else if (uComponent == 3) {
    albedo = vec3(0.66, 0.30, 0.29);
    roughness = 0.45;
  } else if (uComponent == 4 || uComponent == 9) {
    if (uComponent == 4) {
      // Where the shell is (nearly) coincident with the painted skin, let the
      // skin draw instead of z-fighting with it.
      float coverage = hairCoverage(vC.x, vC.y);
      if (coverage < 0.5 || vB.z > 0.5 || hairShellThickness(vC.x, vC.y) < 0.6) discard;
    }
    float grain;
    float fine;
    float clumps;
    albedo = hairAlbedo(grain, fine, clumps);
    normal = safeNormalize(normal + (vec3(grain, fine, clumps) - 0.5) * 0.35 * (0.6 + uHairStyle2.y), normal);
    roughness = 0.6 - 0.12 * uHairStyle2.y;
    f0 = 0.046;
    wrap = 0.45;
    sheen = 0.5;
  } else if (uComponent == 5 || uComponent == 8) {
    vec3 keyLight = normalize(vec3(-0.45, 0.62, 0.64));
    vec3 halfVector = normalize(keyLight + viewDirection);
    float spec = pow(max(dot(normal, halfVector), 0.0), 260.0) * 2.2 + pow(max(dot(normal, normalize(vec3(0.55, 0.2, 0.8) + viewDirection)), 0.0), 180.0) * 0.35;
    float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(normal, viewDirection), 0.0), 5.0);
    vec3 reflected = mix(vec3(0.05, 0.06, 0.08), vec3(0.55, 0.6, 0.68), clamp(reflect(-viewDirection, normal).y * 0.5 + 0.5, 0.0, 1.0));
    float lens = uComponent == 8 ? 1.0 : 0.0;
    vec3 premultiplied = reflected * fresnel * mix(0.6, 0.9, lens) + vec3(spec) * mix(1.0, 0.7, lens) + vec3(0.01, 0.012, 0.016) * lens;
    float a = clamp(fresnel * mix(0.55, 0.7, lens) + spec + 0.06 * lens, 0.0, 1.0);
    color = vec4(toSrgb(aces(premultiplied)), a);
    return;
  } else if (uComponent == 7) {
    albedo = vec3(0.018, 0.016, 0.015);
    roughness = 0.28;
    f0 = 0.05;
    wrap = 0.1;
  } else if (uComponent == 6) {
    float collarBand = 1.0 - smoothstep(0.03, 0.045, vUv.y);
    albedo = mix(uKitPrimary, uKitSecondary, collarBand);
    float weave = noise3(vObject * 2600.0) * 0.6 + noise3(vObject * 600.0) * 0.4;
    albedo *= (0.88 + 0.14 * weave) * mix(1.0, 0.72, smoothstep(0.6, 1.0, vUv.y));
    roughness = 0.78;
    f0 = 0.03;
    wrap = 0.3;
  }
  vec3 keyDirection = normalize(vec3(-0.45, 0.62, 0.64));
  vec3 fillDirection = normalize(vec3(0.75, 0.08, 0.66));
  vec3 rimDirection = normalize(vec3(0.35, 0.55, -0.76));
  vec3 keyColor = vec3(1.0, 0.95, 0.88) * 2.35;
  vec3 fillColor = vec3(0.58, 0.66, 0.82) * 0.62;
  vec3 rimColor = vec3(0.92, 0.96, 1.0) * 1.6;
  float hemisphere = normal.y * 0.5 + 0.5;
  vec3 ambient = mix(vec3(0.075, 0.062, 0.055), vec3(0.19, 0.205, 0.235), hemisphere);
  vec3 lighting = ambient;
  vec3 specular = vec3(0.0);
  float alphaRoughness = max(0.04, roughness * roughness);
  float normalView = max(dot(normal, viewDirection), 1e-3);
  vec3 directions[3] = vec3[3](keyDirection, fillDirection, rimDirection);
  vec3 colors[3] = vec3[3](keyColor, fillColor, rimColor);
  for (int index = 0; index < 3; index += 1) {
    vec3 lightDirection = directions[index];
    float lambert = dot(normal, lightDirection);
    float wrapped = clamp((lambert + wrap) / (1.0 + wrap), 0.0, 1.0);
    vec3 scatter = (uComponent == 0) ? vec3(1.0, 0.42, 0.28) * (wrapped - clamp(lambert, 0.0, 1.0)) * 0.55 : vec3(0.0);
    lighting += colors[index] * (wrapped + scatter);
    vec3 halfVector = safeNormalize(lightDirection + viewDirection, normal);
    float normalHalf = max(dot(normal, halfVector), 0.0);
    float normalLight = clamp(lambert, 0.0, 1.0);
    float denominator = normalHalf * normalHalf * (alphaRoughness * alphaRoughness - 1.0) + 1.0;
    float distribution = alphaRoughness * alphaRoughness / (3.14159 * denominator * denominator);
    float k = alphaRoughness * 0.5;
    float visibility = 0.25 / ((normalLight * (1.0 - k) + k) * (normalView * (1.0 - k) + k));
    float fresnel = f0 + (1.0 - f0) * pow(1.0 - max(dot(halfVector, viewDirection), 0.0), 5.0);
    specular += colors[index] * distribution * visibility * fresnel * normalLight;
  }
  float rimSheen = pow(1.0 - normalView, 3.0) * sheen;
  if (uComponent == 4) {
    vec3 flow = mat3(uView) * normalize(vec3(0.0, -0.45, -1.0));
    vec3 tangent = safeNormalize(flow - normal * dot(normal, flow), vec3(1.0, 0.0, 0.0));
    vec3 halfKey = safeNormalize(keyDirection + viewDirection, normal);
    float th = dot(tangent, halfKey);
    float kajiya = pow(sqrt(max(1.0 - th * th, 0.0)), 70.0);
    specular = specular * 0.25 + keyColor * kajiya * 0.09 * (0.5 + uHair * 1.5);
  }
  vec3 radiance = albedo * lighting * 0.62 + specular + uHair * rimSheen * 0.25;
  if (any(isnan(radiance)) || any(isinf(radiance))) radiance = albedo * 0.5;
  color = vec4(toSrgb(aces(radiance)), 1.0);
}`;

const BACKGROUND_VERTEX = `#version 300 es
out vec2 vScreen;
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vScreen = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const BACKGROUND_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vScreen;
uniform vec3 uKitPrimary;
out vec4 color;
void main() {
  vec2 p = vScreen - vec2(0.5, 0.58);
  float glow = exp(-dot(p, p) * 4.2);
  vec3 dark = vec3(0.028, 0.036, 0.052);
  vec3 tone = mix(dark, uKitPrimary * 0.55 + dark, glow * 0.55);
  tone *= 1.0 - 0.35 * smoothstep(0.35, 0.9, length(vScreen - 0.5));
  float stripes = step(0.5, fract((vScreen.x + vScreen.y) * 18.0)) * 0.008;
  color = vec4(pow(tone + stripes * glow, vec3(1.0 / 2.2)), 1.0);
}`;

function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
}

function lookAt(eye, target, up) {
  const z = normalize3([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = normalize3(cross3(up, z));
  const y = cross3(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1,
  ]);
}
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function normalize3(a) { const length = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / length, a[1] / length, a[2] / length]; }

/** Orbit camera around the portrait target; returns view/projection matrices. */
export function buildGnmPlayerCamera(camera, aspect) {
  const safe = clampGnmPlayerCamera(camera);
  const distance = BASE_DISTANCE * safe.distance;
  const eye = [
    TARGET[0] + distance * Math.sin(safe.yaw) * Math.cos(safe.pitch),
    TARGET[1] + distance * Math.sin(-safe.pitch),
    TARGET[2] + distance * Math.cos(safe.yaw) * Math.cos(safe.pitch),
  ];
  return { view: lookAt(eye, TARGET, [0, 1, 0]), projection: perspective(GNM_PLAYER_FIELD_OF_VIEW, aspect, 0.05, 5), eye, camera: safe };
}

/** Closed or open tube mesh around a polyline (frames, bridge, temples). */
export function buildGnmPlayerTube(points, radius, { closed = false, sides = 8, reference = [0, 1, 0] } = {}) {
  const count = points.length;
  const vertices = [];
  const normals = [];
  const uvs = [];
  for (let index = 0; index < count; index += 1) {
    const previous = points[closed ? (index - 1 + count) % count : Math.max(0, index - 1)];
    const next = points[closed ? (index + 1) % count : Math.min(count - 1, index + 1)];
    const tangent = normalize3([next[0] - previous[0], next[1] - previous[1], next[2] - previous[2]]);
    let side = cross3(tangent, reference);
    if (Math.hypot(...side) < 1e-6) side = cross3(tangent, [1, 0, 0]);
    side = normalize3(side);
    const up = cross3(side, tangent);
    for (let ring = 0; ring < sides; ring += 1) {
      const angle = (ring / sides) * Math.PI * 2;
      const normal = [side[0] * Math.cos(angle) + up[0] * Math.sin(angle), side[1] * Math.cos(angle) + up[1] * Math.sin(angle), side[2] * Math.cos(angle) + up[2] * Math.sin(angle)];
      vertices.push(points[index][0] + normal[0] * radius, points[index][1] + normal[1] * radius, points[index][2] + normal[2] * radius);
      normals.push(...normal);
      uvs.push(index / count, ring / sides);
    }
  }
  const indices = [];
  const segments = closed ? count : count - 1;
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % count;
    for (let ring = 0; ring < sides; ring += 1) {
      const a = index * sides + ring;
      const b = index * sides + ((ring + 1) % sides);
      const c = next * sides + ring;
      const d = next * sides + ((ring + 1) % sides);
      indices.push(a, c, b, b, c, d);
    }
  }
  return { vertices: Float32Array.from(vertices), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) };
}

function mergeMeshes(meshes) {
  const parts = meshes.filter(Boolean);
  const vertexTotal = parts.reduce((sum, mesh) => sum + mesh.vertices.length, 0);
  const merged = { vertices: new Float32Array(vertexTotal), normals: new Float32Array(vertexTotal), uvs: new Float32Array((vertexTotal / 3) * 2), indices: new Uint32Array(parts.reduce((sum, mesh) => sum + mesh.indices.length, 0)) };
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const mesh of parts) {
    merged.vertices.set(mesh.vertices, vertexOffset * 3);
    merged.normals.set(mesh.normals, vertexOffset * 3);
    merged.uvs.set(mesh.uvs, vertexOffset * 2);
    for (let index = 0; index < mesh.indices.length; index += 1) merged.indices[indexOffset + index] = mesh.indices[index] + vertexOffset;
    vertexOffset += mesh.vertices.length / 3;
    indexOffset += mesh.indices.length;
  }
  return merged;
}

/**
 * Procedural glasses fitted to the player's reconstructed official landmarks:
 * rounded rims in front of each eye, a bridge over the nose and temples that
 * run above the ears. Frames are opaque; lenses are drawn in the glass pass.
 */
export function buildGnmPlayerGlasses(landmarks, positions, fixedVertices) {
  const point = (index) => [landmarks[index * 3], landmarks[index * 3 + 1], landmarks[index * 3 + 2]];
  const average = (indices) => indices.map(point).reduce((sum, value) => sum.map((item, axis) => item + value[axis] / indices.length), [0, 0, 0]);
  const vertex = (key) => { const id = fixedVertices[key]; return [positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]]; };
  const tilt = 0.14;
  const planeNormal = [0, Math.sin(tilt), Math.cos(tilt)];
  const browFront = Math.max(point(19)[2], point(24)[2]);
  const rims = [];
  const lenses = [];
  const anchors = [];
  for (const [side, eye, outer, inner] of [[-1, [36, 37, 38, 39, 40, 41], 36, 39], [1, [42, 43, 44, 45, 46, 47], 45, 42]]) {
    const center = average(eye);
    const width = Math.abs(point(outer)[0] - point(inner)[0]);
    const halfWidth = width * 0.98 + 0.002;
    const halfHeight = halfWidth * 0.66;
    const lensCenter = [center[0] + side * 0.0025, center[1] + 0.0015, Math.max(browFront + 0.004, center[2] + 0.015)];
    const outline = [];
    for (let index = 0; index < 40; index += 1) {
      const angle = (index / 40) * Math.PI * 2;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const x = halfWidth * Math.sign(c) * Math.abs(c) ** (2 / 3.2);
      const y = halfHeight * Math.sign(s) * Math.abs(s) ** (2 / 2.6) * (s < 0 ? 0.92 : 1);
      outline.push([lensCenter[0] + x, lensCenter[1] + y * Math.cos(tilt), lensCenter[2] - y * Math.sin(tilt)]);
    }
    rims.push(buildGnmPlayerTube(outline, 0.0013, { closed: true, sides: 7, reference: planeNormal }));
    const fan = { vertices: [], normals: [], uvs: [], indices: [] };
    fan.vertices.push(...lensCenter);
    fan.normals.push(...planeNormal);
    fan.uvs.push(0.5, 0.5);
    outline.forEach((item) => {
      fan.vertices.push(lensCenter[0] + (item[0] - lensCenter[0]) * 0.97, lensCenter[1] + (item[1] - lensCenter[1]) * 0.97, lensCenter[2] + (item[2] - lensCenter[2]) * 0.97);
      fan.normals.push(...planeNormal);
      fan.uvs.push(0, 0);
    });
    for (let index = 0; index < outline.length; index += 1) fan.indices.push(0, 1 + index, 1 + ((index + 1) % outline.length));
    lenses.push({ vertices: Float32Array.from(fan.vertices), normals: Float32Array.from(fan.normals), uvs: Float32Array.from(fan.uvs), indices: Uint32Array.from(fan.indices) });
    anchors.push({ side, lensCenter, halfWidth, halfHeight });
  }
  const [right, left] = anchors;
  const bridgeY = (right.lensCenter[1] + left.lensCenter[1]) / 2 + right.halfHeight * 0.35;
  const bridgeZ = Math.max(point(28)[2] + 0.004, right.lensCenter[2]);
  const bridgeStart = [right.lensCenter[0] + right.halfWidth, bridgeY, right.lensCenter[2]];
  const bridgeEnd = [left.lensCenter[0] - left.halfWidth, bridgeY, left.lensCenter[2]];
  const bridge = [];
  for (let index = 0; index <= 8; index += 1) {
    const t = index / 8;
    const lift = Math.sin(Math.PI * t);
    bridge.push([bridgeStart[0] + (bridgeEnd[0] - bridgeStart[0]) * t, bridgeY + 0.003 * lift, bridgeStart[2] + (bridgeZ - bridgeStart[2]) * lift]);
  }
  const temples = anchors.map((anchor) => {
    const ear = vertex(anchor.side < 0 ? "rightEarTop" : "leftEarTop");
    const contour = point(anchor.side < 0 ? 0 : 16);
    const start = [anchor.lensCenter[0] + anchor.side * anchor.halfWidth, anchor.lensCenter[1] + anchor.halfHeight * 0.35, anchor.lensCenter[2]];
    const hinge = [start[0] + anchor.side * 0.004, start[1], start[2] - 0.012];
    const side = anchor.side * Math.max(Math.abs(contour[0]) + 0.006, Math.abs(hinge[0]));
    const end = [ear[0] + anchor.side * 0.004, ear[1] + 0.002, ear[2] - 0.006];
    const path = [start, hinge];
    for (let index = 1; index <= 6; index += 1) {
      const t = index / 6;
      path.push([side + (end[0] - side) * t * t, hinge[1] + (end[1] - hinge[1]) * t, hinge[2] + (end[2] - hinge[2]) * t]);
    }
    return buildGnmPlayerTube(path, 0.0011, { sides: 6 });
  });
  return { frames: mergeMeshes([...rims, buildGnmPlayerTube(bridge, 0.0012, { sides: 6 }), ...temples]), lenses: mergeMeshes(lenses) };
}

/** Hair bun: a slightly flattened sphere seated on the upper back of the head. */
export function buildGnmPlayerBun(anchor, positions, normals) {
  const radius = 0.03;
  const normal = [normals[anchor * 3], normals[anchor * 3 + 1], normals[anchor * 3 + 2]];
  const center = [positions[anchor * 3] + normal[0] * radius * 0.72, positions[anchor * 3 + 1] + normal[1] * radius * 0.72, positions[anchor * 3 + 2] + normal[2] * radius * 0.72];
  const vertices = [];
  const meshNormals = [];
  const uvs = [];
  const rings = 12;
  const segments = 18;
  for (let ring = 0; ring <= rings; ring += 1) {
    const phi = (ring / rings) * Math.PI;
    for (let segment = 0; segment <= segments; segment += 1) {
      const theta = (segment / segments) * Math.PI * 2;
      const direction = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      vertices.push(center[0] + direction[0] * radius, center[1] + direction[1] * radius * 0.86, center[2] + direction[2] * radius * 0.92);
      meshNormals.push(...normalize3([direction[0], direction[1] / 0.86, direction[2] / 0.92]));
      uvs.push(segment / segments, ring / rings);
    }
  }
  const indices = [];
  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const a = ring * (segments + 1) + segment;
      const b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { vertices: Float32Array.from(vertices), normals: Float32Array.from(meshNormals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) };
}

/**
 * Procedural jersey bust grown from the neck boundary loop: each ring blends
 * the (per-player) neck cut towards a superellipse shoulder cross-section.
 */
export function buildGnmPlayerBust(loop, positions) {
  const count = loop.length;
  let cx = 0;
  let cz = 0;
  let bottom = Infinity;
  for (const vertex of loop) {
    cx += positions[vertex * 3];
    cz += positions[vertex * 3 + 2];
    bottom = Math.min(bottom, positions[vertex * 3 + 1]);
  }
  cx /= count;
  cz /= count;
  const halfWidth = 0.215;
  const halfDepth = 0.115;
  const exponent = 2 / 3.2;
  // Lateral profile: collar, a gentle trapezius slope, a rounded shoulder cap,
  // then the arm dropping almost vertically.
  const rings = [
    { blend: 0.0, drop: 0.0, v: 0.0 },
    { blend: 0.03, drop: 0.003, v: 0.05 },
    { blend: 0.08, drop: 0.006, v: 0.1 },
    { blend: 0.3, drop: 0.012, v: 0.3 },
    { blend: 0.62, drop: 0.022, v: 0.5 },
    { blend: 0.84, drop: 0.036, v: 0.64 },
    { blend: 0.95, drop: 0.058, v: 0.74 },
    { blend: 1.0, drop: 0.095, v: 0.84 },
    { blend: 1.0, drop: 0.22, v: 1.0 },
  ];
  const vertices = new Float32Array(rings.length * count * 3);
  const uvs = new Float32Array(rings.length * count * 2);
  rings.forEach((ring, ringIndex) => {
    for (let index = 0; index < count; index += 1) {
      const vertex = loop[index];
      const x = positions[vertex * 3];
      const y = positions[vertex * 3 + 1];
      const z = positions[vertex * 3 + 2];
      const angle = Math.atan2(x - cx, z - cz);
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      const shoulderX = cx + halfWidth * Math.sign(sin) * Math.abs(sin) ** exponent;
      const shoulderZ = cz - 0.012 + halfDepth * Math.sign(cos) * Math.abs(cos) ** exponent;
      const lateral = Math.abs(sin) ** 1.6;
      const shoulderY = bottom - 0.004 - 0.028 * lateral;
      const t = ring.blend;
      const out = (ringIndex * count + index) * 3;
      vertices[out] = x + (shoulderX - x) * t;
      const last = ringIndex === rings.length - 1;
      vertices[out + 1] = y + (shoulderY - y) * Math.min(1, t * 2.2) - ring.drop * (last ? 1 : 0.35 + 0.65 * lateral);
      vertices[out + 2] = z + (shoulderZ - z) * t;
      uvs[(ringIndex * count + index) * 2] = index / count;
      uvs[(ringIndex * count + index) * 2 + 1] = ring.v;
    }
  });
  const indices = [];
  for (let ringIndex = 0; ringIndex < rings.length - 1; ringIndex += 1) {
    for (let index = 0; index < count; index += 1) {
      const a = ringIndex * count + index;
      const b = ringIndex * count + ((index + 1) % count);
      const c = a + count;
      const d = b + count;
      indices.push(a, c, b, b, c, d);
    }
  }
  const normals = new Float32Array(vertices.length);
  for (let item = 0; item < indices.length; item += 3) {
    const [a, b, c] = [indices[item] * 3, indices[item + 1] * 3, indices[item + 2] * 3];
    const ab = [vertices[b] - vertices[a], vertices[b + 1] - vertices[a + 1], vertices[b + 2] - vertices[a + 2]];
    const ac = [vertices[c] - vertices[a], vertices[c + 1] - vertices[a + 1], vertices[c + 2] - vertices[a + 2]];
    const n = cross3(ab, ac);
    for (const vertex of [a, b, c]) { normals[vertex] += n[0]; normals[vertex + 1] += n[1]; normals[vertex + 2] += n[2]; }
  }
  for (let vertex = 0; vertex < normals.length; vertex += 3) normals.set(normalize3([normals[vertex], normals[vertex + 1], normals[vertex + 2]]), vertex);
  return { vertices, normals, uvs, indices: Uint32Array.from(indices) };
}

function createBuffers(gl, program, staticData, model) {
  const buffer = (target, data, usage) => {
    const handle = gl.createBuffer();
    gl.bindBuffer(target, handle);
    gl.bufferData(target, data, usage);
    return handle;
  };
  const positionBuffer = buffer(gl.ARRAY_BUFFER, staticData.positions, gl.DYNAMIC_DRAW);
  const normalBuffer = buffer(gl.ARRAY_BUFFER, new Float32Array(staticData.renderCount * 3), gl.DYNAMIC_DRAW);
  const shellBuffer = buffer(gl.ARRAY_BUFFER, staticData.positions, gl.DYNAMIC_DRAW);
  const uvBuffer = buffer(gl.ARRAY_BUFFER, staticData.uvs, gl.STATIC_DRAW);
  const fieldBuffers = staticData.attributes.map((data) => buffer(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW));
  const indexBuffer = buffer(gl.ELEMENT_ARRAY_BUFFER, staticData.indices, gl.STATIC_DRAW);
  const vao = (position) => {
    const handle = gl.createVertexArray();
    gl.bindVertexArray(handle);
    gl.bindBuffer(gl.ARRAY_BUFFER, position);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
    fieldBuffers.forEach((field, index) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, field);
      gl.enableVertexAttribArray(3 + index);
      gl.vertexAttribPointer(3 + index, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    });
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bindVertexArray(null);
    return handle;
  };
  const extraMesh = () => {
    const mesh = { vao: gl.createVertexArray(), position: gl.createBuffer(), normal: gl.createBuffer(), uv: gl.createBuffer(), index: gl.createBuffer(), count: 0 };
    gl.bindVertexArray(mesh.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.position);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normal);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uv);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
    for (let index = 3; index < 8; index += 1) gl.disableVertexAttribArray(index);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.index);
    gl.bindVertexArray(null);
    return mesh;
  };
  const fieldMin = [];
  const fieldMax = [];
  for (const field of model.metadata.fields) { fieldMin.push(field.min); fieldMax.push(field.max); }
  return { positionBuffer, normalBuffer, shellBuffer, meshVao: vao(positionBuffer), shellVao: vao(shellBuffer), bust: extraMesh(), frames: extraMesh(), lenses: extraMesh(), bun: extraMesh(), fieldMin: new Float32Array(fieldMin), fieldMax: new Float32Array(fieldMax) };
}

function uniformLocations(gl, program, names) {
  return Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]));
}

function createGlState(gl, resources) {
  const meshProgram = link(gl, MESH_VERTEX, MESH_FRAGMENT);
  const backgroundProgram = link(gl, BACKGROUND_VERTEX, BACKGROUND_FRAGMENT);
  const buffers = createBuffers(gl, meshProgram, resources.staticData, resources.model);
  return {
    gl,
    meshProgram,
    backgroundProgram,
    backgroundVao: gl.createVertexArray(),
    buffers,
    meshUniforms: uniformLocations(gl, meshProgram, ["uProjection", "uView", "uFieldMin", "uFieldMax", "uComponent", "uSkin", "uLip", "uIris", "uHair", "uBeard", "uBrow", "uKitPrimary", "uKitSecondary", "uHairStyle", "uHairStyle2", "uBeardStyle", "uBrowStyle", "uFlags", "uBrowDensity", "uIrisAngles", "uDebugField"]),
    backgroundUniforms: uniformLocations(gl, backgroundProgram, ["uKitPrimary"]),
  };
}

const HAIR_PATTERNS = Object.freeze({ plain: 0, curly: 1, braids: 2, bun: 3 });

/** CPU work for one player: identity, expression, positions, normals, hair shell, bust. */
export function computeGnmPlayerFrame(resources, profile, options = {}) {
  const { model, staticData } = resources;
  const identity = sampleGnmPlayerIdentity(profile, model);
  const expression = gnmPlayerExpression(profile, options.expressionMode);
  const appearance = gnmPlayerAppearance(profile);
  const positions = reconstructGnmPlayerPositions(model, staticData.template, identity, expression.weights);
  const normals = computeGnmPlayerNormals(positions, staticData.sourceTriangles, model.vertexCount);
  const renderPositions = new Float32Array(staticData.renderCount * 3);
  const renderNormals = new Float32Array(staticData.renderCount * 3);
  for (let vertex = 0; vertex < staticData.renderCount; vertex += 1) {
    const source = staticData.sourceIds[vertex] * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      renderPositions[vertex * 3 + axis] = positions[source + axis];
      renderNormals[vertex * 3 + axis] = normals[source + axis];
    }
  }
  const shell = gnmPlayerHairShell(appearance.hairStyle, staticData, renderPositions, renderNormals);
  const bust = buildGnmPlayerBust(staticData.neckLoop, positions);
  const landmarks = gnmPlayerLandmarks(model, positions);
  const glasses = appearance.glasses ? buildGnmPlayerGlasses(landmarks, positions, model.fixedVertices) : null;
  const bun = appearance.hairStyle?.pattern === "bun" ? buildGnmPlayerBun(staticData.bunAnchor, positions, normals) : null;
  // `measured` includes the micro-expression (it is the rendered mesh);
  // identity-only z-scores come from the exact linear model.
  const measured = measureGnmPlayerFeatures(model, positions);
  return { identity, expression, appearance, renderPositions, renderNormals, shell, bust, glasses, bun, measured, identityFeatureZ: identity.realizedZ, renderedFeatureZ: gnmPlayerFeatureZ(model, measured) };
}

function uploadFrame(state, frame) {
  const { gl, buffers } = state;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.positionBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, frame.renderPositions);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.normalBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, frame.renderNormals);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.shellBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, frame.shell.positions);
  const uploadMesh = (target, mesh) => {
    gl.bindVertexArray(target.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, target.position);
    gl.bufferData(gl.ARRAY_BUFFER, mesh?.vertices ?? new Float32Array(0), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, target.normal);
    gl.bufferData(gl.ARRAY_BUFFER, mesh?.normals ?? new Float32Array(0), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, target.uv);
    gl.bufferData(gl.ARRAY_BUFFER, mesh?.uvs ?? new Float32Array(0), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, target.index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh?.indices ?? new Uint32Array(0), gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    target.count = mesh?.indices.length ?? 0;
  };
  uploadMesh(buffers.bust, frame.bust);
  uploadMesh(buffers.frames, frame.glasses?.frames);
  uploadMesh(buffers.lenses, frame.glasses?.lenses);
  uploadMesh(buffers.bun, frame.bun);
}

function resizeCanvas(canvas, gl) {
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round((canvas.clientWidth || canvas.width) * (canvas.clientWidth ? ratio : 1)));
  const height = Math.max(1, Math.round((canvas.clientHeight || canvas.height) * (canvas.clientHeight ? ratio : 1)));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  gl.viewport(0, 0, width, height);
  return width / height;
}

function drawRange(gl, range) {
  if (range.count > 0) gl.drawElements(gl.TRIANGLES, range.count, gl.UNSIGNED_INT, range.start * 4);
}

function drawFrame(canvas, state) {
  const { gl, buffers, meshUniforms: u, frame, resources } = state;
  const { ranges } = resources.staticData;
  const aspect = resizeCanvas(canvas, gl);
  const camera = buildGnmPlayerCamera(state.camera, aspect);
  const appearance = frame.appearance;
  const linear = (rgb) => srgbToLinear(rgb);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.depthMask(true);
  gl.clearColor(0.03, 0.04, 0.06, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(state.backgroundProgram);
  gl.uniform3fv(state.backgroundUniforms.uKitPrimary, linear(appearance.kit.primary));
  gl.bindVertexArray(state.backgroundVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.CULL_FACE);
  gl.useProgram(state.meshProgram);
  gl.uniformMatrix4fv(u.uProjection, false, camera.projection);
  gl.uniformMatrix4fv(u.uView, false, camera.view);
  gl.uniform4fv(u.uFieldMin, buffers.fieldMin);
  gl.uniform4fv(u.uFieldMax, buffers.fieldMax);
  gl.uniform3fv(u.uSkin, linear(appearance.skin));
  gl.uniform3fv(u.uLip, linear(appearance.lip));
  gl.uniform3fv(u.uIris, linear(appearance.iris));
  gl.uniform3fv(u.uHair, linear(appearance.hair));
  gl.uniform3fv(u.uBeard, linear(appearance.beard));
  gl.uniform3fv(u.uBrow, linear(appearance.brow));
  gl.uniform3fv(u.uKitPrimary, linear(appearance.kit.primary));
  gl.uniform3fv(u.uKitSecondary, linear(appearance.kit.secondary));
  const hair = appearance.hairStyle;
  gl.uniform4f(u.uHairStyle, hair?.hairline ?? 0, hair?.back ?? 0, hair?.fade ?? 0, hair?.thickness ?? 0);
  gl.uniform4f(u.uHairStyle2, hair?.top ?? 0, hair?.texture ?? 0, HAIR_PATTERNS[hair?.pattern] ?? 0, hair ? 1 : 0);
  const beard = appearance.beardStyle;
  gl.uniform4f(u.uBeardStyle, beard.full, beard.moustache, beard.goatee, beard.density);
  const brow = appearance.browStyle;
  gl.uniform4f(u.uBrowStyle, brow.thickness, brow.arch, brow.peak, brow.length);
  gl.uniform1f(u.uBrowDensity, brow.density);
  gl.uniform4f(u.uFlags, appearance.freckles ? 1 : 0, appearance.scar ? 1 : 0, appearance.ageShading, beard.reach);
  const eyes = resources.model.metadata.fieldAnchors.eyes;
  const pupilMax = (eyes.left_eye.pupilMaxDeg + eyes.right_eye.pupilMaxDeg) / 2;
  const irisMax = (eyes.left_eye.irisMaxDeg + eyes.left_eye.scleraMinDeg + eyes.right_eye.irisMaxDeg + eyes.right_eye.scleraMinDeg) / 4;
  gl.uniform2f(u.uIrisAngles, pupilMax, irisMax);
  gl.uniform1i(u.uDebugField, Number.isInteger(state.debugField) ? state.debugField : -1);
  gl.bindVertexArray(buffers.meshVao);
  for (const [name, component] of [["skin", COMPONENT.skin], ["eye", COMPONENT.eye], ["teeth", COMPONENT.teeth], ["tongue", COMPONENT.tongue]]) {
    gl.uniform1i(u.uComponent, component);
    drawRange(gl, ranges[name]);
  }
  if (hair) {
    gl.bindVertexArray(buffers.shellVao);
    gl.uniform1i(u.uComponent, COMPONENT.hair);
    drawRange(gl, ranges.hair);
  }
  const drawMesh = (mesh, component) => {
    if (mesh.count <= 0) return;
    gl.bindVertexArray(mesh.vao);
    for (let index = 3; index < 8; index += 1) gl.vertexAttrib4f(index, 0, 0, 0, 0);
    gl.uniform1i(u.uComponent, component);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
  };
  drawMesh(buffers.bust, COMPONENT.jersey);
  drawMesh(buffers.bun, COMPONENT.bun);
  drawMesh(buffers.frames, COMPONENT.frame);
  gl.bindVertexArray(buffers.meshVao);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false);
  gl.uniform1i(u.uComponent, COMPONENT.cornea);
  drawRange(gl, ranges.cornea);
  drawMesh(buffers.lenses, COMPONENT.lens);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.bindVertexArray(null);
  const error = gl.getError();
  if (error !== gl.NO_ERROR) fail(`GNM player WebGL error ${error}`);
  return camera;
}

function diagnosticsFor(canvas, state, camera) {
  const { frame, resources } = state;
  const { identity } = frame;
  const gl = state.gl;
  return {
    renderer: GNM_PLAYER_RENDER_STYLE,
    viewport: [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight],
    framebufferStatus: gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE ? "complete" : "incomplete",
    semanticMapping: "measured-landmark-features-v1",
    officialTexturesIncluded: false,
    runtimeBasisLoaded: true,
    identityPriorCount: resources.model.priorCount,
    featureCount: resources.model.featureCount,
    identityCoefficientCount: identity.coefficients.length,
    identityCoefficientsHead: Array.from(identity.coefficients.slice(0, 8), (value) => Number(value.toFixed(6))),
    maxAbsIdentityCoefficient: Number(identity.maxAbsCoefficient.toFixed(6)),
    featureTargets: identity.targets,
    identityFeatureZ: Object.fromEntries(Object.entries(frame.identityFeatureZ).map(([key, value]) => [key, Number(value.toFixed(4))])),
    renderedFeatureZ: Object.fromEntries(Object.entries(frame.renderedFeatureZ).map(([key, value]) => [key, Number(value.toFixed(4))])),
    measuredFeaturesMm: Object.fromEntries(Object.entries(frame.measured).map(([key, value]) => [key, Number(value.toFixed(4))])),
    expression: frame.expression,
    appearance: {
      hairStyle: frame.appearance.hairStyle?.asset ?? "hair/hidden",
      beardStyle: frame.appearance.beardStyle.asset,
      browStyle: frame.appearance.browStyle.asset,
      freckles: frame.appearance.freckles,
      scar: frame.appearance.scar,
      glasses: frame.appearance.glasses ? "procedural-frames" : false,
      bun: Boolean(frame.bun),
    },
    hairShellTriangles: frame.shell.triangleEstimate,
    lighting: { ...GNM_PLAYER_LIGHTING },
    camera: { ...camera.camera },
    canvas: { width: canvas.width, height: canvas.height },
  };
}

function redraw(canvas, state) {
  const camera = drawFrame(canvas, state);
  canvas.__sportsFaceWebglDiagnostics = diagnosticsFor(canvas, state, camera);
  return canvas.__sportsFaceWebglDiagnostics;
}

function attachCameraControls(canvas, state) {
  if (state.controls) return;
  state.controls = true;
  let pointer = null;
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!pointer || pointer.id !== event.pointerId || !state.frame) return;
    state.camera = clampGnmPlayerCamera({ ...state.camera, yaw: state.camera.yaw + (event.clientX - pointer.x) * 0.012, pitch: state.camera.pitch + (event.clientY - pointer.y) * 0.008 });
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    redraw(canvas, state);
  });
  const release = (event) => { if (pointer?.id === event.pointerId) pointer = null; };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("wheel", (event) => {
    if (!state.frame) return;
    event.preventDefault();
    state.camera = clampGnmPlayerCamera({ ...state.camera, distance: state.camera.distance * Math.exp(event.deltaY * 0.001) });
    redraw(canvas, state);
  }, { passive: false });
}

export function resetGnmPlayerCamera(canvas) {
  const state = canvasState.get(canvas);
  if (!state) return { ...GNM_PLAYER_DEFAULT_CAMERA };
  state.camera = { ...GNM_PLAYER_DEFAULT_CAMERA };
  if (state.frame) redraw(canvas, state);
  return { ...state.camera };
}

function fallback(canvas, profile, options, reason) {
  const target = options.fallbackCanvas || canvas;
  const fallbackOptions = { ...options };
  delete fallbackOptions.fallbackCanvas;
  return renderGnmMorphFace(target, profile, fallbackOptions).then(() => ({ canvas: target, fallback: true, reason: reason || FALLBACK_MESSAGE }));
}

async function renderInto(canvas, profile, options) {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: true, preserveDrawingBuffer: true });
  if (!gl) return null;
  const resources = await loadGnmPlayerResources();
  let state = canvasState.get(canvas);
  if (!state || state.gl !== gl || state.resources !== resources) {
    state = { ...createGlState(gl, resources), resources, camera: { ...GNM_PLAYER_DEFAULT_CAMERA }, frame: null };
    canvasState.set(canvas, state);
  }
  if (options.camera) state.camera = clampGnmPlayerCamera(options.camera);
  state.debugField = Number.isInteger(options.debugField) && options.debugField >= 0 && options.debugField <= 20 ? options.debugField : -1;
  state.frame = computeGnmPlayerFrame(resources, profile, options);
  uploadFrame(state, state.frame);
  return { state, diagnostics: redraw(canvas, state) };
}

/** Render one player into a WebGL2 canvas; falls back to the 2D GNM SVG renderer. */
export function renderGnmPlayerFace(canvas, profile, options = {}) {
  return Promise.resolve().then(async () => {
    if (!canvas || typeof canvas.getContext !== "function") return fallback(canvas, profile, options, "WebGL canvas is unavailable");
    const result = await renderInto(canvas, profile, options);
    if (!result) return fallback(canvas, profile, options, "WebGL2 context is unavailable");
    attachCameraControls(canvas, result.state);
    return { canvas, fallback: false, renderer: GNM_PLAYER_RENDER_STYLE, diagnostics: result.diagnostics };
  }).catch((error) => fallback(canvas, profile, options, error instanceof Error ? error.message : String(error)));
}

let thumbnailCanvas = null;
let thumbnailQueue = Promise.resolve();

/** Render a 3D thumbnail into a 2D canvas through one shared offscreen WebGL2 canvas. */
export function renderGnmPlayerThumbnail(target, profile, options = {}) {
  const job = thumbnailQueue.then(async () => {
    if (typeof document === "undefined") return fallback(target, profile, options, "document is unavailable");
    if (!thumbnailCanvas) {
      thumbnailCanvas = document.createElement("canvas");
      thumbnailCanvas.width = 256;
      thumbnailCanvas.height = 256;
    }
    const result = await renderInto(thumbnailCanvas, profile, { ...options, camera: GNM_PLAYER_DEFAULT_CAMERA });
    if (!result) return fallback(target, profile, options, "WebGL2 context is unavailable");
    const context = target.getContext("2d");
    context.drawImage(thumbnailCanvas, 0, 0, target.width, target.height);
    return { canvas: target, fallback: false, renderer: GNM_PLAYER_RENDER_STYLE };
  }).catch((error) => fallback(target, profile, options, error instanceof Error ? error.message : String(error)));
  thumbnailQueue = job.catch(() => undefined);
  return job;
}

export function describeGnmPlayerRender(profile, options = {}) {
  return describeGnmPlayerMapping(profile, options);
}
