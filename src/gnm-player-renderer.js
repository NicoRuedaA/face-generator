/*
 * Sports Face GNM 3D player renderer
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * Dependency-free WebGL2 renderer for `sports/gnm-3d-player-v1`. It loads the
 * render-only official GNM GLB plus the offline player-generator payload,
 * reconstructs each player's official GNM identity on the CPU, computes smooth
 * normals and draws skin, eyes (with a transparent cornea pass), teeth,
 * tongue, a painted + volumetric hair shell, procedural glasses and bun, and
 * a procedural jersey bust. Painting uses procedural fields over official
 * regions: no official textures are used. Failures reject explicitly; no alternate renderer is used.
 *
 * Lighting (see gnm-player-lighting.js): a camera-mounted studio with a key
 * light (depth map re-rendered per redraw, contact-hardening PCF), a rim
 * light with its own smaller depth map, and a procedural environment (L2 SH
 * diffuse, spherical-Gaussian specular). Ambient occlusion is baked once per
 * profile from fixed world-space directional depth maps and stored per
 * vertex. Skin uses a pre-integrated subsurface-scattering LUT and dual-lobe
 * GGX. All passes are WebGL2-only; unavailable depth formats degrade to
 * unshadowed / cavity-only lighting and are reported in the diagnostics.
 *
 * Eyes (see gnm-player-eyes.js): eyelash strands on the reconstructed lid
 * margins (view-aligned ribbons, alpha-to-coverage, stochastic key-light
 * shadows), a tear meniscus and a wet caruncle, an iris seen through the
 * refracting corneal dome, and eye occlusion from the lid contact line.
 *
 * Hair (see gnm-player-hair.js and gnm-player-facial-hair.js): scalp hair,
 * beard and eyebrows are generated strands drawn by one fibre program
 * (Marschner-style shading, alpha-to-coverage, stochastic key-light
 * shadows, root AO, reduced tiers for thumbnails). Under the beard and the
 * brows the skin takes a per-vertex root tint graded by the strand density.
 *
 * Camera (see gnm-player-post.js): the scene renders into an offscreen 4x
 * MSAA target (half-float when EXT_color_buffer_float is available, else a
 * compressed RGBA8 encoding), is resolved, and a final composite owns depth
 * of field, vignette, tone mapping, sRGB encoding and deterministic grain.
 * When no offscreen target is complete, the scene is drawn straight to the
 * canvas with in-shader tone mapping and no post effects.
 */

import { parseWebglGlb, sha256Bytes, WEBGL_OFFICIAL_ASSET_URL, WEBGL_CAMERA_LIMITS } from "./gnm-assets.js";
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
import {
  GNM_PLAYER_AMBIENT_OCCLUSION,
  GNM_PLAYER_LIGHT_VOLUME,
  GNM_PLAYER_SHADOW,
  GNM_PLAYER_SKIN_LUT,
  buildGnmPlayerLightMatrix,
  computeGnmPlayerSurfaceTerms,
  gnmPlayerAoDirections,
  gnmPlayerSkinLut,
  gnmPlayerSkinRegions,
  gnmPlayerStudioLighting,
  viewDirectionToWorld,
} from "./gnm-player-lighting.js";
import {
  GNM_PLAYER_EYES,
  buildGnmPlayerEyeTopology,
  buildGnmPlayerLashes,
  buildGnmPlayerTearLine,
  computeGnmPlayerEyeRig,
  gnmPlayerEyeSurfaceMasks,
  gnmPlayerIrisDetail,
  gnmPlayerLashPigment,
} from "./gnm-player-eyes.js";
import {
  GNM_PLAYER_POST,
  gnmPlayerBackdropPaper,
  gnmPlayerDepthOfField,
  gnmPlayerGrainAmplitude,
  gnmPlayerGrainSeed,
} from "./gnm-player-post.js";
import {
  GNM_PLAYER_HAIR,
  buildGnmPlayerHair,
  buildGnmPlayerHairScalp,
  emptyGnmPlayerHair,
  gnmPlayerHairGroom,
} from "./gnm-player-hair.js";
import {
  GNM_PLAYER_FACIAL_HAIR,
  buildGnmPlayerBeard,
  buildGnmPlayerBrows,
  buildGnmPlayerFacialHairStatic,
  gnmPlayerBeardGroom,
  gnmPlayerBrowGroom,
  gnmPlayerFacialHairUnderlay,
} from "./gnm-player-facial-hair.js";

export { GNM_PLAYER_RENDER_STYLE };
export const GNM_PLAYER_DEFAULT_CAMERA = Object.freeze({ yaw: 0.38, pitch: -0.06, distance: 1 });
export const GNM_PLAYER_FIELD_OF_VIEW = 0.40;
export const GNM_PLAYER_LIGHTING = Object.freeze({
  model: "studio-environment-v3",
  space: "view",
  toneMapping: "aces-filmic-hue-preserving-highlights",
  environment: "procedural-studio-sh-l2-diffuse-sg-specular",
  shadows: "key-pcss-and-rim-pcf-depth-maps",
  ambientOcclusion: "gpu-multi-direction-depth-maps-per-profile",
  skinDiffuse: "preintegrated-sss-lut",
  skinSpecular: "dual-lobe-ggx",
  skinRegions: "seed-stable-template-masks",
  cavity: "local-normal-curvature",
  skinDetail: "footprint-filtered-microrelief",
  eyeOcclusion: "lid-contact-polar-table",
});
/** Eye rendering techniques (see gnm-player-eyes.js). */
export const GNM_PLAYER_EYE_RENDERING = Object.freeze({
  lashes: "view-aligned-strands-alpha-to-coverage",
  lashShadows: "stochastic-coverage-key-shadow-map",
  tearLine: "wet-meniscus-fillet-strip",
  caruncle: "wet-mucosa-inner-canthus-mask",
  iris: "corneal-refraction-procedural-stroma",
  cornea: "environment-and-softbox-reflection",
});
/** Capture/debug-only views (`options.debugField`); 0..19 are normalized fields. */
export const GNM_PLAYER_DEBUG_VIEWS = Object.freeze({ normals: 20, keyShadow: 21, ambientOcclusion: 22, curvature: 23, skinRegions: 24 });
const TARGET = Object.freeze([0, 0.246, 0.018]);
const BASE_DISTANCE = 1.0;
const CLIP = Object.freeze({ near: 0.05, far: 5 });
const COMPONENT = Object.freeze({ skin: 0, eye: 1, teeth: 2, tongue: 3, hair: 4, cornea: 5, jersey: 6, frame: 7, lens: 8, bun: 9, lash: 13, tearLine: 14 });
/** Scene output encodings (uniform uSceneEncoding): linear HDR, compressed RGBA8, or tone-mapped display (direct). */
const SCENE_ENCODING = Object.freeze({ linear: 0, compressed: 1, display: 2 });
/** Minimum rendered strand width in pixels; thinner strands keep their width as coverage. */
const STRAND_MIN_PIXELS = 0.75;
/** Lash shadow casters: minimum half-width in key shadow-map texels. */
const STRAND_SHADOW_TEXELS = 0.6;
/** Eyelashes are skipped when a pixel at the eyes is larger than this (m). */
const STRAND_MAX_PIXEL_SIZE = 0.0009;
/** Scalp hair: minimum strand width (px) with MSAA, and without it (dithered coverage). */
const HAIR_MIN_PIXELS = Object.freeze({ multisampled: 0.6, direct: 1.0 });
/**
 * Strand body opacity floors (terminal strands, wisps): scalp strands stand
 * for several hairs and stay nearly opaque; beard and brow strands are one
 * hair each and keep more of their sub-pixel coverage.
 */
const HAIR_OPACITY = Object.freeze([0.9, 0.35]);
const FACIAL_HAIR_OPACITY = Object.freeze({ beard: Object.freeze([0.66, 0.3]), brow: Object.freeze([0.7, 0.3]) });
/** Beard and brows: minimum strand width (px) with MSAA (the direct fallback keeps the scalp's 1 px). */
const FACIAL_HAIR_MIN_PIXELS = Object.freeze({ beard: 0.5, brow: 0.55 });
/** Scalp hair: width scale of the reduced level of detail (fewer, wider strands). */
const HAIR_REDUCED_WIDTH_SCALE = 1.35;
/**
 * Scalp hair in the key shadow map: optical width scale (a render strand
 * stands for several real hairs) and coverage (fibres transmit part of the
 * light), so dense hair shadows fully and a thin fringe casts broken shade.
 */
const HAIR_SHADOW = Object.freeze({ widthScale: 4, coverage: 0.9 });
/** Beard and brow strands in the key shadow map: each strand is one hair, a little wider optically. */
const FACIAL_HAIR_SHADOW = Object.freeze({ widthScale: 1.5, coverage: 0.85 });
/** Canvases up to this size (px) draw the reduced hair level of detail. */
const HAIR_REDUCED_CANVAS = 320;
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
  const templateLandmarks = gnmPlayerLandmarks(model, template);
  const regionAnchors = gnmPlayerRegionAnchors(templateLandmarks);
  const skinTriangles = Uint32Array.from(skin, (vertex) => sourceIds[vertex]);
  // Eyes: lid-margin topology (source ids) and static per-render-vertex skin masks.
  const sourceField = (key, source) => {
    const spec = model.fieldIndex.get(key);
    return spec.min + (model.fields[spec.index * model.vertexCount + source] / 255) * (spec.max - spec.min);
  };
  const eyeVertices = ["right_eye", "left_eye"].map((name) => {
    const interior = new Set();
    const glass = new Set();
    for (const vertex of byName[name]) (decoded("cornea", vertex) >= 0.5 ? glass : interior).add(sourceIds[vertex]);
    return { interior: Uint32Array.from(interior), cornea: Uint32Array.from(glass) };
  });
  const eyeTopology = buildGnmPlayerEyeTopology({ template, skinTriangles, field: sourceField, landmarks: templateLandmarks, eyeVertices });
  const sourceMasks = gnmPlayerEyeSurfaceMasks(eyeTopology, model.vertexCount, template);
  const eyeMasks = new Float32Array(renderCount * 2);
  const representative = new Int32Array(model.vertexCount).fill(-1);
  for (let vertex = 0; vertex < renderCount; vertex += 1) {
    const source = sourceIds[vertex];
    eyeMasks[vertex * 2] = sourceMasks[source * 2];
    eyeMasks[vertex * 2 + 1] = sourceMasks[source * 2 + 1];
    if (representative[source] < 0) representative[source] = vertex;
  }
  // Strand hair: stratified scalp roots, guide roots and the head collision table.
  const renderField = (key) => Float32Array.from({ length: renderCount }, (_, vertex) => decoded(key, vertex));
  const range = (name) => indices.subarray(ranges[name].start, ranges[name].start + ranges[name].count);
  const renderFields = Object.fromEntries(["ear", "eyeSocket", "mouthSock", "lip", "browT", "browD", "beardUpper", "beardLower", "mouthDX", "mouthDY"].map((key) => [key, renderField(key)]));
  const hairScalp = buildGnmPlayerHairScalp({
    positions,
    skinTriangles: range("skin"),
    closureTriangles: range("cornea"),
    fields: { scalp, front, ear: renderFields.ear, eyeSocket: renderFields.eyeSocket, mouthSock: renderFields.mouthSock, lip: renderFields.lip },
    anchors,
  });
  // Beard and eyebrow strands: walkable brow/beard skin, root candidates and clump seeds.
  const facialHair = buildGnmPlayerFacialHairStatic({ positions, sourceIds, skinTriangles: range("skin"), fields: { ...renderFields, scalpFront: front }, landmarks: templateLandmarks });
  return { renderCount, positions, uvs, sourceIds, template, attributes, indices, ranges, sourceTriangles: allTriangles, skinTriangles, scalp, front, skinVertex, neckLoop, bunAnchor, regionAnchors, eyeTopology, eyeMasks, representative, hairScalp, facialHair };
}

/**
 * Template-space anchors for surface-attached regional skin masks: nose tip,
 * right/left alae, right/left lower lids, mouth center, chin and brow center.
 * Masks use each vertex's static template position, so they follow the
 * surface and never move when another region's shape is edited.
 */
export function gnmPlayerRegionAnchors(landmarks) {
  const average = (indices) => [0, 1, 2].map((axis) => indices.reduce((sum, index) => sum + landmarks[index * 3 + axis], 0) / indices.length);
  return Float32Array.from([[30], [31], [35], [40, 41], [46, 47], [48, 54], [8], [21, 22]].flatMap(average));
}

/**
 * Beard and eyebrow strands (see gnm-player-facial-hair.js) for one frame;
 * scalp hair is built separately (gnm-player-hair.js), so the `hair` group
 * stays empty here. Options: `seed` (profile seed), `lod` ("full" or
 * "reduced") and `collarPlane` (beard points stay above the jersey).
 */
export function buildGnmPlayerGroom(staticData, positions, normals, appearance, { seed = 0, lod = "full", collarPlane = null } = {}) {
  return {
    hair: emptyGnmPlayerHair(),
    beard: buildGnmPlayerBeard(staticData.facialHair, positions, normals, appearance.beardStyle, seed, { lod, collarPlane }),
    brow: buildGnmPlayerBrows(staticData.facialHair, positions, normals, appearance.browStyle, seed, { lod }),
  };
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

/*
 * Tone mapping shared by the final composite and the direct fallback: ACES
 * fit (Narkowicz) per channel below mid-grey, blending into the same curve
 * applied to the peak channel (hue-preserving) above it, then sRGB encoding.
 */
const TONE_MAPPING_GLSL = `
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
// Hue-preserving variant: the same curve applied to the peak channel and the
// RGB ratios kept, so bright colors never shift hue or bleach towards white.
vec3 acesHuePreserving(vec3 x) {
  float peak = max(max(x.r, x.g), x.b);
  return x * (aces(vec3(peak)).r / max(peak, 1e-6));
}
// Per-channel ACES keeps mid and dark skin rich; above mid-grey it blends into
// the hue-preserving curve so bright skin does not bleach towards porcelain.
vec3 tonemap(vec3 x) {
  vec3 perChannel = aces(x);
  return mix(perChannel, acesHuePreserving(x), smoothstep(0.3, 0.8, dot(perChannel, vec3(0.2126, 0.7152, 0.0722))));
}
vec3 toSrgb(vec3 linear) {
  return mix(linear * 12.92, 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, linear));
}`;

const MESH_VERTEX = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUv;
layout(location=3) in vec4 aFieldA;
layout(location=4) in vec4 aFieldB;
layout(location=5) in vec4 aFieldC;
layout(location=6) in vec4 aFieldD;
layout(location=7) in vec4 aFieldE;
layout(location=8) in vec4 aSurface;  // cavity, |curvature| (1/mm), lash-line mask, wet mask; strands: half-width (m), random, lower-lid flag, 0
layout(location=9) in vec3 aTemplate; // static official template position (surface-attached masks)
layout(location=10) in float aAoIndex; // eye strands: AO texel of their root vertex
layout(location=11) in vec2 aFacialHair; // skin: beard and brow root density (underlay)
uniform mat4 uProjection;
uniform mat4 uView;
uniform vec4 uFieldMin[5];
uniform vec4 uFieldMax[5];
// Baked per-vertex ambient occlusion stays on the GPU (one RGBA8 texel per
// vertex, no readback). uAo.x: texel base of this draw (>= 0), -1 = use
// aAoIndex (strands), -2 = none; uAo.y: 1 when a bake is available.
uniform highp sampler2D uAoTexture;
uniform ivec2 uAo;
uniform float uStrandRootFactor;
// Strands (uStrand = 1): aPosition is the centreline, aNormal the unit
// tangent, aUv.x the ribbon side (0/1). The ribbon is expanded towards the
// camera to at least uStrandMinPixels wide; the width it lacks becomes
// coverage (alpha-to-coverage) instead of aliasing. Scalp hair has its own
// program (HAIR_VERTEX / HAIR_FRAGMENT).
uniform int uStrand;
uniform vec3 uCameraPosition;
uniform vec2 uViewport;
uniform float uStrandMinPixels;
out vec3 vViewPosition;
out vec3 vViewNormal;
out vec3 vObject;
out vec3 vWorldNormal;
out vec3 vTemplate;
out vec2 vUv;
out vec4 vA;
out vec4 vB;
out vec4 vC;
out vec4 vD;
out vec4 vE;
out vec4 vSurface;
out vec2 vEyeMask; // skin: lash line, wet margin; strands: coverage, per-strand random
out vec2 vFacialHair;
float bakedOcclusion(int index) {
  int width = textureSize(uAoTexture, 0).x;
  return texelFetch(uAoTexture, ivec2(index % width, index / width), 0).r;
}
void main() {
  vec3 position = aPosition;
  float coverage = 1.0;
  if (uStrand == 1) {
    vec3 tangent = normalize(aNormal);
    vec3 side = cross(tangent, uCameraPosition - aPosition);
    float sideLength = length(side);
    side = sideLength > 1e-9 ? side / sideLength : normalize(cross(tangent, abs(tangent.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    float depth = max(-(uView * vec4(aPosition, 1.0)).z, 1e-3);
    float pixel = 2.0 * depth / (uProjection[1][1] * uViewport.y);
    float halfWidth = max(aSurface.x, 0.5 * uStrandMinPixels * pixel);
    coverage = clamp(aSurface.x / halfWidth, 0.0, 1.0);
    position += side * halfWidth * (aUv.x * 2.0 - 1.0);
  }
  vec4 view = uView * vec4(position, 1.0);
  vViewPosition = view.xyz;
  vViewNormal = mat3(uView) * aNormal;
  vObject = position;
  vWorldNormal = aNormal;
  vTemplate = aTemplate;
  float occlusion = 1.0;
  if (uAo.y == 1 && uAo.x >= 0) occlusion = bakedOcclusion(uAo.x + gl_VertexID);
  else if (uAo.y == 1 && uAo.x == -1) occlusion = bakedOcclusion(int(aAoIndex + 0.5)) * mix(uStrandRootFactor, 1.0, aUv.y);
  vSurface = uStrand == 1 ? vec4(aSurface.z, 0.0, occlusion, 0.0) : vec4(aSurface.xy, occlusion, 0.0);
  vEyeMask = uStrand == 1 ? vec2(coverage, aSurface.y) : aSurface.zw;
  vFacialHair = aFacialHair;
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
precision highp sampler2DShadow;
in vec3 vViewPosition;
in vec3 vViewNormal;
in vec3 vObject;
in vec3 vWorldNormal;
in vec3 vTemplate;
in vec2 vUv;
in vec4 vA; // lip, mouthSock, teeth, cornea
in vec4 vB; // irisAngle(deg), freckleZone, ear, eyeSocket
in vec4 vC; // scalpHeight(mm), scalpFront(cos azimuth), neckHeight(mm), scarDist(mm)
in vec4 vD; // browT, browD(mm), blushZone, faceMask
in vec4 vE; // beardUpper(mm), beardLower(mm), mouthDX(mm), mouthDY(mm)
in vec4 vSurface; // cavity, |curvature| (1/mm), baked ambient occlusion (vertex texel fetch), unused
in vec2 vEyeMask; // skin: lash line, wet margin; strands: coverage, per-strand random
in vec2 vFacialHair; // skin: beard and brow root density of the strands drawn over it
// Output encoding: 0 linear HDR (float target), 1 compressed x/(1+x) with
// sqrt (RGBA8 target), 2 tone-mapped sRGB (direct to the canvas).
uniform int uSceneEncoding;
// Eyes (world space), index 0 = subject's right eye (x < 0).
uniform vec4 uEyeCenters[2];   // eyeball sphere centre, radius (m)
uniform vec4 uEyeAxes[2];      // centre-to-pupil axis (w unused)
uniform vec3 uIrisCenters[2];  // pupil centre on the iris plane
uniform vec4 uIrisNormals[2];  // iris plane normal (out of the eye), limbus radius (m)
uniform vec3 uEyeUps[2];       // azimuth reference, orthogonal to the axis
uniform vec4 uCorneas[2];      // corneal dome centre, radius (m)
uniform vec4 uLidContact[16];  // lid/eyeball contact polar angle (rad), 32 azimuths per eye
uniform vec3 uInnerCanthi[2];
uniform vec4 uIrisDetail;      // pupil fraction, collarette, fibre contrast, crypts
uniform vec4 uIrisDetail2;     // limbal ring, central tint, scleral vessels, unused
uniform vec2 uIrisOffset;      // seed-stable pattern offset
uniform vec3 uCameraPosition;
uniform vec3 uLashRoot;
uniform vec3 uLashTip;
// Studio rig (view space): shadowed key and rim lights, procedural environment.
uniform vec3 uKeyDirection;
uniform vec3 uKeyColor;
uniform vec3 uRimDirection;
uniform vec3 uRimColor;
uniform vec3 uShDiffuse[9];      // irradiance / pi, basis constants folded in
uniform vec4 uEnvLobes[5];       // spherical Gaussian axis (view space), sharpness
uniform vec3 uEnvLobeColors[5];
uniform vec3 uEnvAmbient;
uniform sampler2DShadow uShadowMap;
uniform sampler2D uShadowDepth;
uniform mat4 uKeyLightMatrix;    // world -> key-light clip space (fixed light volume)
uniform vec4 uShadowParams;      // enabled, texel size (uv), light size (tan), volume diameter (m)
uniform sampler2DShadow uRimShadowMap;
uniform mat4 uRimLightMatrix;    // world -> rim-light clip space
uniform vec4 uRimShadowParams;   // enabled, texel size (uv), unused, volume diameter (m)
uniform sampler2D uSkinLut;      // pre-integrated skin diffusion, sqrt-encoded
uniform float uSkinLutCurvature; // curvature (1/mm) at the last LUT row
uniform vec4 uSkinRegions;       // redness, periorbital, beard shadow, oiliness
uniform float uSkinLightness;
uniform vec3 uSkinMottleOffset;  // per-seed offset of the template-space mottling
uniform vec3 uRegionAnchors[8];  // template space: nose tip, alae R/L, lower lids R/L, mouth, chin, brow center
uniform vec2 uCollarPlane;
uniform vec3 uAgeAnchors[9];
uniform int uComponent;
uniform vec3 uSkin;
uniform vec3 uLip;
uniform vec3 uIris;
uniform vec3 uHair;
uniform vec3 uKitPrimary;
uniform vec3 uKitSecondary;
uniform vec4 uHairStyle;   // hairline, back, fade, thickness
uniform vec4 uHairStyle2;  // top, texture, pattern(0 plain,1 curly,2 braids,3 bun), visible
// Painted scalp under the strand hair (see HAIR_FRAGMENT for the strands).
uniform vec4 uHairPart;    // parting type (0 none, 1 side, 2 centre), x at z = 0 (m), dx/dz, painted root density
uniform float uHairlineSoftness; // width scale of the painted hairline transition (1 = default)
// Skin under the beard and brow strands (see the underlay below).
uniform vec3 uBeardRoot;       // beard root colour (linear)
uniform vec3 uBrowRoot;        // brow root colour (linear)
uniform vec4 uFacialUnderlay;  // beard root tint, stubble follicle darkening, brow root tint, unused
uniform vec4 uFlags;       // freckles, scar, ageShading, unused
uniform mat4 uView;
uniform int uDebugField;   // -1 off, 0..19 normalized field, 20 normals, 21 key shadow, 22 baked AO, 23 curvature, 24 skin regions
uniform vec4 uFieldMin[5];
uniform vec4 uFieldMax[5];
out vec4 color;

const float PI = 3.14159265;
// Scatter scale: the physical profile is very narrow at portrait scale, so its
// distances are scaled (Penner's curvature scale); the result stays subtle.
const float SCATTER_SCALE = 3.5;
// Minimum key-shadow kernel radius (texels) on the eyeball, cornea and tear line.
const float EYE_SHADOW_TEXELS = 2.6;
// Fraction of the corneal refraction offset applied to the iris pattern.
const float IRIS_PARALLAX = 0.85;
// Fill softbox catchlight: radiance relative to the broad fill lobe of the
// environment (lobe 0), placed inside that lobe where the pre-v2 secondary
// corneal highlight sat, so it reads over the pupil rather than the limbus.
const float FILL_CATCHLIGHT = 0.7;
const vec3 FILL_CATCHLIGHT_AXIS = vec3(0.5549, 0.2018, 0.8071);
const vec2 VOGEL8[8] = vec2[8](vec2(0.25, 0.0), vec2(-0.3193, 0.2925), vec2(0.0489, -0.5569), vec2(0.4024, 0.5249), vec2(-0.7385, -0.1306), vec2(0.6996, -0.445), vec2(-0.234, 0.8705), vec2(-0.4463, -0.8593));
const vec2 VOGEL16[16] = vec2[16](vec2(0.1768, 0.0), vec2(-0.2258, 0.2068), vec2(0.0346, -0.3938), vec2(0.2846, 0.3712), vec2(-0.5222, -0.0924), vec2(0.4947, -0.3147), vec2(-0.1655, 0.6155), vec2(-0.3156, -0.6076), vec2(0.6846, 0.25), vec2(-0.7123, 0.294), vec2(0.3434, -0.7337), vec2(0.2537, 0.8089), vec2(-0.7647, -0.4432), vec2(0.8971, -0.1972), vec2(-0.5475, 0.7788), vec2(-0.1265, -0.9761));

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
  float fade = 1.0 - uHairStyle.z * (1.0 - smoothstep(0.15, 0.85, front)) * (1.0 - smoothstep(0.0, 45.0, scalp - threshold));
  return smoothstep(threshold - 2.2 * uHairlineSoftness, threshold + 1.6 * uHairlineSoftness, scalp + jitter) * fade;
}
float hairShellThickness(float scalp, float front) {
  float above = scalp - hairThreshold(front);
  if (above <= 0.0) return 0.0;
  float volume = uHairStyle.w + uHairStyle2.x * smoothstep(18.0, 60.0, above);
  float fade = 1.0 - uHairStyle.z * (1.0 - smoothstep(0.15, 0.85, front)) * (1.0 - smoothstep(8.0, 38.0, above));
  return volume * fade * smoothstep(0.0, 6.0, above);
}
// Anisotropic random fibers, filtered only when smaller than a screen pixel.
float hairStrandNoise(vec3 p) {
  float footprint = length(fwidth(p));
  return mix(noise3(p), 0.5, smoothstep(0.9, 2.2, footprint));
}
vec3 hairFlowDirection() {
  return uHairStyle2.z > 3.5
    ? vec3(vObject.x < 0.026 + vObject.z * 0.045 ? -1.0 : 0.8, -0.25, -0.45)
    : vec3(0.0, -0.45, -1.0);
}
vec3 hairAlbedo(out float grain, out float fine, out float clumps) {
  if (uHairStyle2.z > 3.5) {
    // Surface angles avoid slicing a curved scalp with parallel world planes.
    vec2 radial = vec2(vObject.x, vObject.z + 0.015);
    float azimuth = atan(radial.x, radial.y);
    float elevation = atan(vObject.y - 0.315, length(radial));
    vec3 strands = vec3(elevation * 0.07 + azimuth * azimuth * 0.012, azimuth * 0.07, 0.0);
    grain = hairStrandNoise(strands * vec3(1500.0, 60.0, 1.0));
    fine = hairStrandNoise(strands * vec3(3200.0, 110.0, 1.0));
    clumps = 0.5;
    return uHair * (0.40 + 0.32 * grain + 0.16 * fine);
  }
  grain = noise3(vec3((vObject.x + vObject.y * 0.4) * 3600.0, vObject.y * 240.0, vObject.z * 650.0));
  fine = noise3(vObject * vec3(7000.0, 420.0, 1200.0));
  clumps = noise3(vObject * 420.0);
  float pattern = 1.0;
  if (uHairStyle2.z > 0.5 && uHairStyle2.z < 1.5) pattern = 0.7 + 0.5 * smoothstep(0.3, 0.85, noise3(vObject * 950.0));
  return uHair * (0.36 + 0.22 * grain + 0.14 * fine + 0.14 * clumps) * pattern;
}
// Parting channel of the painted scalp (template space, like the strand roots).
float hairPartMask() {
  if (uHairPart.x < 0.5) return 1.0;
  vec3 p = vTemplate;
  float along = uHairPart.x < 1.5
    ? smoothstep(-0.03, 0.0, p.z) * smoothstep(0.33, 0.36, p.y)
    : smoothstep(-0.02, 0.02, p.z) * smoothstep(0.34, 0.375, p.y);
  // A slightly wandering, uneven line rather than a ruled one.
  float distance_ = abs(p.x - (uHairPart.y + uHairPart.z * p.z) + (noise3(p * 160.0) - 0.5) * 0.0009);
  return mix(1.0, smoothstep(0.0002, 0.0009 + 0.0005 * noise3(p * 70.0 + 3.1), distance_), along * 0.9);
}
float creaseSegment(vec2 p, vec2 a, vec2 b, float width) {
  vec2 segment = b - a;
  float t = clamp(dot(p - a, segment) / max(dot(segment, segment), 1e-9), 0.0, 1.0);
  float distance_ = length(p - a - segment * t);
  float antialias = max(fwidth(distance_), 0.00012);
  return (1.0 - smoothstep(width, width + antialias, distance_)) * smoothstep(0.0, 0.16, t) * (1.0 - smoothstep(0.8, 1.0, t));
}
float ageCreases() {
  if (uFlags.z <= 0.0) return 0.0;
  vec2 p = vObject.xy;
  float browY = uAgeAnchors[0].y;
  float x = p.x - uAgeAnchors[0].x;
  float forehead = 0.0;
  for (int i = 0; i < 3; ++i) {
    float lineY = browY + (i == 0 ? 0.008 : i == 1 ? 0.0145 : 0.023) + 0.002 * (1.0 - pow(x / 0.045, 2.0));
    lineY += 0.0003 * sin(x * 160.0 + float(i) * 2.1);
    float distance_ = abs(p.y - lineY);
    float width = 0.00015 + uFlags.z * 0.00024;
    float crease = 1.0 - smoothstep(width, width + max(fwidth(distance_), 0.00015), distance_);
    float fade = (1.0 - smoothstep(0.028, 0.052 - float(i) * 0.004, abs(x)));
    forehead = max(forehead, crease * fade * (0.85 - float(i) * 0.15));
  }
  forehead *= 1.0 - smoothstep(-0.004, 0.002, vC.x / 1000.0);
  float eyeLines = 0.0, folds = 0.0;
  for (int side = 0; side < 2; ++side) {
    vec2 corner = uAgeAnchors[1 + side].xy;
    float sign_ = sign(corner.x);
    for (int line = 0; line < 3; ++line) {
      vec2 a = corner + vec2(sign_ * 0.0015, -0.001);
      vec2 b = corner + vec2(sign_ * (0.010 + float(line) * 0.001), -0.006 + float(line) * 0.004);
      eyeLines = max(eyeLines, creaseSegment(p, a, b, 0.00012 + uFlags.z * 0.00018));
    }
    vec2 under = uAgeAnchors[3 + side].xy - vec2(0.0, 0.0035);
    eyeLines = max(eyeLines, creaseSegment(p, under - vec2(0.008, 0.0005), under + vec2(0.008, 0.0005), 0.0002) * 0.6);
    vec2 nose = uAgeAnchors[5 + side].xy;
    vec2 mouth = uAgeAnchors[7 + side].xy;
    vec2 a = nose + vec2(sign_ * 0.002, -0.001);
    vec2 b = mix(nose, mouth, 0.5) + vec2(sign_ * 0.005, 0.001);
    vec2 c = mouth + vec2(sign_ * 0.004, -0.006);
    folds = max(folds, max(creaseSegment(p, a, b, 0.00065), creaseSegment(p, b, c, 0.0007)) * 0.55);
  }
  // Front-facing anatomical regions only; never project stripes around the skull.
  float front = smoothstep(0.45, 0.8, vC.y) * (1.0 - vA.x) * (1.0 - vB.z);
  return max(forehead, max(eyeLines * 0.75, folds)) * front;
}
float interleavedNoise(vec2 pixel) { return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715)))); }
// Key-light visibility from the fixed-volume depth map: blocker search, then a
// contact-hardening PCF kernel (PCSS). Near the terminator a larger bias leaves
// self-shadowing to the N.L / pre-integrated falloff instead of the map. The
// four pixels of each 2x2 quad use complementary kernel rotations; the caller
// averages them (quadAverage), i.e. 64 hardware-bilinear taps per quad. Eye
// receivers pass a wider minimum kernel: eyelashes are thinner than their
// penumbra, so their stochastic shadow-map coverage must average into soft
// partial streaks.
float keyShadow(vec3 worldNormal, float nl, float wrap, float minPenumbraTexels, float selfBias) {
  if (uShadowParams.x < 0.5) return 1.0;
  // Facing away beyond the diffuse wrap: no light reaches it, skip the map.
  if (nl < -wrap - 0.05) return 0.0;
  float texel = uShadowParams.y;
  float diameter = uShadowParams.w;
  float grazing = 1.0 - clamp(nl, 0.0, 1.0);
  // selfBias 1: normal-offset and slope bias against self-shadowing; 0 for
  // eye receivers, which never cast into the key map (a normal offset would
  // push their lookup into the overhanging lid right at the lid junction).
  vec3 position = vObject + worldNormal * (texel * diameter) * (1.0 + 2.0 * grazing) * selfBias;
  vec3 coord = (uKeyLightMatrix * vec4(position, 1.0)).xyz * 0.5 + 0.5;
  if (coord.x < 0.001 || coord.y < 0.001 || coord.x > 0.999 || coord.y > 0.999 || coord.z >= 1.0) return 1.0;
  float receiver = coord.z - texel * 1.5 - mix(0.0006, 0.005, smoothstep(0.3, -0.05, nl)) / diameter * selfBias;
  float search = 0.009 / diameter;
  float blockerSum = 0.0;
  float blockerCount = 0.0;
  for (int i = 0; i < 8; ++i) {
    float depth = texture(uShadowDepth, coord.xy + VOGEL8[i] * search).r;
    if (depth < receiver) { blockerSum += depth; blockerCount += 1.0; }
  }
  if (blockerCount < 0.5) return 1.0;
  float penumbra = clamp((receiver - blockerSum / blockerCount) * uShadowParams.z, texel * minPenumbraTexels, 0.007 / diameter);
  vec2 pixel = floor(gl_FragCoord.xy);
  vec2 parity = mod(pixel, 2.0);
  float angle = (interleavedNoise(floor(pixel * 0.5)) + (parity.x + 2.0 * parity.y) * 0.25) * 6.2831853;
  mat2 rotation = mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
  float lit = 0.0;
  if (penumbra < texel * 4.0) {
    for (int i = 0; i < 16; ++i) lit += texture(uShadowMap, vec3(coord.xy + rotation * VOGEL16[i] * penumbra, receiver));
    return lit / 16.0;
  }
  // Wide penumbrae get a denser 32-tap Vogel spiral.
  for (int i = 0; i < 32; ++i) {
    float radius = sqrt((float(i) + 0.5) / 32.0) * penumbra;
    float theta = float(i) * 2.39996323;
    lit += texture(uShadowMap, vec3(coord.xy + rotation * vec2(cos(theta), sin(theta)) * radius, receiver));
  }
  return lit / 32.0;
}
// Key-light visibility for thin strands (eyelashes): a fixed 4-tap bilinear
// PCF around a lookup pushed towards the light, without a blocker search.
float strandShadow(vec3 worldNormal) {
  if (uShadowParams.x < 0.5) return 1.0;
  float texel = uShadowParams.y;
  vec3 coord = (uKeyLightMatrix * vec4(vObject + worldNormal * texel * uShadowParams.w, 1.0)).xyz * 0.5 + 0.5;
  if (coord.x < 0.001 || coord.y < 0.001 || coord.x > 0.999 || coord.y > 0.999 || coord.z >= 1.0) return 1.0;
  float receiver = coord.z - texel * 2.0;
  return 0.25 * (texture(uShadowMap, vec3(coord.xy + vec2(-0.7, -0.7) * texel, receiver)) + texture(uShadowMap, vec3(coord.xy + vec2(0.7, -0.7) * texel, receiver))
    + texture(uShadowMap, vec3(coord.xy + vec2(-0.7, 0.7) * texel, receiver)) + texture(uShadowMap, vec3(coord.xy + vec2(0.7, 0.7) * texel, receiver)));
}
// Rim light (behind the subject) visibility: a lower-resolution map with a
// fixed 4-tap bilinear PCF, so the rim only lights what can see it.
float rimShadow(vec3 worldNormal, float nl, float wrap) {
  if (uRimShadowParams.x < 0.5) return 1.0;
  if (nl < -wrap - 0.05) return 0.0;
  float texel = uRimShadowParams.y;
  float diameter = uRimShadowParams.w;
  vec3 position = vObject + worldNormal * (texel * diameter) * (1.5 + 2.0 * (1.0 - clamp(nl, 0.0, 1.0)));
  vec3 coord = (uRimLightMatrix * vec4(position, 1.0)).xyz * 0.5 + 0.5;
  if (coord.x < 0.002 || coord.y < 0.002 || coord.x > 0.998 || coord.y > 0.998 || coord.z >= 1.0) return 1.0;
  float receiver = coord.z - texel * 2.0 - mix(0.001, 0.006, smoothstep(0.3, -0.05, nl)) / diameter;
  float lit = texture(uRimShadowMap, vec3(coord.xy + vec2(-1.5, -0.5) * texel, receiver))
    + texture(uRimShadowMap, vec3(coord.xy + vec2(0.5, -1.5) * texel, receiver))
    + texture(uRimShadowMap, vec3(coord.xy + vec2(1.5, 0.5) * texel, receiver))
    + texture(uRimShadowMap, vec3(coord.xy + vec2(-0.5, 1.5) * texel, receiver));
  return lit * 0.25;
}
// Average of the 2x2 pixel quad from screen-space derivatives (uniform control flow only).
float quadAverage(float value) {
  vec2 parity = mod(floor(gl_FragCoord.xy), 2.0);
  float row = value + dFdx(value) * (0.5 - parity.x);
  return clamp(row + dFdy(row) * (0.5 - parity.y), 0.0, 1.0);
}
vec3 shDiffuse(vec3 n) {
  vec3 value = uShDiffuse[0] + uShDiffuse[1] * n.y + uShDiffuse[2] * n.z + uShDiffuse[3] * n.x
    + uShDiffuse[4] * (n.x * n.y) + uShDiffuse[5] * (n.y * n.z) + uShDiffuse[6] * (3.0 * n.z * n.z - 1.0)
    + uShDiffuse[7] * (n.x * n.z) + uShDiffuse[8] * (n.x * n.x - n.y * n.y);
  return max(value, vec3(0.0));
}
// Mirror lookup of the procedural studio (glass).
vec3 environmentRadiance(vec3 direction) {
  vec3 value = uEnvAmbient;
  for (int i = 0; i < 5; ++i) value += uEnvLobeColors[i] * exp(uEnvLobes[i].w * (dot(uEnvLobes[i].xyz, direction) - 1.0));
  return value;
}
// Studio radiance pre-filtered by a GGX-shaped spherical Gaussian around the
// reflection vector: the analytic inner product of two spherical Gaussians.
vec3 environmentSpecular(vec3 reflected, float roughness, float nv) {
  float alpha = max(roughness * roughness, 0.004);
  float lambda = 0.5 / (alpha * alpha * max(nv, 0.1));
  float normalization = lambda / (1.0 - exp(-2.0 * lambda));
  vec3 value = uEnvAmbient;
  for (int i = 0; i < 5; ++i) {
    float sharpness = uEnvLobes[i].w;
    float mixed = length(sharpness * uEnvLobes[i].xyz + lambda * reflected);
    value += uEnvLobeColors[i] * normalization * exp(mixed - sharpness - lambda) * (1.0 - exp(-2.0 * mixed)) / max(mixed, 1e-4);
  }
  return value;
}
// Split-sum environment BRDF, analytic fit (Karis 2014).
vec2 environmentBrdf(float roughness, float nv) {
  vec4 r = roughness * vec4(-1.0, -0.0275, -0.572, 0.022) + vec4(1.0, 0.0425, 1.04, -0.04);
  float a004 = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}
// Multi-bounce occlusion (Jimenez et al. 2016): high albedo keeps occluded
// skin warm instead of grey.
vec3 multiBounce(float visibility, vec3 albedo) {
  vec3 a = 2.0404 * albedo - 0.3324;
  vec3 b = -4.7951 * albedo + 0.6417;
  vec3 c = 2.7552 * albedo + 0.6903;
  return max(vec3(visibility), ((visibility * a + b) * visibility + c) * visibility);
}
// Specular occlusion from ambient visibility (Lagarde & de Rousiers 2014).
float specularOcclusion(float nv, float visibility, float roughness) {
  return clamp(pow(nv + visibility, exp2(-16.0 * roughness - 1.0)) - 1.0 + visibility, 0.0, 1.0);
}
// GGX distribution times the Schlick-GGX visibility term.
float ggxLobe(float nh, float nl, float nv, float roughness) {
  float alpha = max(roughness * roughness, 0.002);
  float alpha2 = alpha * alpha;
  float denominator = nh * nh * (alpha2 - 1.0) + 1.0;
  float k = alpha * 0.5;
  return alpha2 / (PI * denominator * denominator) * 0.25 / ((nl * (1.0 - k) + k) * (nv * (1.0 - k) + k));
}
// Pre-integrated skin diffusion (Penner & Borshukov): red follows the smooth
// geometric normal, green/blue the detailed normal (cheap normal blurring).
vec3 skinDiffuse(float nlGeometric, float nlDetail, float curvature) {
  vec2 size = vec2(textureSize(uSkinLut, 0));
  vec2 scale = (size - 1.0) / size;
  vec2 offset = 0.5 / size;
  float v = clamp(curvature / uSkinLutCurvature, 0.0, 1.0) * scale.y + offset.y;
  vec3 broad = texture(uSkinLut, vec2(clamp(nlGeometric * 0.5 + 0.5, 0.0, 1.0) * scale.x + offset.x, v)).rgb;
  vec3 detail = texture(uSkinLut, vec2(clamp(nlDetail * 0.5 + 0.5, 0.0, 1.0) * scale.x + offset.x, v)).rgb;
  vec3 falloff = vec3(broad.r, detail.g, detail.b);
  return falloff * falloff;
}
// Scattered light bleeds red into the key-light penumbra.
vec3 skinShadow(float visibility) {
  return clamp(vec3(visibility) + vec3(0.62, 0.16, 0.04) * visibility * (1.0 - visibility), 0.0, 1.0);
}
float gaussian3(vec3 p, vec3 center, vec3 radius) { vec3 d = (p - center) / radius; return exp(-dot(d, d)); }
// Surface-attached regional masks (template space + official fields):
// x redness (nose, cheeks, ears, perioral), y under-eye, z T-zone, w cheeks.
vec4 skinRegionMasks() {
  vec3 t = vTemplate;
  float front = smoothstep(0.35, 0.75, vC.y);
  float lipFree = 1.0 - smoothstep(0.05, 0.5, vA.x);
  float nose = max(gaussian3(t, uRegionAnchors[0], vec3(0.011, 0.012, 0.014)), 0.85 * max(gaussian3(t, uRegionAnchors[1], vec3(0.0075, 0.007, 0.01)), gaussian3(t, uRegionAnchors[2], vec3(0.0075, 0.007, 0.01))));
  float perioral = gaussian3(t, uRegionAnchors[5] + vec3(0.0, 0.002, 0.0), vec3(0.03, 0.021, 0.03)) * lipFree * front;
  vec3 cheekOffset = vec3(0.0105, -0.03, -0.012);
  float cheekApples = max(gaussian3(t, uRegionAnchors[3] + cheekOffset * vec3(-1.0, 1.0, 1.0), vec3(0.021, 0.019, 0.05)),
                          gaussian3(t, uRegionAnchors[4] + cheekOffset, vec3(0.021, 0.019, 0.05)));
  float cheeks = cheekApples * smoothstep(0.05, 0.6, vD.z) * lipFree;
  float redness = clamp(0.62 * nose + 0.58 * cheeks + 0.75 * vB.z + 0.3 * perioral, 0.0, 1.0);
  vec3 lidOffset = vec3(0.0, -0.0088, 0.0015);
  float underEye = max(gaussian3(t, uRegionAnchors[3] + lidOffset + vec3(0.003, 0.0, 0.0), vec3(0.015, 0.0075, 0.012)),
                       gaussian3(t, uRegionAnchors[4] + lidOffset - vec3(0.003, 0.0, 0.0), vec3(0.015, 0.0075, 0.012)));
  underEye *= (1.0 - vB.w) * front;
  float forehead = gaussian3(t, uRegionAnchors[7] + vec3(0.0, 0.034, -0.006), vec3(0.034, 0.024, 0.05)) * (1.0 - smoothstep(-10.0, 0.0, vC.x)) * front;
  float chin = gaussian3(t, uRegionAnchors[6] + vec3(0.0, 0.009, 0.004), vec3(0.016, 0.012, 0.02));
  float tzone = clamp(max(max(forehead, nose), chin * lipFree), 0.0, 1.0);
  return vec4(redness, underEye, tzone, cheeks);
}
// Shaved-beard shadow region from the beard fields, independent of the beard control.
float beardShadowMask() {
  float full = (1.0 - smoothstep(-12.0, 3.0, vE.x + 6.0)) * smoothstep(-10.0, 6.0, vE.y) * smoothstep(0.2, 0.65, vC.y);
  float dx = abs(vE.z);
  float dy = vE.w;
  float upperLip = (1.0 - smoothstep(16.0, 26.0, dx + max(dy - 6.0, 0.0) * 0.6)) * smoothstep(1.0, 4.5, dy) * (1.0 - smoothstep(10.0, 15.0, dy + dx * 0.08)) * smoothstep(0.55, 0.8, vC.y);
  return clamp(max(full, upperLip), 0.0, 1.0) * (1.0 - smoothstep(0.05, 0.4, vA.x)) * (1.0 - vA.y) * (1.0 - vB.z);
}
${TONE_MAPPING_GLSL}
// Tone mapping lives in the final composite; the direct fallback applies it here.
vec3 encodeScene(vec3 radiance) {
  radiance = max(radiance, vec3(0.0));
  if (uSceneEncoding == 0) return radiance;
  if (uSceneEncoding == 1) return sqrt(radiance / (1.0 + radiance));
  return toSrgb(tonemap(radiance));
}
int nearestEye(vec3 p) { return distance(p, uEyeCenters[0].xyz) <= distance(p, uEyeCenters[1].xyz) ? 0 : 1; }
// Polar angle of the lid/eyeball contact line at an azimuth (periodic table).
float lidContactAngle(int eye, float azimuth) {
  float x = (azimuth + PI) / (2.0 * PI) * 32.0 - 0.5;
  float cell = floor(x);
  int a = int(mod(cell, 32.0));
  int b = int(mod(cell + 1.0, 32.0));
  return mix(uLidContact[eye * 8 + a / 4][a % 4], uLidContact[eye * 8 + b / 4][b % 4], x - cell);
}
// Distance (m) over the eyeball from p to the lid contact line (> 0 inside
// the eye opening) and the sine of p's azimuth (1 under the upper lid).
vec2 lidDistance(int eye, vec3 p) {
  vec3 axis = uEyeAxes[eye].xyz;
  vec3 up = uEyeUps[eye];
  vec3 d = normalize(p - uEyeCenters[eye].xyz);
  float polar = acos(clamp(dot(d, axis), -1.0, 1.0));
  float azimuth = atan(dot(d, up), dot(d, cross(up, axis)));
  return vec2((lidContactAngle(eye, azimuth) - polar) * uEyeCenters[eye].w, sin(azimuth));
}
// Signed distance (m) from p to the eyeball's outer envelope: the scleral
// sphere or the corneal dome, whichever is further out (mirrors the rig).
float eyeEnvelopeGap(int eye, vec3 p) {
  vec3 offset = p - uEyeCenters[eye].xyz;
  float distance_ = length(offset);
  vec3 direction = offset / max(distance_, 1e-6);
  vec3 toCornea = uEyeCenters[eye].xyz - uCorneas[eye].xyz;
  float b = dot(direction, toCornea);
  float discriminant = b * b - (dot(toCornea, toCornea) - uCorneas[eye].w * uCorneas[eye].w);
  return distance_ - max(uEyeCenters[eye].w, discriminant >= 0.0 ? -b + sqrt(discriminant) : 0.0);
}
// Eye occlusion: lid thickness, lashes and the tear meniscus shade a band of
// the eyeball along the contact line, wider and darker under the upper lid.
float eyeOcclusion(int eye, vec3 p) {
  vec2 lid = lidDistance(eye, p);
  float upper = smoothstep(-0.25, 0.35, lid.y);
  return mix(mix(0.52, 0.34, upper), 1.0, smoothstep(0.0, mix(0.0011, 0.0027, upper), lid.x));
}
// Iris point seen through the cornea: when the view ray enters the corneal
// cap (the dome inside the limbus), it refracts (air to aqueous humour,
// n = 1.336) and meets the iris plane. Every eyeball fragment behind the cap
// uses it, including sclera seen past the limbus at grazing views, so the
// iris gets its depth, parallax and magnification without a seam.
bool refractedIrisPoint(int eye, vec3 p, out vec3 irisPoint) {
  irisPoint = p;
  vec3 axis = uIrisNormals[eye].xyz;
  vec3 irisCenter = uIrisCenters[eye];
  vec3 ray = normalize(p - uCameraPosition);
  vec3 oc = uCameraPosition - uCorneas[eye].xyz;
  float b = dot(ray, oc);
  float h = b * b - (dot(oc, oc) - uCorneas[eye].w * uCorneas[eye].w);
  if (h <= 0.0) return false;
  vec3 hit = uCameraPosition + ray * (-b - sqrt(h));
  vec3 fromIris = hit - irisCenter;
  float height = dot(fromIris, axis);
  // Outside the cap: behind the iris plane or beyond the limbus radius.
  if (height <= 0.0 || length(fromIris - axis * height) > uIrisNormals[eye].w * 1.04) return false;
  vec3 bent = refract(ray, normalize(hit - uCorneas[eye].xyz), 1.0 / 1.336);
  float along = dot(bent, axis);
  if (along > -1e-3) return false;
  irisPoint = hit + bent * (-height / along);
  return true;
}
// Procedural iris stroma. u: 0 at the pupil edge .. 1 at the limbus; angle
// in radians; pixelAngle is the angle a pixel spans at this radius, so each
// fibre octave fades out before it would alias. Structure (radial fibres,
// crypts, collarette, pupillary ruff, limbal ring) mixes in greyer and darker
// tones, so the catalogue pigment reads less saturated.
vec3 irisStroma(float u, float angle, float pixelAngle) {
  vec3 base = uIris;
  float luma = dot(base, vec3(0.2126, 0.7152, 0.0722));
  // Lighter stromal fibres keep most of the pigment's hue (warm for brown
  // and hazel); the darker ground between them keeps the iris from glowing.
  vec3 fibreColor = mix(vec3(luma), base, 0.72) * 1.45 + vec3(0.012, 0.008, 0.004);
  vec2 ring = vec2(cos(angle), sin(angle));
  vec2 swirl = vec2(cos(angle + 0.22 * u), sin(angle + 0.22 * u));
  // Three radial octaves, each faded out before it would alias: broad
  // trabecular bundles, coarse fibres and fine fibres.
  float bundles = mix(0.5, noise3(vec3(swirl * 15.0 + uIrisOffset * 0.5, u * 1.7)), 1.0 - smoothstep(0.35, 0.8, pixelAngle / 0.066));
  float coarse = mix(0.5, noise3(vec3(swirl * 38.0 + uIrisOffset, u * 2.4)), 1.0 - smoothstep(0.35, 0.8, pixelAngle / 0.026));
  float fine = mix(0.5, noise3(vec3(swirl * 86.0 + uIrisOffset * 1.7, u * 4.5)), 1.0 - smoothstep(0.35, 0.8, pixelAngle / 0.0116));
  float fibres = bundles * 0.35 + coarse * 0.4 + fine * 0.25;
  // Crypts: radially elongated openings between the collarette and mid-iris.
  float crypts = smoothstep(0.66, 0.84, noise3(vec3(ring * 13.0 - uIrisOffset, u * 3.2))) * (1.0 - smoothstep(0.5, 0.85, u)) * uIrisDetail.w * (1.0 - smoothstep(0.35, 0.8, pixelAngle / 0.08));
  // The collarette zig-zags with the bundles, so the pupillary zone never
  // reads as a flat painted ring.
  float collaretteRadius = uIrisDetail.y + 0.07 * (noise3(vec3(ring * 4.5 + uIrisOffset, 0.5)) - 0.5) + 0.12 * (bundles - 0.5);
  float collarette = exp(-pow((u - collaretteRadius) / 0.06, 2.0)) * smoothstep(0.25, 0.75, coarse);
  float pupillaryZone = 1.0 - smoothstep(collaretteRadius - 0.08, collaretteRadius + 0.05, u);
  vec3 stroma = mix(base * 0.56, fibreColor, smoothstep(0.28, 0.82, fibres) * uIrisDetail.z * 0.7);
  // Central heterochromia: an amber pupillary zone on some seeds.
  vec3 amber = vec3(0.3, 0.16, 0.05) * clamp(luma * 4.0, 0.35, 1.2);
  stroma = mix(stroma, amber * (0.6 + 0.8 * fibres), pupillaryZone * uIrisDetail2.y);
  stroma = mix(stroma, fibreColor * 0.9, collarette * 0.2);
  stroma *= 1.0 - 0.35 * crypts;
  // Darker limbal ring, softened so it never reads as an outline.
  stroma = mix(stroma, base * 0.32, smoothstep(0.7, 1.0, u + 0.08 * (bundles - 0.5)) * uIrisDetail2.x * 0.8);
  return mix(stroma, vec3(0.04, 0.026, 0.017), (1.0 - smoothstep(0.0, 0.07, u)) * 0.85);
}
// Off-white sclera with a warm tint, pinker towards the canthi, darker away
// from the cornea, with faint vessels (ridged noise, faded when sub-pixel).
vec3 scleraAlbedo(int eye, vec3 d, float polar, float footprint) {
  vec3 axis = uEyeAxes[eye].xyz;
  vec3 up = uEyeUps[eye];
  float horizontal = abs(dot(d, cross(up, axis)));
  vec3 sclera = vec3(0.42, 0.39, 0.35) * mix(1.0, 0.78, smoothstep(0.5, 1.2, polar));
  float corners = smoothstep(0.35, 0.85, horizontal) * smoothstep(0.45, 0.95, polar);
  sclera = mix(sclera, sclera * vec3(1.06, 0.8, 0.76), corners * 0.6);
  vec3 q = d * 9.0 + vec3(uIrisOffset * 0.37, float(eye) * 7.0);
  float veins = pow(1.0 - abs(2.0 * noise3(q) - 1.0), 12.0) + 0.6 * pow(1.0 - abs(2.0 * noise3(q * 2.7 + 5.0) - 1.0), 16.0);
  veins *= smoothstep(0.42, 0.95, polar) * (0.3 + 0.7 * corners) * uIrisDetail2.z * (1.0 - smoothstep(0.00022, 0.0006, footprint));
  return mix(sclera, vec3(0.34, 0.05, 0.045), clamp(veins, 0.0, 1.0) * 0.5);
}
// A studio softbox seen in a mirror direction (view space): a rounded
// rectangle of angular half-size halfSize (tangents) around axis, with a
// slightly brighter centre, as radiance per unit irradiance (a softbox that
// delivers irradiance E has radiance E / solid angle). Uniform control flow.
float softbox(vec3 direction, vec3 axis, vec2 halfSize) {
  float facing = dot(direction, axis);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), axis));
  vec3 up = cross(axis, right);
  // Tangent-plane coordinates stay bounded away from the light, so the
  // anti-aliasing width (fwidth) never explodes across the reflection.
  vec2 q = vec2(dot(direction, right), dot(direction, up)) / max(facing, 0.5);
  float radius = 0.3 * min(halfSize.x, halfSize.y);
  vec2 corner = abs(q) - halfSize + radius;
  float sdf = length(max(corner, 0.0)) + min(max(corner.x, corner.y), 0.0) - radius;
  float edge = clamp(fwidth(sdf), 0.002, 0.03);
  float shape = (1.0 - smoothstep(-edge, edge, sdf)) * smoothstep(0.8, 0.9, facing);
  return shape * (1.1 - 0.35 * dot(q / halfSize, q / halfSize)) * PI / (4.0 * halfSize.x * halfSize.y);
}
void main() {
  vec3 viewDirection = safeNormalize(-vViewPosition, vec3(0.0, 0.0, 1.0));
  vec3 normal = safeNormalize(vViewNormal, viewDirection);
  float facing = dot(normal, viewDirection) > 0.0 ? 1.0 : -1.0;
  normal = faceforward(normal, -viewDirection, normal);
  vec3 geometricNormal = normal;
  vec3 worldNormal = safeNormalize(vWorldNormal * facing, vec3(0.0, 1.0, 0.0));
  if (uDebugField >= 0 && uDebugField <= 20) {
    if (uDebugField == 20) { color = vec4(normal * 0.5 + 0.5, 1.0); return; }
    vec4 fields[5] = vec4[5](vA, vB, vC, vD, vE);
    int group = uDebugField / 4;
    int channel = uDebugField - group * 4;
    float value = (fields[group][channel] - uFieldMin[group][channel]) / max(uFieldMax[group][channel] - uFieldMin[group][channel], 1e-6);
    color = vec4(mix(vec3(0.05, 0.1, 0.45), vec3(1.0, 0.85, 0.2), clamp(value, 0.0, 1.0)), 1.0);
    return;
  }
  vec3 albedo = uSkin;
  float roughness = 0.57;
  float f0 = 0.024;
  float wrap = 0.22;
  float occlusion = 1.0;
  float sheen = 0.0;
  float cavity = 0.0;
  float specularWeight = 1.0;
  float aoFloor = 0.0;
  float upperLid = 0.0;
  vec4 regions = vec4(0.0);
  if (uComponent == 13) {
    // Eyelash strands: fibre shading around the tangent, root-to-tip pigment,
    // key-light shadows from the (stochastic) lash casters, coverage alpha
    // resolved by alpha-to-coverage.
    vec3 tangent = safeNormalize(vViewNormal, vec3(0.0, 1.0, 0.0));
    vec3 fibreNormal = safeNormalize(viewDirection - tangent * dot(viewDirection, tangent), viewDirection);
    vec3 fibreWorld = safeNormalize(transpose(mat3(uView)) * fibreNormal, vec3(0.0, 0.0, 1.0));
    vec3 fibre = mix(uLashRoot, uLashTip, smoothstep(0.35, 1.0, vUv.y)) * (0.85 + 0.3 * vEyeMask.y);
    // Lower lashes are finer and lighter (vSurface.x: lower-lid flag).
    fibre = mix(fibre, fibre * 1.35 + vec3(0.01, 0.008, 0.006), vSurface.x * 0.6);
    float lit = strandShadow(fibreWorld);
    float keyCosine = dot(tangent, uKeyDirection);
    float keySine = sqrt(max(1.0 - keyCosine * keyCosine, 0.0));
    float rimCosine = dot(tangent, uRimDirection);
    vec3 halfKey = safeNormalize(uKeyDirection + viewDirection, fibreNormal);
    float halfCosine = dot(tangent, halfKey);
    float highlight = pow(sqrt(max(1.0 - halfCosine * halfCosine, 0.0)), 80.0);
    float ambient = clamp(vSurface.z, 0.0, 1.0);
    vec3 radiance = fibre * (uKeyColor * (0.25 + 0.55 * keySine) * lit + uRimColor * 0.4 * sqrt(max(1.0 - rimCosine * rimCosine, 0.0)) + shDiffuse(fibreNormal) * ambient)
      + uKeyColor * highlight * lit * 0.05 * (0.35 + fibre);
    if (any(isnan(radiance)) || any(isinf(radiance))) radiance = fibre * 0.3;
    color = vec4(encodeScene(radiance), clamp(vEyeMask.x, 0.0, 1.0));
    return;
  }
  if (uComponent == 0) {
    if (vObject.y + 0.12 * (vObject.z - uCollarPlane.y) < uCollarPlane.x - 0.001) discard;
    float variation = noise3(vObject * 900.0) * 0.6 + noise3(vObject * 180.0) * 0.4;
    // Subpixel pore detail fades out rather than sparkling in gallery thumbnails.
    float footprint = max(length(dFdx(vObject)), length(dFdy(vObject)));
    float poreDetail = 1.0 - smoothstep(0.0003, 0.0011, footprint);
    float pores = noise3(vObject * 1800.0);
    float wrinkles = ageCreases() * uFlags.z;
    float height = (pores - 0.5) * 0.000018 * poreDetail * (1.0 - vA.x) - wrinkles * 0.00016;
    vec3 dpdx = dFdx(vViewPosition), dpdy = dFdy(vViewPosition);
    vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
    float determinant = dot(dpdx, r1);
    vec3 gradient = sign(determinant) * (dFdx(height) * r1 + dFdy(height) * r2);
    normal = safeNormalize(abs(determinant) * normal - gradient, normal);
    roughness += (pores - 0.5) * 0.07 * poreDetail;
    cavity = clamp(vSurface.x, 0.0, 1.0);
    albedo *= (0.965 + 0.07 * variation) * (1.0 - wrinkles * 0.24);
    // Seed-stable regional variation: hemoglobin, periorbital, shaved-beard
    // shadow and sebum (T-zone vs cheeks), scaled per tone/profile on the CPU.
    regions = skinRegionMasks();
    // Low-frequency blood-flow mottling keeps fair skin from reading as
    // porcelain; template space + a per-seed offset keeps it surface-attached.
    vec3 mottleCoordinate = vTemplate + uSkinMottleOffset;
    float mottling = (noise3(mottleCoordinate * 55.0) * 0.65 + noise3(mottleCoordinate * 150.0) * 0.35 - 0.5) * 0.5 * smoothstep(0.3, 0.7, vC.y);
    albedo *= mix(vec3(1.0), vec3(1.08, 0.78, 0.8), clamp((regions.x + mottling) * uSkinRegions.x, 0.0, 1.2) * 0.8);
    albedo *= mix(vec3(1.0), mix(vec3(0.8, 0.75, 0.74), vec3(0.87, 0.82, 0.9), uSkinLightness), regions.y * uSkinRegions.y * 0.7);
    albedo *= mix(vec3(1.0), vec3(0.86, 0.87, 0.9), beardShadowMask() * uSkinRegions.z * mix(0.3, 0.75, uSkinLightness));
    roughness += 0.05 * regions.w - 0.085 * regions.z * mix(0.6, 1.25, uSkinRegions.w);
    albedo = mix(albedo, albedo * vec3(0.94, 0.74, 0.74), vB.w * 0.65);
    // Wet posterior lid margin and caruncle (inner canthus): moist pink
    // mucosa with a slightly lumpy caruncle and a sharp wet highlight.
    float wet = clamp(vEyeMask.y, 0.0, 1.0);
    // The socket lining rolls under the eyeball envelope: seen edge-on next
    // to the recessed eyeball (behind the corneal shell) it would read as a
    // dark crevice. It is cut just outside the envelope, so the lid edge
    // meets the eye at the contact line, where the tear meniscus sits.
    if (wet > 0.0 || vB.w > 0.25) {
      int eye = nearestEye(vObject);
      float gap = eyeEnvelopeGap(eye, vObject);
      if (gap < 0.00008) discard;
      // In the concave lid/eye corner the tear meniscus fills the crevice:
      // near the eyeball the lining takes the meniscus orientation (out of
      // the eye opening) instead of its rolled, light-facing-away normal,
      // and the coarse per-vertex occlusion is floored.
      // The upper lid's posterior rim stays mostly hidden and shadowed.
      upperLid = smoothstep(0.1, 0.5, lidDistance(eye, vObject).y);
      float corner = (1.0 - smoothstep(0.0002, 0.0009, gap)) * (1.0 - 0.7 * upperLid);
      vec3 radial = normalize(vObject - uEyeCenters[eye].xyz);
      vec3 meniscusView = normalize(mat3(uView) * radial);
      normal = safeNormalize(mix(normal, meniscusView, corner), normal);
      geometricNormal = safeNormalize(mix(geometricNormal, meniscusView, corner), geometricNormal);
      worldNormal = safeNormalize(mix(worldNormal, radial, corner), worldNormal);
      aoFloor = max(aoFloor, 0.7 * corner);
      wet = max(wet, corner);
    }
    if (wet > 0.0) {
      float canthus = min(distance(vObject, uInnerCanthi[0]), distance(vObject, uInnerCanthi[1]));
      float caruncle = wet * (1.0 - smoothstep(0.0022, 0.0052, canthus));
      vec3 mucosa = mix(vec3(0.42, 0.17, 0.16), vec3(0.56, 0.2, 0.2), caruncle);
      mucosa = mix(mucosa, albedo, 0.5 * (1.0 - uSkinLightness));
      albedo = mix(albedo, mucosa * (0.92 + 0.16 * noise3(vObject * 3200.0)), wet * 0.85 * (1.0 - 0.55 * upperLid));
      normal = safeNormalize(normal + (vec3(noise3(vObject * 2600.0), noise3(vObject * 2600.0 + 17.0), noise3(vObject * 2600.0 + 31.0)) - 0.5) * 0.5 * caruncle, normal);
      roughness = mix(roughness, 0.2, wet);
      cavity *= 1.0 - wet;
      // The visible waterline faces the opening: the coarse per-vertex bake
      // over-darkens it next to the eyeball.
      aoFloor = max(aoFloor, wet * 0.6);
    }
    // Lash line: dense lash roots darken the anterior lid margin.
    albedo = mix(albedo, albedo * 0.42 + uLashRoot * 0.3, clamp(vEyeMask.x, 0.0, 1.0) * 0.6);
    albedo = mix(albedo, uLip, smoothstep(0.15, 0.85, vA.x));
    roughness = mix(roughness, 0.44, vA.x);
    albedo = mix(albedo, vec3(0.28, 0.07, 0.07), vA.y);
    if (uFlags.x > 0.5) {
      // Sparse, individually resolved pigment spots; never a whole-skin tint.
      vec2 cell = floor(vObject.xy * 530.0);
      vec2 local = fract(vObject.xy * 530.0);
      float pick = hash31(vec3(cell, 7.0));
      vec2 center = vec2(hash31(vec3(cell, 11.0)), hash31(vec3(cell, 23.0))) * 0.5 + 0.25;
      float radius = 0.10 + hash31(vec3(cell, 41.0)) * 0.13;
      float aa = max(fwidth(length(local - center)), 0.025);
      float spots = (1.0 - smoothstep(radius - aa, radius + aa, length(local - center))) * step(0.64, pick) * smoothstep(0.15, 0.60, vB.y) * smoothstep(8.0, 24.0, vE.w) * (1.0 - smoothstep(54.0, 76.0, vE.w));
      albedo = mix(albedo, albedo * vec3(0.50, 0.35, 0.25), spots * 0.78);
    }
    if (uFlags.y > 0.5) {
      float scar = (1.0 - smoothstep(0.6, 1.3, vC.w)) * (1.0 - vB.w);
      albedo = mix(albedo, albedo * vec3(1.12, 0.93, 0.93) + vec3(0.03), scar * 0.8);
    }
    albedo *= mix(1.0, 0.93, uFlags.z * vD.w * (1.0 - vA.x));
    // Beard and brows are strands (drawn after the skin). Under them the skin
    // takes a faint root tint, and stubble a follicle darkening, graded by
    // the same per-vertex density as the strand roots: it never extends
    // past the hair and fades with it (no painted patch or stencil edge).
    vec2 facialHair = clamp(vFacialHair, 0.0, 1.0);
    if (facialHair.x + facialHair.y > 0.0) {
      float footprint = max(length(dFdx(vObject)), length(dFdy(vObject)));
      // Fine follicle dots (~0.15 mm), faded out before they would alias.
      float follicles = mix(noise3(vTemplate * 6400.0) * 0.75 + noise3(vTemplate * 2200.0) * 0.25, 0.5, smoothstep(0.00012, 0.0004, footprint));
      float darkening = facialHair.x * uFacialUnderlay.y * mix(0.6, 1.4, follicles);
      albedo *= mix(vec3(1.0), mix(vec3(0.78, 0.79, 0.83), vec3(0.72, 0.72, 0.75), 1.0 - uSkinLightness), clamp(darkening, 0.0, 1.0));
      // The root tint only darkens (light blond or grey roots never lighten the skin).
      albedo = mix(albedo, min(albedo, uBeardRoot), clamp(facialHair.x * uFacialUnderlay.x * mix(0.75, 1.25, follicles), 0.0, 1.0));
      albedo = mix(albedo, min(albedo, uBrowRoot), clamp(facialHair.y * uFacialUnderlay.z * mix(0.75, 1.25, follicles), 0.0, 1.0));
      roughness = mix(roughness, 0.62, clamp(max(facialHair.x * uFacialUnderlay.x, facialHair.y * uFacialUnderlay.z) * 2.0, 0.0, 1.0));
    }
    if (uHairStyle2.w > 0.5) {
      // Scalp under the strands: hair roots tint the skin by their density
      // (soft hairline, graded fades, the parting), with fine follicle dots
      // that fade out before they would alias. Buzz cuts and fades show it.
      float coverage = hairCoverage(vC.x, vC.y);
      float part = hairPartMask();
      float density = coverage * part;
      float footprint = max(length(dFdx(vObject)), length(dFdy(vObject)));
      float follicles = mix(noise3(vObject * 2600.0) * 0.7 + noise3(vObject * 900.0) * 0.3, 0.5, smoothstep(0.00022, 0.0007, footprint));
      vec3 roots = uHair * 0.62;
      // Where the hair is dense (not on buzz cuts) no skin shows between the roots.
      float dense = smoothstep(0.75, 1.0, density) * step(0.7, uHairPart.w);
      albedo = mix(albedo, roots, clamp(density * mix(uHairPart.w * mix(0.72, 1.18, follicles), 1.0, dense), 0.0, 1.0));
      // The parting: a narrow line of paler, unexposed scalp in the shade of
      // the hair on both sides (darker and less saturated than the face).
      float parting = coverage * (1.0 - part);
      albedo = mix(albedo, mix(vec3(dot(albedo, vec3(0.299, 0.587, 0.114))), albedo, 0.3) * 0.55, parting * 0.9);
      roughness = mix(roughness, 0.62, max(density, parting));
      // ...deep in the shade of the hair walls on both sides of it.
      occlusion *= 1.0 - 0.8 * parting;
    }

  } else if (uComponent == 1) {
    // Eyeball: sclera and the flat iris plane behind the corneal dome.
    int eye = nearestEye(vObject);
    vec3 center = uEyeCenters[eye].xyz;
    vec3 axis = uEyeAxes[eye].xyz;
    vec3 direction = normalize(vObject - center);
    float polar = acos(clamp(dot(direction, axis), -1.0, 1.0));
    float footprint = max(length(dFdx(vObject)), length(dFdy(vObject)));
    vec3 irisCenter = uIrisCenters[eye];
    vec3 irisNormal = uIrisNormals[eye].xyz;
    float irisRadius = uIrisNormals[eye].w;
    vec3 irisPoint;
    bool refracted = refractedIrisPoint(eye, vObject, irisPoint);
    vec3 fromIris = vObject - irisCenter;
    vec3 geometric = fromIris - irisNormal * dot(fromIris, irisNormal);
    float geometricRadial = length(geometric);
    vec3 local = irisPoint - irisCenter;
    vec3 seen = local - irisNormal * dot(local, irisNormal);
    // Refraction parallax moves the pupil and inner iris with the view but
    // fades out towards the limbus: the iris stays attached to it, and no
    // sclera can show inside the iris boundary at three-quarter views.
    float parallax = refracted ? IRIS_PARALLAX * (1.0 - smoothstep(0.45, 0.92, geometricRadial / irisRadius)) : 0.0;
    vec3 planar = geometric + (seen - geometric) * parallax;
    float radial = length(planar);
    if (geometricRadial < irisRadius) radial = min(radial, irisRadius * 0.985);
    float pupilRadius = irisRadius * uIrisDetail.x;
    float u = clamp((radial - pupilRadius) / max(irisRadius - pupilRadius, 1e-5), 0.0, 1.0);
    vec3 up = normalize(uEyeUps[eye] - irisNormal * dot(uEyeUps[eye], irisNormal));
    float azimuth = atan(dot(planar, up), dot(planar, cross(up, irisNormal)));
    // Angular size of a pixel at this radius: fibre octaves fade out below it.
    float detail = footprint / max(radial, pupilRadius);
    float edge = max(footprint, 0.00002);
    float iris = 1.0 - smoothstep(irisRadius - 0.0003 - edge, irisRadius + 0.0001 + edge, radial);
    float pupil = 1.0 - smoothstep(pupilRadius - 0.00006 - edge, pupilRadius + 0.00006 + edge, radial);
    albedo = mix(scleraAlbedo(eye, direction, polar, footprint), irisStroma(u, azimuth, detail), iris);
    albedo = mix(albedo, vec3(0.005, 0.0045, 0.0045), pupil);
    occlusion = eyeOcclusion(eye, vObject);
    // Eyeball vertices hidden under the lids bake to zero AO; interpolated
    // into the visible opening they would blacken the lid junction. The
    // analytic lid occlusion above models that junction instead.
    aoFloor = 0.5;
    // The tear film and cornea (glass pass) carry the sharp reflections.
    roughness = 0.5;
    f0 = 0.012;
    specularWeight = 0.4 * (1.0 - iris);
    wrap = 0.12;
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
    if (uHairStyle2.z > 3.5) {
      vec3 acrossStrand = safeNormalize(cross(normal, mat3(uView) * hairFlowDirection()), vec3(1.0, 0.0, 0.0));
      normal = safeNormalize(normal + acrossStrand * ((grain - 0.5) * 0.22 + (fine - 0.5) * 0.08), normal);
      roughness = 0.76 - 0.04 * uHairStyle2.y;
      f0 = 0.03;
      sheen = 0.22;
    } else {
      normal = safeNormalize(normal + (vec3(grain, fine, clumps) - 0.5) * 0.35 * (0.6 + uHairStyle2.y), normal);
      roughness = 0.6 - 0.12 * uHairStyle2.y;
      f0 = 0.046;
      sheen = 0.5;
    }
    wrap = 0.45;
  } else if (uComponent == 5 || uComponent == 8 || uComponent == 14) {
    // Glass: cornea (5), spectacle lenses (8) and the tear meniscus (14).
    // Premultiplied mirror reflection of the studio environment plus the key
    // softbox (the catchlight), shadowed by the key-light map so lids and
    // lashes cut it; eye reflections also fade under the lid contact.
    if (uDebugField > 20) discard;
    float lens = uComponent == 8 ? 1.0 : 0.0;
    float tear = uComponent == 14 ? 1.0 : 0.0;
    if (uComponent == 5) {
      // Analytic tear-film normal: the corneal dome inside the limbus, the
      // scleral sphere outside. The coarse shell's interpolated normals face
      // away near grazing silhouettes, which would flip the reflection.
      int eye = nearestEye(vObject);
      vec3 fromIris = vObject - uIrisCenters[eye];
      float radial = length(fromIris - uIrisNormals[eye].xyz * dot(fromIris, uIrisNormals[eye].xyz));
      vec3 domeNormal = normalize(vObject - uCorneas[eye].xyz);
      vec3 scleraNormal = normalize(vObject - uEyeCenters[eye].xyz);
      vec3 analytic = normalize(mix(domeNormal, scleraNormal, smoothstep(uIrisNormals[eye].w * 0.95, uIrisNormals[eye].w * 1.1, radial)));
      normal = safeNormalize(mat3(uView) * analytic, normal);
      worldNormal = analytic;
    }
    float glassF0 = mix(mix(0.025, 0.04, lens), 0.02, tear);
    float fresnel = glassF0 + (1.0 - glassF0) * pow(1.0 - clamp(dot(normal, viewDirection), 0.0, 1.0), 5.0);
    // Real tear films are thin and slightly rough: grazing reflections stay partial.
    fresnel = min(fresnel, mix(0.3, 1.0, lens));
    vec3 mirror = reflect(-viewDirection, normal);
    // The catchlight stays crisp; lashes cut it only as soft partial streaks.
    // The usual normal offset keeps a catchlight just below the lid edge lit.
    float keyVisibility = keyShadow(worldNormal, dot(normal, uKeyDirection), 0.0, lens > 0.5 ? 1.25 : 1.8, 1.0);
    // Key softbox catchlight, plus the (dimmer, larger) fill softbox that the
    // environment otherwise only carries as a broad lobe.
    float keyBox = softbox(mirror, uKeyDirection, vec2(1.15, 0.87) * uShadowParams.z);
    float fillBox = softbox(mirror, FILL_CATCHLIGHT_AXIS, vec2(0.16, 0.2)) * FILL_CATCHLIGHT;
    float lidVisibility = 1.0;
    float lidFade = 1.0;
    float veil = 1.0;
    if (uComponent == 5) {
      int eye = nearestEye(vObject);
      lidVisibility = mix(1.0, eyeOcclusion(eye, vObject), 0.85);
      // Over the iris only a thin wet sheen of the studio remains, so the
      // pigment is not washed out; the softbox catchlight stays crisp.
      vec3 fromIris = vObject - uIrisCenters[eye];
      float radial = length(fromIris - uIrisNormals[eye].xyz * dot(fromIris, uIrisNormals[eye].xyz));
      veil = mix(0.3, 1.0, smoothstep(uIrisNormals[eye].w * 0.9, uIrisNormals[eye].w * 1.1, radial));
      // Where the corneal shell slips under the lids it is seen edge-on: fade
      // it out so no dark grazing sliver outlines the lid junction.
      lidFade = smoothstep(0.0, 0.00025, lidDistance(eye, vObject).x);
    }
    vec3 reflected = environmentRadiance(mirror) * clamp(vSurface.z * 1.4, 0.0, 1.0) * lidVisibility * veil
      + (uKeyColor * keyBox * keyVisibility + uEnvLobeColors[0] * fillBox * clamp(vSurface.z * 1.4, 0.0, 1.0)) * mix(1.0, lidVisibility, 0.5);
    vec3 premultiplied = reflected * fresnel * mix(1.0, 0.9, lens) * lidFade + vec3(0.01, 0.012, 0.016) * lens;
    float a = clamp(fresnel * mix(1.0, 0.7, lens) * lidFade + 0.06 * lens, 0.0, 1.0);
    if (tear > 0.5) {
      // The meniscus fills the lid/eyeball junction: a thin lit body of wet
      // conjunctiva (strongest in the corner of the fillet) under the water.
      float body = pow(sin(PI * clamp(vUv.x, 0.0, 1.0)), 0.7) * 0.8;
      vec3 bodyLight = shDiffuse(normal) + uKeyColor * max(dot(normal, uKeyDirection), 0.0) * keyVisibility;
      premultiplied += vec3(0.6, 0.38, 0.35) * bodyLight * clamp(vSurface.z * 1.3, 0.0, 1.0) * body * (1.0 - fresnel);
      a = body + fresnel * (1.0 - body);
    }
    color = vec4(encodeScene(premultiplied), a);
    return;
  } else if (uComponent == 7) {
    albedo = vec3(0.018, 0.016, 0.015);
    roughness = 0.28;
    f0 = 0.05;
    wrap = 0.1;
  } else if (uComponent == 6) {
    float collarBand = 1.0 - smoothstep(0.105, 0.125, vUv.y);
    albedo = mix(uKitPrimary, uKitSecondary, collarBand);
    float rib = 0.92 + 0.08 * cos(vUv.x * 804.248);
    albedo *= mix(1.0, rib, collarBand);
    float weave = noise3(vObject * 2600.0) * 0.6 + noise3(vObject * 600.0) * 0.4;
    albedo *= (0.88 + 0.14 * weave) * mix(1.0, 0.72, smoothstep(0.6, 1.0, vUv.y));
    roughness = 0.78;
    f0 = 0.03;
    wrap = 0.3;
  }
  bool skin = uComponent == 0;
  float nv = max(dot(normal, viewDirection), 1e-3);
  float bakedOcclusion = max(clamp(vSurface.z, 0.0, 1.0), aoFloor);
  // Baked AO carries hair/ears/jaw/collar occlusion; the cavity adds creases
  // finer than the bake and a little micro-shadowing of direct light.
  float ambientVisibility = bakedOcclusion * (1.0 - cavity * 0.56);
  float microShadow = 1.0 - cavity * 0.3;
  float nlKeyGeometric = dot(geometricNormal, uKeyDirection);
  float nlKey = dot(normal, uKeyDirection);
  // Pre-integrated skin still receives light slightly past the terminator.
  bool eyeball = uComponent == 1;
  // Under beard and brow strands the skin filters their stochastic key-map
  // coverage over a wider kernel (still the 16-tap path): millimetres below
  // its blockers the penumbra is tiny and the dither would show as blotches.
  float strandCover = skin ? clamp(max(vFacialHair.x, vFacialHair.y) * 2.0, 0.0, 1.0) : 0.0;
  float rawShadow = keyShadow(worldNormal, nlKeyGeometric, skin ? 0.3 : wrap, eyeball ? EYE_SHADOW_TEXELS : mix(1.25, 3.9, strandCover), eyeball ? 0.0 : 1.0);
  float shadow = quadAverage(rawShadow);
  // At the lid junction a 2x2 quad straddles the lid edge: its hidden pixels
  // (lid skin rolling into the socket, eyeball under the lid) lie in shadow
  // and would stamp dark dashes along the junction. Use the pixel's own
  // kernel there; the analytic lid occlusion covers that band.
  if (uComponent == 1) shadow = mix(rawShadow, shadow, smoothstep(0.0002, 0.0007, lidDistance(nearestEye(vObject), vObject).x));
  if (skin) shadow = mix(shadow, rawShadow, clamp(vEyeMask.y, 0.0, 1.0));
  if (uDebugField == 21) { color = vec4(vec3(shadow), 1.0); return; }
  if (uDebugField == 22) { color = vec4(vec3(clamp(vSurface.z, 0.0, 1.0)), 1.0); return; }
  if (uDebugField == 23) { color = vec4(mix(vec3(0.05, 0.1, 0.45), vec3(1.0, 0.85, 0.2), sqrt(clamp(vSurface.y * SCATTER_SCALE / uSkinLutCurvature, 0.0, 1.0))), 1.0); return; }
  if (uDebugField == 24) { color = vec4(regions.x, regions.z, regions.y, 1.0); return; }
  // The rim light has its own shadow map; baked visibility softens crevices.
  float rimVisibility = rimShadow(worldNormal, dot(geometricNormal, uRimDirection), skin ? 0.3 : wrap) * mix(1.0, bakedOcclusion, 0.5);
  vec3 diffuseLight;
  if (skin) {
    float curvature = vSurface.y * SCATTER_SCALE;
    diffuseLight = uKeyColor * skinDiffuse(nlKeyGeometric, nlKey, curvature) * skinShadow(shadow) * microShadow
      + uRimColor * skinDiffuse(dot(geometricNormal, uRimDirection), dot(normal, uRimDirection), curvature) * rimVisibility;
    // Thin ears transmit the rim light from behind as a red glow.
    diffuseLight += uRimColor * vec3(1.0, 0.3, 0.16) * (0.35 * vB.z * clamp(-dot(geometricNormal, uRimDirection) + 0.2, 0.0, 1.0)) * bakedOcclusion;
  } else {
    diffuseLight = uKeyColor * clamp((nlKey + wrap) / (1.0 + wrap), 0.0, 1.0) * shadow
      + uRimColor * clamp((dot(normal, uRimDirection) + wrap) / (1.0 + wrap), 0.0, 1.0) * rimVisibility;
  }
  vec3 diffuse = albedo * (diffuseLight + shDiffuse(normal) * multiBounce(ambientVisibility, albedo));
  // Skin: dual GGX lobes (sharp 25% / broad 75%); other materials keep one
  // lobe at their previous strength.
  vec2 lobeRoughness = skin ? vec2(roughness * 0.72, min(roughness * 1.3, 1.0)) : vec2(roughness);
  float broadWeight = skin ? 0.75 : 1.0;
  float specularScale = skin ? 1.0 : 0.55;
  vec3 f0Color = vec3(f0);
  vec3 lightDirections[2] = vec3[2](uKeyDirection, uRimDirection);
  vec3 lightColors[2] = vec3[2](uKeyColor * shadow * microShadow, uRimColor * rimVisibility);
  // The key softbox's angular size widens its highlight (alpha' = alpha + size / 2).
  float widening[2] = float[2](0.5 * uShadowParams.z, 0.0);
  vec3 specular = vec3(0.0);
  for (int index = 0; index < 2; index += 1) {
    vec3 lightDirection = lightDirections[index];
    float nl = clamp(dot(normal, lightDirection), 0.0, 1.0);
    if (nl <= 0.0) continue;
    vec3 halfVector = safeNormalize(lightDirection + viewDirection, normal);
    float nh = max(dot(normal, halfVector), 0.0);
    vec3 fresnel = f0Color + (1.0 - f0Color) * pow(1.0 - max(dot(halfVector, viewDirection), 0.0), 5.0);
    vec2 widened = sqrt(lobeRoughness * lobeRoughness + widening[index]);
    float lobe = mix(ggxLobe(nh, nl, nv, widened.x), ggxLobe(nh, nl, nv, widened.y), broadWeight);
    specular += lightColors[index] * fresnel * (PI * lobe * nl);
  }
  vec3 reflected = reflect(-viewDirection, normal);
  vec2 brdf = environmentBrdf(lobeRoughness.y, nv);
  // The prefiltered studio is evaluated once, at the dominant (broad) lobe.
  vec3 environment = environmentSpecular(reflected, lobeRoughness.y, nv) * (f0Color * brdf.x + brdf.y);
  specular = (specular + environment * specularOcclusion(nv, ambientVisibility, roughness)) * specularScale * specularWeight;
  float rimSheen = pow(1.0 - nv, 3.0) * sheen;
  if (uComponent == 4) {
    vec3 flow = mat3(uView) * normalize(hairFlowDirection());
    vec3 tangent = safeNormalize(flow - normal * dot(normal, flow), vec3(1.0, 0.0, 0.0));
    vec3 halfKey = safeNormalize(uKeyDirection + viewDirection, normal);
    float th = dot(tangent, halfKey);
    float kajiya = pow(sqrt(max(1.0 - th * th, 0.0)), 70.0);
    specular = specular * 0.25 + uKeyColor * 1.65 * shadow * kajiya * (uHairStyle2.z > 3.5 ? 0.035 : 0.09) * (0.5 + uHair * 1.5);
  }
  vec3 radiance = (diffuse + specular) * occlusion + uHair * rimSheen * 0.25 * ambientVisibility;
  if (any(isnan(radiance)) || any(isinf(radiance))) radiance = albedo * 0.5;
  color = vec4(encodeScene(radiance), 1.0);
}`;

/*
 * Scalp hair strands (see gnm-player-hair.js), a dedicated lean program:
 * camera-facing ribbons at least uStrandMinPixels wide (the width they lack
 * becomes coverage), few varyings, and no discard on the multisampled path
 * so hidden fragments can be rejected before shading.
 */
const HAIR_VERTEX = `#version 300 es
layout(location=0) in vec3 aPosition;  // centreline
layout(location=1) in vec3 aNormal;    // unit tangent, root to tip
layout(location=2) in vec3 aUv;        // ribbon side (0/1), t along the strand, width boost (hanging hair)
layout(location=8) in vec4 aSurface;   // half-width (m), random, visibility in the volume, kind
layout(location=10) in float aAoIndex; // AO texel of the root on the hair envelope
uniform mat4 uProjection;
uniform mat4 uView;
uniform vec3 uCameraPosition;
uniform vec2 uViewport;
uniform float uStrandMinPixels;
uniform float uStrandWidthScale;
uniform highp sampler2D uAoTexture;
uniform int uAoBaked;
out vec3 vObject;
out vec3 vViewPosition;
out vec3 vTangent;
out vec4 vStrand;   // t, random, kind, coverage
out float vAmbient; // root AO x visibility in the volume
void main() {
  vec3 tangent = normalize(aNormal);
  vec3 side = cross(tangent, uCameraPosition - aPosition);
  float sideLength = length(side);
  side = sideLength > 1e-9 ? side / sideLength : normalize(cross(tangent, abs(tangent.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  float depth = max(-(uView * vec4(aPosition, 1.0)).z, 1e-3);
  float pixel = 2.0 * depth / (uProjection[1][1] * uViewport.y);
  // Hanging hair widens both its fibre width and its pixel minimum, so its
  // coverage holds at every resolution.
  float boost = 1.0 + aUv.z;
  float trueWidth = aSurface.x * uStrandWidthScale * boost;
  float halfWidth = max(trueWidth, 0.5 * uStrandMinPixels * pixel * boost);
  vec3 position = aPosition + side * halfWidth * (aUv.x * 2.0 - 1.0);
  vec4 view = uView * vec4(position, 1.0);
  vObject = position;
  vViewPosition = view.xyz;
  vTangent = mat3(uView) * tangent;
  vStrand = vec4(aUv.y, aSurface.y, aSurface.w, clamp(trueWidth / halfWidth, 0.0, 1.0));
  float occlusion = 1.0;
  if (uAoBaked == 1) {
    int index = int(aAoIndex + 0.5);
    int width = textureSize(uAoTexture, 0).x;
    occlusion = texelFetch(uAoTexture, ivec2(index % width, index / width), 0).r;
  }
  vAmbient = occlusion * aSurface.z;
  gl_Position = uProjection * view;
}`;

/** Hair fragment shader; `dithered` (direct fallback, no MSAA) turns coverage into screen-door transparency. */
function hairFragmentSource(dithered) {
  return `#version 300 es
precision highp float;
in vec3 vObject;
in vec3 vViewPosition;
in vec3 vTangent;
in vec4 vStrand;
in float vAmbient;
uniform int uSceneEncoding;
uniform mat4 uView;
uniform vec3 uKeyDirection;      // view space, towards the light
uniform vec3 uKeyWorld;          // world space
uniform vec3 uKeyColor;
uniform vec3 uRimDirection;
uniform vec3 uRimColor;
uniform vec3 uShDiffuse[9];
uniform highp sampler2D uShadowDepth;
uniform mat4 uKeyLightMatrix;
uniform vec4 uShadowParams;      // enabled, texel size (uv), light size (tan), volume diameter (m)
uniform highp sampler2DShadow uRimShadowMap;
uniform mat4 uRimLightMatrix;
uniform vec4 uRimShadowParams;
uniform vec3 uHairPigment;       // un-greyed pigment (linear); the age-greyed mean is the hair colour
uniform vec3 uHairGrey;          // grey strand colour (linear)
uniform vec4 uHairFibre;         // tip lightening, grey-strand fraction, longitudinal roughness (rad), tip fade start (t)
uniform vec3 uHairCenter;        // head centre (world): the volume normal is radial from it
uniform vec2 uStrandOpacity;     // body opacity floor of terminal strands, of wisps (fine and stray hairs)
uniform int uDebugField;         // -1 off; 20 normals, 21 key visibility, 22 ambient occlusion; other views: flat
out vec4 color;
${TONE_MAPPING_GLSL}
vec3 encodeScene(vec3 radiance) {
  radiance = max(radiance, vec3(0.0));
  if (uSceneEncoding == 0) return radiance;
  if (uSceneEncoding == 1) return sqrt(radiance / (1.0 + radiance));
  return toSrgb(tonemap(radiance));
}
float interleavedNoise(vec2 pixel) { return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715)))); }
vec3 shDiffuse(vec3 n) {
  vec3 value = uShDiffuse[0] + uShDiffuse[1] * n.y + uShDiffuse[2] * n.z + uShDiffuse[3] * n.x
    + uShDiffuse[4] * (n.x * n.y) + uShDiffuse[5] * (n.y * n.z) + uShDiffuse[6] * (3.0 * n.z * n.z - 1.0)
    + uShDiffuse[7] * (n.x * n.z) + uShDiffuse[8] * (n.x * n.x - n.y * n.y);
  return max(value, vec3(0.0));
}
// Longitudinal fibre lobe: a normalized Gaussian in sin(theta_i) + sin(theta_r).
float fibreLobe(float x, float width) { return exp(-0.5 * x * x / (width * width)) / (width * 2.5066283); }
// Marschner-style fibre scattering (in the spirit of the published real-time
// approximations): R, TT and TRT longitudinal lobes around the half angle,
// shifted by the cuticle tilt (R towards the root, TT and the coloured TRT
// towards the tip), simple azimuthal terms and fixed absorption exponents,
// plus a wrapped volume diffuse for multiple scattering. T runs root to tip.
// A render strand stands for several aligned fibres; the R lobe keeps a
// modest, neutral sheen band so dark hair stays dark between highlights.
vec3 hairFibre(vec3 T, vec3 V, vec3 L, vec3 albedo, vec3 tt, vec3 trt, vec3 volumeNormal, float shift, float roughness) {
  float sinL = clamp(dot(T, L), -1.0, 1.0);
  float sinV = clamp(dot(T, V), -1.0, 1.0);
  float cosL = sqrt(max(1.0 - sinL * sinL, 0.0));
  vec3 lp = L - sinL * T;
  vec3 vp = V - sinV * T;
  float cosPhi = dot(lp, vp) * inversesqrt(max(dot(lp, lp) * dot(vp, vp), 1e-8));
  float cosHalfPhi = sqrt(clamp(0.5 + 0.5 * cosPhi, 0.0, 1.0));
  float sum = sinL + sinV;
  float x = 1.0 - sqrt(clamp(0.5 + 0.5 * dot(V, L), 0.0, 1.0));
  float x2 = x * x;
  float fresnel = 0.046 + 0.954 * x2 * x2 * x;
  float r = fibreLobe(sum + 2.0 * shift, 1.6 * roughness) * 0.8 * cosHalfPhi * fresnel;
  vec3 transmitted = fibreLobe(sum - shift, roughness) * exp(-3.65 * cosPhi - 3.98) * tt * (1.0 - fresnel) * (1.0 - fresnel);
  vec3 internal = fibreLobe(sum - 3.0 * shift, 4.0 * roughness) * exp(3.0 * (cosPhi - 1.0)) * 0.7 * trt;
  float wrapped = clamp((dot(volumeNormal, L) + 0.5) / 1.5, 0.0, 1.0);
  vec3 scatter = albedo * mix(wrapped * wrapped, cosL, 0.3) * 0.42;
  return (vec3(r) + transmitted + internal) * cosL + scatter;
}
// Deep-shadow approximation from the key depth map: each of four rotated
// taps attenuates by the thickness of hair between the first occluder and
// the receiver, so strands darken gradually with depth in the volume and
// fibres never hard-shadow their neighbours.
float hairShadow(vec3 position, float thicknessMm) {
  if (uShadowParams.x < 0.5) return 1.0;
  float texel = uShadowParams.y;
  float diameter = uShadowParams.w;
  vec3 coord = (uKeyLightMatrix * vec4(position + uKeyWorld * texel * diameter, 1.0)).xyz * 0.5 + 0.5;
  if (coord.x < 0.002 || coord.y < 0.002 || coord.x > 0.998 || coord.y > 0.998 || coord.z >= 1.0) return 1.0;
  float angle = interleavedNoise(floor(gl_FragCoord.xy)) * 6.2831853;
  vec2 axis = vec2(cos(angle), sin(angle)) * texel * 1.7;
  vec4 occluders = vec4(texture(uShadowDepth, coord.xy + axis).r, texture(uShadowDepth, coord.xy + vec2(-axis.y, axis.x)).r,
                        texture(uShadowDepth, coord.xy - axis).r, texture(uShadowDepth, coord.xy + vec2(axis.y, -axis.x)).r);
  vec4 depthMm = max((coord.z - occluders) * diameter * 1000.0 - 0.6, 0.0);
  vec4 lit = exp(-depthMm / thicknessMm);
  return dot(lit, vec4(0.25));
}
// Rim light visibility: one hardware-filtered tap of the rim depth map.
float rimVisibility(vec3 position, vec3 normal) {
  if (uRimShadowParams.x < 0.5) return 1.0;
  float texel = uRimShadowParams.y;
  float diameter = uRimShadowParams.w;
  vec3 coord = (uRimLightMatrix * vec4(position + normal * texel * diameter * 2.0, 1.0)).xyz * 0.5 + 0.5;
  if (coord.x < 0.002 || coord.y < 0.002 || coord.x > 0.998 || coord.y > 0.998 || coord.z >= 1.0) return 1.0;
  return texture(uRimShadowMap, vec3(coord.xy, coord.z - texel * 3.0));
}
void main() {
  float t = clamp(vStrand.x, 0.0, 1.0);
  float random = vStrand.y;
  float kind = vStrand.z; // scalp: 0 hair, 1 flyaway, 2 baby hair, 3 braid, 4 bun; beard and brows: 0 terminal, 1 stray, 2 fine
  // Coverage: scalp fibre bodies stay nearly opaque (alpha-to-coverage does
  // not accumulate across strands), wisps keep their sub-pixel coverage,
  // tips fade. Beard and brow hairs (one strand per hair) keep more of their
  // true coverage, so their density reads the same at every resolution.
  float body = kind < 0.5 || kind > 2.5 ? uStrandOpacity.x : uStrandOpacity.y;
  // Scalp strands fade over their last ~8 mm (uHairFibre.w), wisps over 20%.
  float alpha = clamp(mix(vStrand.w, 1.0, body) * (kind > 2.5 ? 1.0 : 1.0 - smoothstep(kind < 0.5 ? uHairFibre.w : 0.8, 1.0, t)), 0.0, 1.0);
${dithered ? "  if (interleavedNoise(gl_FragCoord.xy + random * 131.0) >= alpha) discard;\n" : ""}  vec3 viewDirection = normalize(-vViewPosition);
  vec3 tangent = normalize(vTangent);
  // Pigment: each render strand is a lock of several hairs, so its grey share
  // spreads symmetrically around the age fraction (the mean stays the hair
  // colour: salt and pepper up close, grey at a distance); melanin jitter,
  // darker roots, sun-lightened tips on lighter colours.
  float grey = uHairFibre.y;
  float greyShare = grey + (fract(random * 7.31 + 0.137) - 0.5) * 1.8 * min(grey, 1.0 - grey);
  // Mixed in display-like (gamma 2) space, like the model's age-greyed hair
  // colour, so a few grey strands do not read greyer than that colour.
  vec3 pigment = mix(sqrt(uHairPigment), sqrt(uHairGrey), greyShare);
  pigment *= pigment * (0.8 + 0.4 * fract(random * 3.71 + 0.5));
  pigment *= mix(0.68, 1.0, smoothstep(0.0, 0.3, t));
  pigment = mix(pigment, pigment * 1.5 + vec3(0.035, 0.026, 0.014), uHairFibre.x * (1.0 - greyShare) * smoothstep(0.4, 1.0, t));
  pigment = clamp(pigment, vec3(0.002), vec3(0.95));
  // Absorption along the fibre: once through (TT) and twice (TRT); dark
  // (eumelanin-rich) fibres transmit almost nothing, so black and dark brown
  // hair never glow grey in the rim or through thin frizz.
  vec3 tt = sqrt(pigment) * clamp(pigment * 6.0, 0.0, 1.0);
  vec3 trt = pigment * sqrt(tt);
  vec3 volumeWorld = normalize(vObject - uHairCenter);
  vec3 volumeView = normalize(mat3(uView) * volumeWorld);
  // Cuticle tilt (~3 degrees), varying slightly per strand.
  float shift = 0.052 + 0.03 * (fract(random * 5.3) - 0.5);
  float roughness = uHairFibre.z;
  float keyLit = hairShadow(vObject, 3.2);
  if (uDebugField >= 0) {
    // Capture-only debug views (display-encoded passthrough).
    vec3 debugColor = uDebugField == 20 ? volumeView * 0.5 + 0.5 : uDebugField == 21 ? vec3(keyLit) : uDebugField == 22 ? vec3(clamp(vAmbient, 0.0, 1.0)) : vec3(0.18);
    color = vec4(debugColor, alpha);
    return;
  }
  float rimLit = dot(volumeView, uRimDirection) < -0.6 ? 0.0 : rimVisibility(vObject, volumeWorld);
  vec3 radiance = uKeyColor * keyLit * hairFibre(tangent, viewDirection, uKeyDirection, pigment, tt, trt, volumeView, shift, roughness)
    + uRimColor * rimLit * hairFibre(tangent, viewDirection, uRimDirection, pigment, tt, trt, volumeView, shift, roughness);
  // Ambient: studio SH on the volume normal (multiple scattering keeps the
  // mass warm) and a faint sheen of the studio around the fibre.
  vec3 fibreNormal = normalize(viewDirection - tangent * dot(viewDirection, tangent) + vec3(0.0, 0.0, 1e-4));
  radiance += (pigment * shDiffuse(volumeView) * 0.75 + shDiffuse(reflect(-viewDirection, fibreNormal)) * 0.02) * vAmbient;
  // Soft shoulder on HDR highlights so single MSAA samples cannot alias.
  float peak = max(max(radiance.r, radiance.g), radiance.b);
  if (peak > 2.5) radiance *= (2.5 + (peak - 2.5) / (1.0 + (peak - 2.5) / 2.5)) / peak;
  if (any(isnan(radiance)) || any(isinf(radiance))) radiance = pigment * 0.3;
  color = vec4(encodeScene(radiance), alpha);
}`;
}

/* Depth-only pass shared by the key/rim shadow maps and the AO bake layers. */
const DEPTH_VERTEX = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;  // strands: unit tangent
layout(location=2) in vec2 aUv;      // strands: ribbon side, root-to-tip t
layout(location=4) in vec4 aFieldB;  // skin fields; w = eyeSocket
layout(location=8) in vec4 aSurface; // strands: half-width (m), random
uniform mat4 uLightMatrix;
uniform vec3 uClip; // collar plane height, collar plane z, enabled (skin draws only)
// Light maps skip the eye-socket lining: it rolls behind the eyeball, where
// it would only shadow the visible lid margin from inside the eye.
uniform int uSkipSocket;
// Strands (uStrand = 1) expand across the light direction to at least
// uMinHalfWidth (about a shadow-map texel); the width they lack becomes a
// stochastic coverage that the PCF kernel averages into a partial shadow.
// Hair scales its widths by uStrandWidthScale (level of detail) and its
// coverage by uCoverageScale (fibres transmit part of the light).
uniform int uStrand;
uniform vec3 uLightDirection; // world, towards the light
uniform float uMinHalfWidth;
uniform float uStrandWidthScale;
uniform float uCoverageScale;
out float vClip;
out float vCoverage;
out float vRandom;
out float vSocket;
void main() {
  vec3 position = aPosition;
  vCoverage = 1.0;
  vRandom = 0.0;
  vSocket = uSkipSocket == 1 && uClip.z > 0.5 ? aFieldB.w : 0.0;
  if (uStrand == 1) {
    vec3 tangent = normalize(aNormal);
    vec3 side = cross(tangent, uLightDirection);
    float sideLength = length(side);
    side = sideLength > 1e-6 ? side / sideLength : normalize(cross(tangent, abs(tangent.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    float trueWidth = aSurface.x * uStrandWidthScale;
    float halfWidth = max(trueWidth, uMinHalfWidth);
    vCoverage = trueWidth / halfWidth * uCoverageScale;
    vRandom = aSurface.y;
    position += side * halfWidth * (aUv.x * 2.0 - 1.0);
  }
  vClip = uClip.z > 0.5 ? position.y + 0.12 * (position.z - uClip.y) - (uClip.x - 0.001) : 1.0;
  gl_Position = uLightMatrix * vec4(position, 1.0);
}`;

const DEPTH_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
in float vClip;
in float vCoverage;
in float vRandom;
in float vSocket;
uniform int uStrand;
uint pcgHash(uint value) {
  uint state = value * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
void main() {
  // Skin below the crew neck is hidden inside the jersey: it must not cast.
  if (vClip < 0.0 || vSocket > 0.5) discard;
  if (uStrand == 1) {
    uvec2 texel = uvec2(gl_FragCoord.xy);
    uint hash = pcgHash(texel.x + pcgHash(texel.y + uint(vRandom * 65535.0)));
    if (float(hash >> 8u) / 16777216.0 >= vCoverage) discard;
  }
}`;

/*
 * Ambient-occlusion gather: one point per vertex into its own texel; the
 * cosine-weighted visibility over fixed world directions, each looked up in
 * its orthographic depth layer with hardware 2x2 PCF.
 */
const AO_VERTEX = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
uniform int uBase;
uniform ivec2 uTarget;
out vec3 vPosition;
out vec3 vNormal;
void main() {
  int index = uBase + gl_VertexID;
  vec2 texel = vec2(float(index % uTarget.x), float(index / uTarget.x)) + 0.5;
  gl_Position = vec4(texel / vec2(uTarget) * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
  vPosition = aPosition;
  vNormal = aNormal;
}`;

const AO_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2DArrayShadow;
in vec3 vPosition;
in vec3 vNormal;
uniform sampler2DArrayShadow uAoMaps;
uniform vec3 uAoDirections[${GNM_PLAYER_AMBIENT_OCCLUSION.directions}];
uniform vec4 uVolume; // center, radius
uniform vec3 uBias;   // normal offset (m), depth bias, texel (uv)
out vec4 color;
// Branchless orthonormal basis (Duff et al. 2017), mirrored by orthonormalBasis() in JS.
void basis(vec3 n, out vec3 t, out vec3 b) {
  float s = n.z >= 0.0 ? 1.0 : -1.0;
  float a = -1.0 / (s + n.z);
  float c = n.x * n.y * a;
  t = vec3(1.0 + s * n.x * n.x * a, s * c, -s * n.x);
  b = vec3(c, s + n.y * n.y * a, -n.y);
}
void main() {
  float lengthSquared = dot(vNormal, vNormal);
  vec3 normal = lengthSquared > 1e-12 ? vNormal * inversesqrt(lengthSquared) : vec3(0.0, 1.0, 0.0);
  vec3 q = vPosition + normal * uBias.x - uVolume.xyz;
  float sum = 0.0;
  float weight = 0.0;
  for (int k = 0; k < ${GNM_PLAYER_AMBIENT_OCCLUSION.directions}; ++k) {
    vec3 direction = uAoDirections[k];
    float cosine = dot(normal, direction);
    if (cosine <= 0.0) continue;
    vec3 t;
    vec3 b;
    basis(direction, t, b);
    vec2 uv = vec2(dot(q, t), dot(q, b)) / uVolume.w * 0.5 + 0.5;
    float depth = 0.5 - 0.5 * dot(q, direction) / uVolume.w;
    float visible = 1.0;
    if (uv.x > uBias.z && uv.y > uBias.z && uv.x < 1.0 - uBias.z && uv.y < 1.0 - uBias.z && depth < 1.0) visible = texture(uAoMaps, vec4(uv, float(k), depth - uBias.y));
    sum += cosine * visible;
    weight += cosine;
  }
  float visibility = weight > 0.0 ? sum / weight : 1.0;
  color = vec4(visibility, visibility, visibility, 1.0);
}`;

const BACKGROUND_VERTEX = `#version 300 es
out vec2 vScreen;
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vScreen = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

/*
 * Seamless studio paper in the kit colour family: a soft background-light
 * pool behind the head (separation), key spill from camera left and a slow
 * fall-off towards the sweep, as linear radiance. The pre-v2 striped gradient
 * remains only as a capture option for before/after comparisons.
 */
const BACKGROUND_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vScreen;
uniform vec3 uPaper;         // linear paper tint (kit colour family)
uniform vec3 uKitPrimary;    // legacy gradient only
uniform float uAspect;
uniform int uBackdrop;       // 0 studio paper, 1 legacy striped gradient (display-encoded)
uniform int uSceneEncoding;  // see the mesh shader
out vec4 color;
float hash21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.103, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + 1.0), f.x), f.y);
}
${TONE_MAPPING_GLSL}
void main() {
  if (uBackdrop == 1) {
    vec2 p = vScreen - vec2(0.5, 0.58);
    float glow = exp(-dot(p, p) * 4.2);
    vec3 dark = vec3(0.028, 0.036, 0.052);
    vec3 tone = mix(dark, uKitPrimary * 0.55 + dark, glow * 0.55);
    tone *= 1.0 - 0.35 * smoothstep(0.35, 0.9, length(vScreen - 0.5));
    float stripes = step(0.5, fract((vScreen.x + vScreen.y) * 18.0)) * 0.008;
    color = vec4(pow(tone + stripes * glow, vec3(1.0 / 2.2)), 1.0);
    return;
  }
  vec2 p = (vScreen - vec2(0.52, 0.6)) * vec2(uAspect, 1.0);
  float pool = exp(-dot(p / vec2(0.6, 0.52), p / vec2(0.6, 0.52)) * 1.4);
  float spill = 0.22 * (1.0 - smoothstep(-0.1, 1.1, vScreen.x));
  float sweep = mix(0.72, 1.0, smoothstep(0.0, 0.6, vScreen.y));
  float mottle = 1.0 + 0.014 * (noise2(vScreen * vec2(uAspect, 1.0) * 5.0) - 0.5) + 0.008 * (noise2(vScreen * vec2(uAspect, 1.0) * 17.0) - 0.5);
  vec3 radiance = uPaper * (0.36 + 1.3 * pool + spill) * sweep * mottle;
  if (uSceneEncoding == 0) { color = vec4(radiance, 1.0); return; }
  vec3 encoded = uSceneEncoding == 1 ? sqrt(radiance / (1.0 + radiance)) : toSrgb(tonemap(radiance));
  // 8-bit targets: dither half a code value so the gradient never bands.
  color = vec4(encoded + (hash21(gl_FragCoord.xy) - 0.5) / 255.0, 1.0);
}`;

/** GLSL float literal (GLSL ES has no implicit int-to-float conversion). */
function glslFloat(value) { return Number.isInteger(value) ? value.toFixed(1) : String(value); }

/* Post-processing helpers shared by the depth-of-field gather and the composite. */
const POST_COMMON_GLSL = `
uniform int uEncoding; // 0 linear HDR, 1 compressed RGBA8, 2 display passthrough
uniform vec4 uDof;     // enabled, focus distance (m), blur radius (px) at |1 - focus / distance| = 1, max radius (px)
uniform vec2 uClip;    // near, far (m)
vec3 decodeScene(vec3 stored) {
  if (uEncoding != 1) return stored;
  vec3 compressed = stored * stored;
  return compressed / max(1.0 - compressed, vec3(1e-3));
}
float linearDepth(float depth) {
  float z = depth * 2.0 - 1.0;
  return 2.0 * uClip.x * uClip.y / (uClip.y + uClip.x - z * (uClip.y - uClip.x));
}
// Signed thin-lens circle of confusion (px), negative in front of the focus.
float circleOfConfusion(float distance) {
  return clamp(uDof.z * (1.0 - uDof.y / distance), -uDof.w, uDof.w);
}`;

/*
 * Depth of field, half resolution: scatter-as-gather over a Vogel disc of
 * the maximum blur radius. A sample contributes when its own blur disc
 * reaches this pixel; samples behind the pixel may not blur over it by more
 * than twice its own blur (no background halo over in-focus edges).
 */
const DOF_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform vec2 uTexel;       // 1 / full-resolution size
uniform vec2 uOutputSize;  // half-resolution size
out vec4 color;
${POST_COMMON_GLSL}
void main() {
  vec2 uv = gl_FragCoord.xy / uOutputSize;
  float centerDistance = linearDepth(texture(uDepth, uv).r);
  float centerCoc = abs(circleOfConfusion(centerDistance));
  vec3 sum = decodeScene(texture(uColor, uv).rgb);
  float total = 1.0;
  // In-focus pixels are composited from the sharp image: skip the gather.
  if (centerCoc < 0.25) { color = vec4(uEncoding == 1 ? sqrt(sum / (1.0 + sum)) : sum, 1.0); return; }
  for (int i = 0; i < ${GNM_PLAYER_POST.depthOfField.taps}; ++i) {
    float radius = sqrt((float(i) + 0.5) / ${glslFloat(GNM_PLAYER_POST.depthOfField.taps)}) * uDof.w;
    float angle = float(i) * 2.39996323;
    vec2 sampleUv = uv + vec2(cos(angle), sin(angle)) * radius * uTexel;
    float sampleDistance = linearDepth(texture(uDepth, sampleUv).r);
    float coc = abs(circleOfConfusion(sampleDistance));
    if (sampleDistance > centerDistance) coc = min(coc, centerCoc * 2.0);
    float weight = smoothstep(radius - 1.0, radius + 0.5, coc);
    sum += decodeScene(texture(uColor, sampleUv).rgb) * weight;
    total += weight;
  }
  vec3 blurred = sum / total;
  color = vec4(uEncoding == 1 ? sqrt(blurred / (1.0 + blurred)) : blurred, 1.0);
}`;

/*
 * Final composite into the canvas: depth of field (blend by the sharpest
 * neighbouring circle of confusion), vignette, tone mapping, sRGB and
 * deterministic luminance-dependent grain. Display passthrough (debug views,
 * capture comparisons) copies the resolved image unchanged.
 */
const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform sampler2D uBlur;
uniform vec2 uVignette;       // strength, power
uniform float uGrainAmplitude; // display units at mid-tones, 0 = off
uniform uint uGrainSeed;
out vec4 color;
${POST_COMMON_GLSL}
${TONE_MAPPING_GLSL}
uint pcgHash(uint value) {
  uint state = value * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float cocAt(ivec2 pixel) {
  ivec2 size = textureSize(uDepth, 0);
  return abs(circleOfConfusion(linearDepth(texelFetch(uDepth, clamp(pixel, ivec2(0), size - 1), 0).r)));
}
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec3 stored = texelFetch(uColor, pixel, 0).rgb;
  if (uEncoding == 2) { color = vec4(stored, 1.0); return; }
  vec3 scene = decodeScene(stored);
  vec2 size = vec2(textureSize(uColor, 0));
  vec2 uv = gl_FragCoord.xy / size;
  if (uDof.x > 0.5) {
    float coc = min(cocAt(pixel), min(min(cocAt(pixel + ivec2(1, 0)), cocAt(pixel - ivec2(1, 0))), min(cocAt(pixel + ivec2(0, 1)), cocAt(pixel - ivec2(0, 1)))));
    scene = mix(scene, decodeScene(texture(uBlur, uv).rgb), smoothstep(${glslFloat(GNM_PLAYER_POST.depthOfField.sharpCoc)}, ${glslFloat(GNM_PLAYER_POST.depthOfField.fullCoc)}, coc));
  }
  float aspect = size.x / size.y;
  float radius = length((uv - 0.5) * vec2(aspect, 1.0)) / length(vec2(0.5 * aspect, 0.5));
  scene *= 1.0 - uVignette.x * pow(radius, uVignette.y);
  vec3 display = toSrgb(tonemap(scene));
  if (uGrainAmplitude > 0.0) {
    uint first = pcgHash(uint(pixel.x) + pcgHash(uint(pixel.y) + uGrainSeed));
    uint second = pcgHash(first);
    float grain = (float(first >> 8u) + float(second >> 8u)) / 16777216.0 - 1.0;
    float luminance = dot(display, vec3(0.2126, 0.7152, 0.0722));
    display += grain * uGrainAmplitude * smoothstep(0.0, 0.18, luminance) * (1.0 - 0.75 * smoothstep(0.55, 1.0, luminance));
  }
  color = vec4(clamp(display, 0.0, 1.0), 1.0);
}`;

/*
 * Ambient-occlusion smoothing: each vertex averages its baked texel with up to
 * eight mesh neighbours (static source-mesh adjacency as integer attributes),
 * removing direction-sampling blotches without any CPU readback.
 */
const AO_SMOOTH_VERTEX = `#version 300 es
layout(location=0) in ivec4 aNeighborsA;
layout(location=1) in ivec4 aNeighborsB;
uniform highp sampler2D uRawAo;
uniform int uBase;
uniform ivec2 uTarget;
flat out float vOcclusion;
float rawOcclusion(int index) { return texelFetch(uRawAo, ivec2(index % uTarget.x, index / uTarget.x), 0).r; }
void main() {
  int self = uBase + gl_VertexID;
  float sum = rawOcclusion(self);
  float weight = 1.0;
  for (int i = 0; i < 4; ++i) {
    if (aNeighborsA[i] >= 0) { sum += rawOcclusion(uBase + aNeighborsA[i]); weight += 1.0; }
    if (aNeighborsB[i] >= 0) { sum += rawOcclusion(uBase + aNeighborsB[i]); weight += 1.0; }
  }
  vOcclusion = sum / weight;
  vec2 texel = vec2(float(self % uTarget.x), float(self / uTarget.x)) + 0.5;
  gl_Position = vec4(texel / vec2(uTarget) * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;

const AO_SMOOTH_FRAGMENT = `#version 300 es
precision highp float;
flat in float vOcclusion;
out vec4 color;
void main() { color = vec4(vec3(vOcclusion), 1.0); }`;

/**
 * Up to eight 1-ring neighbours per render vertex (-1 padded), taken from the
 * source-mesh adjacency so UV-seam duplicates smooth identically. Neighbours
 * are representative render vertices of the neighbouring source vertices.
 */
export function buildGnmPlayerAoNeighbors(staticData, sourceVertexCount) {
  const representative = new Int32Array(sourceVertexCount).fill(-1);
  staticData.sourceIds.forEach((source, vertex) => { if (representative[source] < 0) representative[source] = vertex; });
  const adjacency = Array.from({ length: sourceVertexCount }, () => []);
  const triangles = staticData.sourceTriangles;
  for (let index = 0; index < triangles.length; index += 3) {
    for (let edge = 0; edge < 3; edge += 1) {
      const a = triangles[index + edge], b = triangles[index + (edge + 1) % 3];
      if (a === b) continue;
      if (!adjacency[a].includes(b)) adjacency[a].push(b);
      if (!adjacency[b].includes(a)) adjacency[b].push(a);
    }
  }
  const neighbors = new Int32Array(staticData.renderCount * 8).fill(-1);
  for (let vertex = 0; vertex < staticData.renderCount; vertex += 1) {
    adjacency[staticData.sourceIds[vertex]].slice(0, 8).forEach((source, slot) => { neighbors[vertex * 8 + slot] = representative[source]; });
  }
  return neighbors;
}

const aoNeighborCache = new WeakMap();
function cachedAoNeighbors(resources) {
  if (!aoNeighborCache.has(resources.staticData)) aoNeighborCache.set(resources.staticData, buildGnmPlayerAoNeighbors(resources.staticData, resources.model.vertexCount));
  return aoNeighborCache.get(resources.staticData);
}

/** Ring/segment neighbours of the jersey bust grid (rings x segments, closed rings). */
export function buildGnmPlayerBustAoNeighbors(vertexCount, segments) {
  const rings = vertexCount / segments;
  const neighbors = new Int32Array(vertexCount * 8).fill(-1);
  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const vertex = ring * segments + segment;
      const around = [ring * segments + ((segment + 1) % segments), ring * segments + ((segment + segments - 1) % segments)];
      const along = [ring > 0 ? vertex - segments : -1, ring < rings - 1 ? vertex + segments : -1];
      neighbors.set([...around, ...along], vertex * 8);
    }
  }
  return neighbors;
}

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
  return { view: lookAt(eye, TARGET, [0, 1, 0]), projection: perspective(GNM_PLAYER_FIELD_OF_VIEW, aspect, CLIP.near, CLIP.far), eye, camera: safe };
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

/** Bun core radius (m). */
const BUN_RADIUS = 0.03;

/** Bun frame for the strand hair: core centre, radius, axis, scalp base and AO root vertex. */
export function gnmPlayerBunFrame(staticData, positions, normals) {
  const anchor = staticData.bunAnchor;
  const normal = normalize3([normals[anchor * 3], normals[anchor * 3 + 1], normals[anchor * 3 + 2]]);
  const base = [positions[anchor * 3], positions[anchor * 3 + 1], positions[anchor * 3 + 2]];
  return { center: base.map((value, axis) => value + normal[axis] * BUN_RADIUS * 0.72), radius: BUN_RADIUS, normal, base, rootVertex: Math.max(staticData.representative[anchor], 0) };
}

/** Hair bun: a slightly flattened sphere seated on the upper back of the head. */
export function buildGnmPlayerBun(anchor, positions, normals) {
  const radius = BUN_RADIUS;
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
export function buildGnmPlayerBust(loop, positions, skinTriangles) {
  let cx = 0, cz = 0, boundaryTop = -Infinity;
  for (const vertex of loop) {
    cx += positions[vertex * 3]; cz += positions[vertex * 3 + 2];
    boundaryTop = Math.max(boundaryTop, positions[vertex * 3 + 1]);
  }
  cx /= loop.length; cz /= loop.length;
  const collarHeight = boundaryTop + 0.014;
  const collarPlane = [collarHeight, cz];
  const points = [];
  // A slightly forward-sloping plane intersects the actual reconstructed neck.
  // This is a geometric crew-neck opening, independent of the old torso cut.
  for (let i = 0; i < skinTriangles.length; i += 3) {
    for (let edge = 0; edge < 3; edge += 1) {
      const a = skinTriangles[i + edge] * 3, b = skinTriangles[i + (edge + 1) % 3] * 3;
      const da = positions[a + 1] + 0.12 * (positions[a + 2] - cz) - collarHeight;
      const db = positions[b + 1] + 0.12 * (positions[b + 2] - cz) - collarHeight;
      if ((da < 0) === (db < 0)) continue;
      const t = da / (da - db);
      const x = positions[a] + (positions[b] - positions[a]) * t;
      const z = positions[a + 2] + (positions[b + 2] - positions[a + 2]) * t;
      points.push({ angle: Math.atan2(x - cx, z - cz), radius: Math.hypot(x - cx, z - cz) });
    }
  }
  if (points.length < 6) fail("Unable to fit the crew neck to the reconstructed skin");
  points.sort((a, b) => a.angle - b.angle);
  const wrapped = [{ ...points[points.length - 1], angle: points[points.length - 1].angle - Math.PI * 2 }, ...points, { ...points[0], angle: points[0].angle + Math.PI * 2 }];
  const count = 128;
  const neckline = Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI + index / count * Math.PI * 2;
    let next = 1;
    while (wrapped[next].angle < angle) next += 1;
    const left = wrapped[next - 1], right = wrapped[next];
    const t = (angle - left.angle) / Math.max(right.angle - left.angle, 1e-9);
    const radius = left.radius + (right.radius - left.radius) * t;
    return [cx + Math.sin(angle) * radius, collarHeight - 0.12 * Math.cos(angle) * radius, cz + Math.cos(angle) * radius];
  });
  const halfWidth = 0.215;
  const halfDepth = 0.115;
  const exponent = 2 / 3.2;
  // Lateral profile: collar, a gentle trapezius slope, a rounded shoulder cap,
  // then the arm dropping almost vertically.
  const rings = [
    { blend: 0.0, drop: 0.001, offset: 0.0008, v: 0.0 },
    { blend: 0.0, drop: -0.001, offset: 0.0025, v: 0.015 },
    { blend: 0.0, drop: 0.009, offset: 0.003, v: 0.085 },
    { blend: 0.025, drop: 0.011, offset: 0.0025, v: 0.11 },
    { blend: 0.07, drop: 0.012, offset: 0.001, v: 0.14 },
    { blend: 0.3, drop: 0.003, v: 0.3 },
    { blend: 0.62, drop: 0.005, v: 0.5 },
    { blend: 0.84, drop: 0.008, v: 0.64 },
    { blend: 0.95, drop: 0.018, v: 0.74 },
    { blend: 1.0, drop: 0.065, v: 0.84 },
    { blend: 1.0, drop: 0.22, v: 1.0 },
  ];
  const vertices = new Float32Array(rings.length * count * 3);
  const uvs = new Float32Array(rings.length * count * 2);
  rings.forEach((ring, ringIndex) => {
    for (let index = 0; index < count; index += 1) {
      const [x, y, z] = neckline[index];
      const angle = Math.atan2(x - cx, z - cz);
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      const shoulderX = cx + halfWidth * Math.sign(sin) * Math.abs(sin) ** exponent;
      const shoulderZ = cz - 0.012 + halfDepth * Math.sign(cos) * Math.abs(cos) ** exponent;
      const lateral = Math.abs(sin) ** 1.6;
      const shoulderY = collarHeight - 0.026 - 0.020 * lateral;
      const t = ring.blend;
      const out = (ringIndex * count + index) * 3;
      vertices[out] = x + (shoulderX - x) * t + Math.sin(angle) * (ring.offset || 0);
      const last = ringIndex === rings.length - 1;
      vertices[out + 1] = ring.offset ? y - ring.drop : (y - 0.012) + (shoulderY - (y - 0.012)) * t - ring.drop * (last ? 1 : 0.35 + 0.65 * lateral);
      vertices[out + 2] = z + (shoulderZ - z) * t + Math.cos(angle) * (ring.offset || 0);
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
  return { vertices, normals, uvs, indices: Uint32Array.from(indices), collarPlane, collarVertexCount: count };
}

function createBuffers(gl, program, staticData, model) {
  const buffer = (target, data, usage) => {
    const handle = gl.createBuffer();
    gl.bindBuffer(target, handle);
    gl.bufferData(target, data, usage);
    return handle;
  };
  const positionBuffer = buffer(gl.ARRAY_BUFFER, staticData.positions, gl.DYNAMIC_DRAW);
  // Per-vertex surface terms: cavity, |curvature| (1/mm); baked AO is fetched from its texture.
  const surfaceBuffer = buffer(gl.ARRAY_BUFFER, new Float32Array(staticData.renderCount * 4), gl.DYNAMIC_DRAW);
  const shellSurfaceBuffer = buffer(gl.ARRAY_BUFFER, new Float32Array(staticData.renderCount * 4), gl.DYNAMIC_DRAW);
  const templateBuffer = buffer(gl.ARRAY_BUFFER, staticData.positions, gl.STATIC_DRAW);
  const normalBuffer = buffer(gl.ARRAY_BUFFER, new Float32Array(staticData.renderCount * 3), gl.DYNAMIC_DRAW);
  const shellNormalBuffer = buffer(gl.ARRAY_BUFFER, new Float32Array(staticData.renderCount * 3), gl.DYNAMIC_DRAW);
  const shellBuffer = buffer(gl.ARRAY_BUFFER, staticData.positions, gl.DYNAMIC_DRAW);
  const uvBuffer = buffer(gl.ARRAY_BUFFER, staticData.uvs, gl.STATIC_DRAW);
  // Per-vertex beard and brow root density (skin underlay), refreshed per frame.
  const facialBuffer = buffer(gl.ARRAY_BUFFER, new Float32Array(staticData.renderCount * 2), gl.DYNAMIC_DRAW);
  const fieldBuffers = staticData.attributes.map((data) => buffer(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW));
  const indexBuffer = buffer(gl.ELEMENT_ARRAY_BUFFER, staticData.indices, gl.STATIC_DRAW);
  const vao = (position, normals, surface, facial = null) => {
    const handle = gl.createVertexArray();
    gl.bindVertexArray(handle);
    gl.bindBuffer(gl.ARRAY_BUFFER, position);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, normals);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, surface);
    gl.enableVertexAttribArray(8); gl.vertexAttribPointer(8, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, templateBuffer);
    gl.enableVertexAttribArray(9); gl.vertexAttribPointer(9, 3, gl.FLOAT, false, 0, 0);
    fieldBuffers.forEach((field, index) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, field);
      gl.enableVertexAttribArray(3 + index);
      gl.vertexAttribPointer(3 + index, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    });
    if (facial) {
      gl.bindBuffer(gl.ARRAY_BUFFER, facial);
      gl.enableVertexAttribArray(11); gl.vertexAttribPointer(11, 2, gl.FLOAT, false, 0, 0);
    } else gl.disableVertexAttribArray(11);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bindVertexArray(null);
    return handle;
  };
  // Strand meshes (scalp hair, beard, brows) carry a third uv component (width boost of hanging hair).
  const extraMesh = (uvSize = 2) => {
    const mesh = { vao: gl.createVertexArray(), position: gl.createBuffer(), normal: gl.createBuffer(), uv: gl.createBuffer(), surface: gl.createBuffer(), aoIndex: gl.createBuffer(), index: gl.createBuffer(), count: 0, vertexCount: 0 };
    gl.bindVertexArray(mesh.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.position);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normal);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uv);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, uvSize, gl.FLOAT, false, 0, 0);
    for (let index = 3; index < 8; index += 1) gl.disableVertexAttribArray(index);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.surface);
    gl.enableVertexAttribArray(8); gl.vertexAttribPointer(8, 4, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(9);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.aoIndex);
    gl.enableVertexAttribArray(10); gl.vertexAttribPointer(10, 1, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(11);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.index);
    gl.bindVertexArray(null);
    return mesh;
  };
  const fieldMin = [];
  const fieldMax = [];
  for (const field of model.metadata.fields) { fieldMin.push(field.min); fieldMax.push(field.max); }
  return { positionBuffer, normalBuffer, shellNormalBuffer, surfaceBuffer, shellSurfaceBuffer, shellBuffer, facialBuffer, meshVao: vao(positionBuffer, normalBuffer, surfaceBuffer, facialBuffer), shellVao: vao(shellBuffer, shellNormalBuffer, shellSurfaceBuffer), bust: extraMesh(), frames: extraMesh(), lenses: extraMesh(), bun: extraMesh(), hairStrands: extraMesh(3), beardStrands: extraMesh(3), browStrands: extraMesh(3), lashes: extraMesh(), tearLine: extraMesh(), fieldMin: new Float32Array(fieldMin), fieldMax: new Float32Array(fieldMax) };
}

function uniformLocations(gl, program, names) {
  return Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]));
}

/**
 * Texture units: 0 key shadow (compare), 1 key shadow (raw depth), 2 skin LUT, 3 AO depth layers,
 * 4 rim shadow (compare), 5 baked AO (vertex), 6 raw AO (smoothing), 7 resolved scene colour,
 * 8 resolved scene depth, 9 depth-of-field gather (post passes only).
 */
const TEXTURE_UNIT = Object.freeze({ shadowCompare: 0, shadowDepth: 1, skinLut: 2, aoMaps: 3, rimShadow: 4, bakedAo: 5, rawAo: 6, sceneColor: 7, sceneDepth: 8, blur: 9 });

function clearGlErrors(gl) {
  for (let index = 0; index < 32 && gl.getError() !== gl.NO_ERROR; index += 1);
}

function depthFormats(gl) {
  return [["DEPTH_COMPONENT24", gl.DEPTH_COMPONENT24], ["DEPTH_COMPONENT16", gl.DEPTH_COMPONENT16]];
}

/**
 * Key-light depth map. Tries 24-bit then 16-bit depth; an incomplete
 * framebuffer degrades to "unavailable" (unshadowed key light) instead of
 * failing, with a 1x1 depth texture kept bound for the shadow samplers.
 */
function createShadowTarget(gl, size) {
  for (const [format, internalFormat] of depthFormats(gl)) {
    clearGlErrors(gl);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, size, size);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texture, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE && gl.getError() === gl.NO_ERROR;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (complete) return { status: "complete", format, size, texture, framebuffer };
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
  }
  clearGlErrors(gl);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT16, 1, 1, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, null);
  clearGlErrors(gl);
  return { status: "unavailable", reason: "no complete depth-texture framebuffer", format: null, size: 1, texture, framebuffer: null };
}

/** Directional depth layers plus the RGBA8 per-vertex gather target of the AO bake. */
function createAoTarget(gl, points) {
  const { directions, size, targetWidth } = GNM_PLAYER_AMBIENT_OCCLUSION;
  const height = Math.max(1, Math.ceil(points / targetWidth));
  for (const [format, internalFormat] of depthFormats(gl)) {
    clearGlErrors(gl);
    const depthArray = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, depthArray);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, internalFormat, size, size, directions);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    const depthFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, depthFramebuffer);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, depthArray, 0, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    const depthComplete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    const colorTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, colorTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, targetWidth, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const colorFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, colorFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTexture, 0);
    const colorComplete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    const smoothTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, smoothTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, targetWidth, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const smoothFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, smoothFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, smoothTexture, 0);
    const smoothComplete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (depthComplete && colorComplete && smoothComplete && gl.getError() === gl.NO_ERROR) {
      return { status: "complete", format, directions, size, width: targetWidth, height, capacity: targetWidth * height, depthArray, depthFramebuffer, colorTexture, colorFramebuffer, smoothTexture, smoothFramebuffer };
    }
    for (const framebuffer of [depthFramebuffer, colorFramebuffer, smoothFramebuffer]) gl.deleteFramebuffer(framebuffer);
    for (const texture of [depthArray, colorTexture, smoothTexture]) gl.deleteTexture(texture);
  }
  clearGlErrors(gl);
  return { status: "unavailable", reason: "no complete depth-array or RGBA8 framebuffer", directions, size, capacity: 0 };
}

function deleteSceneTargets(gl, targets) {
  if (targets?.status !== "complete") return;
  for (const framebuffer of [targets.sceneFramebuffer, targets.resolveFramebuffer, targets.blurFramebuffer]) gl.deleteFramebuffer(framebuffer);
  for (const renderbuffer of [targets.colorRenderbuffer, targets.depthRenderbuffer]) gl.deleteRenderbuffer(renderbuffer);
  for (const texture of [targets.colorTexture, targets.depthTexture, targets.blurTexture]) gl.deleteTexture(texture);
}

function createTargetTexture(gl, format, width, height, filter) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

/**
 * Offscreen scene targets for one drawing-buffer size: a multisampled
 * colour + depth framebuffer (up to 4 samples; work unit C's hair relies on
 * SAMPLE_ALPHA_TO_COVERAGE here), its single-sample resolve (colour and depth
 * textures) and the half-resolution depth-of-field target. Tries RGBA16F
 * (EXT_color_buffer_float) and then RGBA8 with a compressed encoding; any
 * incomplete framebuffer or GL error moves on, and "unavailable" makes the
 * renderer draw straight to the canvas.
 */
function createSceneTargets(gl, width, height) {
  const attempts = [];
  if (gl.getExtension("EXT_color_buffer_float")) attempts.push({ mode: "float16", format: gl.RGBA16F, formatName: "RGBA16F", encoding: SCENE_ENCODING.linear });
  attempts.push({ mode: "rgba8-compressed", format: gl.RGBA8, formatName: "RGBA8", encoding: SCENE_ENCODING.compressed });
  const failures = [];
  const halfWidth = Math.max(1, Math.ceil(width / 2));
  const halfHeight = Math.max(1, Math.ceil(height / 2));
  for (const attempt of attempts) {
    clearGlErrors(gl);
    const supported = Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, attempt.format, gl.SAMPLES) ?? []);
    const depthSupported = Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, gl.SAMPLES) ?? []);
    const samples = supported.filter((count) => count <= 4 && depthSupported.includes(count))[0] ?? 0;
    if (samples < 2) { failures.push(`${attempt.formatName}: no multisample support`); continue; }
    const colorRenderbuffer = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, colorRenderbuffer);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, attempt.format, width, height);
    const depthRenderbuffer = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRenderbuffer);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    const sceneFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFramebuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colorRenderbuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRenderbuffer);
    const sceneStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    const colorTexture = createTargetTexture(gl, attempt.format, width, height, gl.LINEAR);
    const depthTexture = createTargetTexture(gl, gl.DEPTH_COMPONENT24, width, height, gl.NEAREST);
    const resolveFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, resolveFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTexture, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTexture, 0);
    const resolveStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    const blurTexture = createTargetTexture(gl, attempt.format, halfWidth, halfHeight, gl.LINEAR);
    const blurFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, blurFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, blurTexture, 0);
    const blurStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const targets = { status: "complete", ...attempt, samples, width, height, halfWidth, halfHeight, colorRenderbuffer, depthRenderbuffer, sceneFramebuffer, colorTexture, depthTexture, resolveFramebuffer, blurTexture, blurFramebuffer };
    const statuses = [sceneStatus, resolveStatus, blurStatus];
    if (statuses.every((status) => status === gl.FRAMEBUFFER_COMPLETE) && gl.getError() === gl.NO_ERROR) return { ...targets, attempts: failures };
    failures.push(`${attempt.formatName}: framebuffer status ${statuses.map((status) => `0x${status.toString(16)}`).join("/")}`);
    deleteSceneTargets(gl, targets);
  }
  clearGlErrors(gl);
  return { status: "unavailable", reason: failures.join("; ") || "no offscreen format", width, height, attempts: failures };
}

function createSkinLutTexture(gl) {
  const lut = gnmPlayerSkinLut();
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, lut.size, lut.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut.data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { texture, size: lut.size, maxCurvaturePerMm: lut.maxCurvaturePerMm, encoding: lut.encoding };
}

/** Integer neighbour attributes (two ivec4 per vertex) for the AO smoothing pass. */
function createNeighborVao(gl, neighbors) {
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, neighbors, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribIPointer(0, 4, gl.INT, 32, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribIPointer(1, 4, gl.INT, 32, 16);
  gl.bindVertexArray(null);
  return { vao, buffer, count: neighbors.length / 8 };
}

/** 1x1 white texture bound when no AO bake is available (AO = 1). */
function createUnbakedAoTexture(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function createSampler(gl, filter, compare) {
  const sampler = gl.createSampler();
  gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, filter);
  gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, filter);
  gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.samplerParameteri(sampler, gl.TEXTURE_COMPARE_MODE, compare ? gl.COMPARE_REF_TO_TEXTURE : gl.NONE);
  gl.samplerParameteri(sampler, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  return sampler;
}

function createGlState(gl, resources) {
  const meshProgram = link(gl, MESH_VERTEX, MESH_FRAGMENT);
  const backgroundProgram = link(gl, BACKGROUND_VERTEX, BACKGROUND_FRAGMENT);
  const depthProgram = link(gl, DEPTH_VERTEX, DEPTH_FRAGMENT);
  const aoProgram = link(gl, AO_VERTEX, AO_FRAGMENT);
  const aoSmoothProgram = link(gl, AO_SMOOTH_VERTEX, AO_SMOOTH_FRAGMENT);
  const dofProgram = link(gl, BACKGROUND_VERTEX, DOF_FRAGMENT);
  const compositeProgram = link(gl, BACKGROUND_VERTEX, COMPOSITE_FRAGMENT);
  const buffers = createBuffers(gl, meshProgram, resources.staticData, resources.model);
  const meshUniforms = uniformLocations(gl, meshProgram, ["uProjection", "uView", "uFieldMin", "uFieldMax", "uComponent", "uSkin", "uLip", "uIris", "uHair", "uBeardRoot", "uBrowRoot", "uFacialUnderlay", "uKitPrimary", "uKitSecondary", "uHairStyle", "uHairStyle2", "uFlags", "uCollarPlane", "uAgeAnchors[0]", "uDebugField",
    "uKeyDirection", "uKeyColor", "uRimDirection", "uRimColor", "uShDiffuse[0]", "uEnvLobes[0]", "uEnvLobeColors[0]", "uEnvAmbient", "uShadowMap", "uShadowDepth", "uKeyLightMatrix", "uShadowParams", "uSkinLut", "uSkinLutCurvature", "uSkinRegions", "uSkinLightness", "uRegionAnchors[0]", "uRimShadowMap", "uRimLightMatrix", "uRimShadowParams", "uSkinMottleOffset", "uAoTexture", "uAo", "uStrandRootFactor",
    "uSceneEncoding", "uStrand", "uCameraPosition", "uViewport", "uStrandMinPixels", "uHairPart", "uHairlineSoftness", "uEyeCenters[0]", "uEyeAxes[0]", "uEyeUps[0]", "uIrisCenters[0]", "uIrisNormals[0]", "uCorneas[0]", "uLidContact[0]", "uInnerCanthi[0]", "uIrisDetail", "uIrisDetail2", "uIrisOffset", "uLashRoot", "uLashTip"]);
  const skinLut = createSkinLutTexture(gl);
  // Studio constants are view-space and profile independent: set them once.
  const studio = gnmPlayerStudioLighting();
  gl.useProgram(meshProgram);
  gl.uniform3fv(meshUniforms.uKeyDirection, studio.key.direction);
  gl.uniform3fv(meshUniforms.uKeyColor, studio.key.color);
  gl.uniform3fv(meshUniforms.uRimDirection, studio.rim.direction);
  gl.uniform3fv(meshUniforms.uRimColor, studio.rim.color);
  gl.uniform3fv(meshUniforms["uShDiffuse[0]"], studio.shDiffuse);
  gl.uniform4fv(meshUniforms["uEnvLobes[0]"], studio.lobeAxes);
  gl.uniform3fv(meshUniforms["uEnvLobeColors[0]"], studio.lobeColors);
  gl.uniform3fv(meshUniforms.uEnvAmbient, studio.ambient);
  gl.uniform1i(meshUniforms.uShadowMap, TEXTURE_UNIT.shadowCompare);
  gl.uniform1i(meshUniforms.uShadowDepth, TEXTURE_UNIT.shadowDepth);
  gl.uniform1i(meshUniforms.uSkinLut, TEXTURE_UNIT.skinLut);
  gl.uniform1i(meshUniforms.uRimShadowMap, TEXTURE_UNIT.rimShadow);
  gl.uniform1i(meshUniforms.uAoTexture, TEXTURE_UNIT.bakedAo);
  gl.uniform1f(meshUniforms.uStrandRootFactor, GNM_PLAYER_AMBIENT_OCCLUSION.strandRootFactor);
  gl.uniform1f(meshUniforms.uHairlineSoftness, 1);
  gl.uniform1f(meshUniforms.uSkinLutCurvature, skinLut.maxCurvaturePerMm);
  gl.uniform3fv(meshUniforms["uRegionAnchors[0]"], resources.staticData.regionAnchors);
  gl.uniform1i(meshUniforms.uStrand, 0);
  gl.uniform1f(meshUniforms.uStrandMinPixels, STRAND_MIN_PIXELS);
  // Scalp hair programs (multisampled: alpha-to-coverage; direct fallback: dithered).
  const hairNames = ["uProjection", "uView", "uCameraPosition", "uViewport", "uStrandMinPixels", "uStrandWidthScale", "uAoTexture", "uAoBaked", "uSceneEncoding",
    "uKeyDirection", "uKeyWorld", "uKeyColor", "uRimDirection", "uRimColor", "uShDiffuse[0]", "uShadowDepth", "uKeyLightMatrix", "uShadowParams", "uRimShadowMap", "uRimLightMatrix", "uRimShadowParams",
    "uHairPigment", "uHairGrey", "uHairFibre", "uHairCenter", "uStrandOpacity", "uDebugField"];
  const hairPrograms = [false, true].map((dithered) => {
    const program = link(gl, HAIR_VERTEX, hairFragmentSource(dithered));
    const uniforms = uniformLocations(gl, program, hairNames);
    gl.useProgram(program);
    gl.uniform1i(uniforms.uAoTexture, TEXTURE_UNIT.bakedAo);
    gl.uniform1i(uniforms.uShadowDepth, TEXTURE_UNIT.shadowDepth);
    gl.uniform1i(uniforms.uRimShadowMap, TEXTURE_UNIT.rimShadow);
    gl.uniform3fv(uniforms.uKeyDirection, studio.key.direction);
    gl.uniform3fv(uniforms.uKeyColor, studio.key.color);
    gl.uniform3fv(uniforms.uRimDirection, studio.rim.direction);
    gl.uniform3fv(uniforms.uRimColor, studio.rim.color);
    gl.uniform3fv(uniforms["uShDiffuse[0]"], studio.shDiffuse);
    gl.uniform3fv(uniforms.uHairCenter, GNM_PLAYER_HAIR.center);
    return { program, uniforms };
  });
  const depthUniforms = uniformLocations(gl, depthProgram, ["uLightMatrix", "uClip", "uStrand", "uLightDirection", "uMinHalfWidth", "uSkipSocket", "uStrandWidthScale", "uCoverageScale"]);
  gl.useProgram(depthProgram);
  gl.uniform1f(depthUniforms.uStrandWidthScale, 1);
  gl.uniform1f(depthUniforms.uCoverageScale, 1);
  const aoUniforms = uniformLocations(gl, aoProgram, ["uBase", "uTarget", "uAoMaps", "uAoDirections[0]", "uVolume", "uBias"]);
  gl.useProgram(aoProgram);
  gl.uniform1i(aoUniforms.uAoMaps, TEXTURE_UNIT.aoMaps);
  gl.uniform3fv(aoUniforms["uAoDirections[0]"], Float32Array.from(gnmPlayerAoDirections().flat()));
  gl.uniform4f(aoUniforms.uVolume, ...GNM_PLAYER_LIGHT_VOLUME.center, GNM_PLAYER_LIGHT_VOLUME.radius);
  const aoSmoothUniforms = uniformLocations(gl, aoSmoothProgram, ["uRawAo", "uBase", "uTarget"]);
  gl.useProgram(aoSmoothProgram);
  gl.uniform1i(aoSmoothUniforms.uRawAo, TEXTURE_UNIT.rawAo);
  const postNames = ["uColor", "uDepth", "uEncoding", "uDof", "uClip"];
  const dofUniforms = uniformLocations(gl, dofProgram, [...postNames, "uTexel", "uOutputSize"]);
  const compositeUniforms = uniformLocations(gl, compositeProgram, [...postNames, "uBlur", "uVignette", "uGrainAmplitude", "uGrainSeed"]);
  for (const [program, uniforms] of [[dofProgram, dofUniforms], [compositeProgram, compositeUniforms]]) {
    gl.useProgram(program);
    gl.uniform1i(uniforms.uColor, TEXTURE_UNIT.sceneColor);
    gl.uniform1i(uniforms.uDepth, TEXTURE_UNIT.sceneDepth);
    gl.uniform2f(uniforms.uClip, CLIP.near, CLIP.far);
  }
  gl.uniform1i(compositeUniforms.uBlur, TEXTURE_UNIT.blur);
  gl.useProgram(null);
  return {
    gl,
    meshProgram,
    backgroundProgram,
    depthProgram,
    hairPrograms,
    aoProgram,
    dofProgram,
    compositeProgram,
    backgroundVao: gl.createVertexArray(),
    buffers,
    meshUniforms,
    backgroundUniforms: uniformLocations(gl, backgroundProgram, ["uPaper", "uKitPrimary", "uAspect", "uBackdrop", "uSceneEncoding"]),
    depthUniforms,
    dofUniforms,
    compositeUniforms,
    sceneTargets: null,
    aoUniforms,
    aoSmoothProgram,
    aoSmoothUniforms,
    aoNeighbors: { render: createNeighborVao(gl, cachedAoNeighbors(resources)), bust: null },
    skinLut,
    shadowSamplers: { compare: createSampler(gl, gl.LINEAR, true), depth: createSampler(gl, gl.NEAREST, false) },
    shadows: { key: null, rim: null },
    ao: null,
    aoBases: {},
    unbakedAo: createUnbakedAoTexture(gl),
  };
}

const HAIR_PATTERNS = Object.freeze({ plain: 0, curly: 1, braids: 2, bun: 3, "side-part": 4 });

/** Local geometric cavity, not baked shadows: planar/convex surfaces remain clear.
 * A bounded normal-projected edge average is scale/translation invariant.
 * It follows each reconstructed identity/expression without changing geometry.
 */
export function computeGnmPlayerCavity(positions, normals, triangles) {
  return computeGnmPlayerSurfaceTerms(positions, normals, triangles).cavity;
}

/** CPU work for one player: identity, expression, positions, normals, hair shell, bust. */
export function computeGnmPlayerFrame(resources, profile, options = {}) {
  const { model, staticData } = resources;
  const identity = sampleGnmPlayerIdentity(profile, model);
  const expression = gnmPlayerExpression(profile, options.expressionMode);
  const appearance = gnmPlayerAppearance(profile, options);
  // Capture-only control: isolate skin aging from pigment/recession changes.
  // It is never persisted in FaceDNA/SF2 or enabled by the application UI.
  if (Number.isFinite(options.diagnosticGroomingAge)) {
    const fixed = gnmPlayerAppearance({ ...profile, age: clamp(options.diagnosticGroomingAge, 16, 60) }, options);
    for (const key of ["hair", "hairPigment", "hairGreyColor", "hairGrey", "beard", "beardPigment", "beardGrey", "brow", "browPigment", "browGrey", "hairStyle"]) appearance[key] = fixed[key];
  }
  const positions = reconstructGnmPlayerPositions(model, staticData.template, identity, expression.weights);
  identity.realizedZ = gnmPlayerFeatureZ(model, measureGnmPlayerFeatures(model, reconstructGnmPlayerPositions(model, staticData.template, identity)));
  const normals = computeGnmPlayerNormals(positions, staticData.sourceTriangles, model.vertexCount);
  const renderPositions = new Float32Array(staticData.renderCount * 3);
  const renderNormals = new Float32Array(staticData.renderCount * 3);
  // One edge pass: crease cavity plus mean curvature for pre-integrated SSS.
  const { cavity, curvature } = computeGnmPlayerSurfaceTerms(positions, normals, staticData.sourceTriangles);
  const renderCavity = new Float32Array(staticData.renderCount);
  const renderCurvature = new Float32Array(staticData.renderCount);
  for (let vertex = 0; vertex < staticData.renderCount; vertex += 1) {
    const source = staticData.sourceIds[vertex] * 3;
    renderCavity[vertex] = cavity[staticData.sourceIds[vertex]];
    // |mean curvature| in 1/mm, bounded by the LUT range.
    renderCurvature[vertex] = Math.min(Math.abs(curvature[staticData.sourceIds[vertex]]) / 1000, GNM_PLAYER_SKIN_LUT.maxCurvaturePerMm);
    for (let axis = 0; axis < 3; axis += 1) {
      renderPositions[vertex * 3 + axis] = positions[source + axis];
      renderNormals[vertex * 3 + axis] = normals[source + axis];
    }
  }
  const shell = gnmPlayerHairShell(appearance.hairStyle, staticData, renderPositions, renderNormals);
  // Weld normals by official source vertex, otherwise GLB UV duplicates leave
  // artificial highlight seams across the clumped hair envelope.
  const shellSources = new Float64Array(positions);
  for (let vertex = 0; vertex < staticData.renderCount; vertex += 1) {
    shellSources.set(shell.positions.subarray(vertex * 3, vertex * 3 + 3), staticData.sourceIds[vertex] * 3);
  }
  const sourceShellNormals = computeGnmPlayerNormals(shellSources, staticData.skinTriangles, model.vertexCount);
  shell.normals = new Float32Array(staticData.renderCount * 3);
  for (let vertex = 0; vertex < staticData.renderCount; vertex += 1) {
    const source = staticData.sourceIds[vertex] * 3;
    shell.normals.set(sourceShellNormals.subarray(source, source + 3), vertex * 3);
  }
  const bust = buildGnmPlayerBust(staticData.neckLoop, positions, staticData.skinTriangles);
  // Beard and eyebrow strands: deterministic per profile, rebuilt only with
  // the frame (never on orbit); thumbnails build only the reduced tier.
  const groomDetail = options.hairDetail === "reduced" ? "reduced" : "full";
  const groom = buildGnmPlayerGroom(staticData, renderPositions, renderNormals, appearance, { seed: profile.seed, lod: groomDetail, collarPlane: bust.collarPlane });
  // Skin under the beard and brows: per-vertex root density (tint, stubble darkening).
  const facialUnderlay = gnmPlayerFacialHairUnderlay(staticData.facialHair, appearance.beardStyle, appearance.browStyle);
  const landmarks = gnmPlayerLandmarks(model, positions);
  const glasses = appearance.glasses ? buildGnmPlayerGlasses(landmarks, positions, model.fixedVertices) : null;
  const bun = appearance.hairStyle?.pattern === "bun" ? buildGnmPlayerBun(staticData.bunAnchor, positions, normals) : null;
  // Strand hair: deterministic per profile, rebuilt only with the frame (never on orbit).
  groom.hair = appearance.hairStyle ? buildGnmPlayerHair(staticData.hairScalp, renderPositions, renderNormals, appearance.hairStyle, profile.seed, {
    lod: options.hairDetail === "reduced" ? "reduced" : "full",
    browTop: Math.max(...[17, 18, 19, 20, 21, 22, 23, 24, 25, 26].map((index) => landmarks[index * 3 + 1])),
    bust,
    bun: bun ? gnmPlayerBunFrame(staticData, positions, normals) : null,
  }) : emptyGnmPlayerHair();
  // `measured` includes the micro-expression (it is the rendered mesh);
  // identity-only z-scores come from the exact linear model.
  const measured = measureGnmPlayerFeatures(model, positions);
  // Regional skin variation: seed, tone, age and presentation only.
  const skinRegions = gnmPlayerSkinRegions(profile);
  const eyes = computeGnmPlayerEyes(staticData, positions, normals, profile);
  return { identity, expression, appearance, renderPositions, renderNormals, renderCavity, renderCurvature, skinRegions, landmarks, shell, groom, facialUnderlay, bust, glasses, bun, eyes, measured, identityFeatureZ: identity.realizedZ, renderedFeatureZ: gnmPlayerFeatureZ(model, measured) };
}

/**
 * Per-frame eye geometry and shader inputs: lashes and tear line follow the
 * reconstructed lids (identity, eye edits, expression); iris detail and lash
 * pigment follow the seed and the hair pigment only.
 */
export function computeGnmPlayerEyes(staticData, positions, normals, profile) {
  const topology = staticData.eyeTopology;
  const rig = computeGnmPlayerEyeRig(topology, positions, normals);
  const lashes = buildGnmPlayerLashes(topology, rig, profile.seed);
  const tearLine = buildGnmPlayerTearLine(topology, rig);
  const pack = (count, value) => Float32Array.from(rig.eyes.flatMap((eye) => { const entry = value(eye); return entry.length === count ? entry : fail("GNM player eye uniform size mismatch"); }));
  const uniforms = {
    centers: pack(4, (eye) => [...eye.center, eye.radius]),
    axes: pack(4, (eye) => [...eye.axis, 0]),
    irisCenters: pack(3, (eye) => eye.iris.center),
    irisNormals: pack(4, (eye) => [...eye.iris.normal, eye.iris.radius]),
    ups: pack(3, (eye) => eye.up),
    corneas: pack(4, (eye) => [...eye.cornea.center, eye.cornea.radius]),
    contact: pack(GNM_PLAYER_EYES.contactSamples, (eye) => Array.from(eye.contactTable)),
    innerCanthi: pack(3, (eye) => eye.innerCanthus),
  };
  return { rig, lashes, tearLine, iris: gnmPlayerIrisDetail(profile), lashPigment: gnmPlayerLashPigment(profile), uniforms, apexes: rig.eyes.map((eye) => eye.cornea.apex) };
}

/**
 * Pack cavity, curvature and the static eye masks (lash line, wet margin)
 * into vec4 surface attributes (AO comes from the baked texture).
 */
function packSurface(vertexCount, cavity = null, curvature = null, eyeMasks = null) {
  const surface = new Float32Array(vertexCount * 4);
  if (!cavity) return surface;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    surface[vertex * 4] = cavity[vertex];
    surface[vertex * 4 + 1] = curvature[vertex];
    if (eyeMasks) {
      surface[vertex * 4 + 2] = eyeMasks[vertex * 2];
      surface[vertex * 4 + 3] = eyeMasks[vertex * 2 + 1];
    }
  }
  return surface;
}

/** AO texel per vertex of a mesh whose vertices each belong to a root source vertex (skin AO block). */
function rootAoIndices(staticData, roots, verticesPerRoot) {
  const indices = new Float32Array(roots.length * verticesPerRoot);
  roots.forEach((source, root) => indices.fill(Math.max(staticData.representative[source], 0), root * verticesPerRoot, (root + 1) * verticesPerRoot));
  return indices;
}

/** AO texel of every strand vertex: its root vertex in the block at `base` (hair envelope for scalp hair, skin for beard and brows). */
export function gnmPlayerHairAoIndices(mesh, base) {
  const indices = new Float32Array(mesh.rootVertices.length);
  for (let vertex = 0; vertex < indices.length; vertex += 1) indices[vertex] = base + mesh.rootVertices[vertex];
  return indices;
}

function uploadFrame(state, frame) {
  const { gl, buffers } = state;
  const count = state.resources.staticData.renderCount;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.positionBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, frame.renderPositions);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.surfaceBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, packSurface(count, frame.renderCavity, frame.renderCurvature, state.resources.staticData.eyeMasks));
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.normalBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, frame.renderNormals);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.shellBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, frame.shell.positions);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.shellNormalBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, frame.shell.normals);
  const uploadMesh = (target, mesh, aoIndices = null) => {
    gl.bindVertexArray(target.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, target.position);
    gl.bufferData(gl.ARRAY_BUFFER, mesh?.vertices ?? new Float32Array(0), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, target.normal);
    gl.bufferData(gl.ARRAY_BUFFER, mesh?.normals ?? new Float32Array(0), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, target.uv);
    gl.bufferData(gl.ARRAY_BUFFER, mesh?.uvs ?? new Float32Array(0), gl.DYNAMIC_DRAW);
    target.vertexCount = mesh ? mesh.vertices.length / 3 : 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, target.surface);
    // Strand meshes carry (half-width, random, 0, 0) surface attributes.
    gl.bufferData(gl.ARRAY_BUFFER, mesh?.surface ?? packSurface(target.vertexCount), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, target.aoIndex);
    gl.bufferData(gl.ARRAY_BUFFER, aoIndices ?? new Float32Array(target.vertexCount), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, target.index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh?.indices ?? new Uint32Array(0), gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    target.count = mesh?.indices.length ?? 0;
    target.tiers = mesh?.tiers ?? null;
  };
  uploadMesh(buffers.bust, frame.bust);
  uploadMesh(buffers.frames, frame.glasses?.frames);
  uploadMesh(buffers.lenses, frame.glasses?.lenses);
  uploadMesh(buffers.bun, frame.bun);
  // Hair strands take the AO of their root on the hair envelope (texels after the skin block).
  uploadMesh(buffers.hairStrands, frame.groom.hair, gnmPlayerHairAoIndices(frame.groom.hair, count));
  // Beard and brow strands take the AO of their root skin vertex.
  uploadMesh(buffers.beardStrands, frame.groom.beard, gnmPlayerHairAoIndices(frame.groom.beard, 0));
  uploadMesh(buffers.browStrands, frame.groom.brow, gnmPlayerHairAoIndices(frame.groom.brow, 0));
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers.facialBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, frame.facialUnderlay);
  // Eyelashes and tear meniscus take the AO of their lid-margin source vertex.
  const { staticData } = state.resources;
  const { lashes, tearLine } = frame.eyes;
  uploadMesh(buffers.lashes, lashes, rootAoIndices(staticData, lashes.roots, lashes.pointsPerStrand * 2));
  uploadMesh(buffers.tearLine, tearLine, rootAoIndices(staticData, tearLine.roots, 1));
}

function resizeCanvas(canvas, gl) {
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  // Even sizes keep 2x2 pixel quads aligned in every backend (shadow quad averaging).
  const even = (value) => Math.max(2, 2 * Math.round(value / 2));
  const width = even((canvas.clientWidth || canvas.width) * (canvas.clientWidth ? ratio : 1));
  const height = even((canvas.clientHeight || canvas.height) * (canvas.clientHeight ? ratio : 1));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  gl.viewport(0, 0, width, height);
  return width / height;
}

function drawRange(gl, range) {
  if (range.count > 0) gl.drawElements(gl.TRIANGLES, range.count, gl.UNSIGNED_INT, range.start * 4);
}

/**
 * Opaque casters for a depth pass: skin (clipped at the crew neck), hair
 * envelope (`shell`), jersey, bun and glasses frames, plus optionally the
 * eyeballs, the mouth interior, the eyelash strands (`lashes`: the world
 * direction towards the light and the minimum half-width), the scalp hair
 * strands (`hair`: the same plus the level of detail's width scale and
 * index count) and the beard and brow strands (`facial`: the direction, the
 * minimum half-width and per-part index count, width scale and coverage).
 * Glass (corneas, lenses, tear meniscus) never casts.
 */
function drawCasters(state, { mouth = false, eyes = false, lashes = null, hair = null, facial = null, shell = true }) {
  const { gl, buffers, depthUniforms: d, frame, resources } = state;
  if (lashes && buffers.lashes.count > 0) {
    gl.bindVertexArray(buffers.lashes.vao);
    gl.uniform3f(d.uClip, 0, 0, 0);
    gl.uniform1i(d.uStrand, 1);
    gl.uniform3fv(d.uLightDirection, lashes.direction);
    gl.uniform1f(d.uMinHalfWidth, lashes.minHalfWidth);
    gl.drawElements(gl.TRIANGLES, buffers.lashes.count, gl.UNSIGNED_INT, 0);
    gl.uniform1i(d.uStrand, 0);
  }
  // Scalp hair casts stochastic partial coverage (soft, broken shadows).
  if (hair && buffers.hairStrands.count > 0 && hair.indexCount > 0) {
    gl.bindVertexArray(buffers.hairStrands.vao);
    gl.uniform3f(d.uClip, 0, 0, 0);
    gl.uniform1i(d.uStrand, 1);
    gl.uniform3fv(d.uLightDirection, hair.direction);
    gl.uniform1f(d.uMinHalfWidth, hair.minHalfWidth);
    gl.uniform1f(d.uStrandWidthScale, hair.widthScale * HAIR_SHADOW.widthScale);
    gl.uniform1f(d.uCoverageScale, HAIR_SHADOW.coverage);
    gl.drawElements(gl.TRIANGLES, hair.indexCount, gl.UNSIGNED_INT, 0);
    gl.uniform1f(d.uStrandWidthScale, 1);
    gl.uniform1f(d.uCoverageScale, 1);
    gl.uniform1i(d.uStrand, 0);
  }
  // Beard and brow strands: the same stochastic partial coverage.
  if (facial) {
    gl.uniform3f(d.uClip, 0, 0, 0);
    gl.uniform1i(d.uStrand, 1);
    gl.uniform3fv(d.uLightDirection, facial.direction);
    gl.uniform1f(d.uMinHalfWidth, facial.minHalfWidth);
    for (const { part, indexCount, widthScale, coverage } of facial.draws) {
      const mesh = buffers[STRAND_MESHES[part]];
      if (mesh.count <= 0 || indexCount <= 0) continue;
      gl.bindVertexArray(mesh.vao);
      gl.uniform1f(d.uStrandWidthScale, widthScale);
      gl.uniform1f(d.uCoverageScale, coverage);
      gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0);
    }
    gl.uniform1f(d.uStrandWidthScale, 1);
    gl.uniform1f(d.uCoverageScale, 1);
    gl.uniform1i(d.uStrand, 0);
  }
  const { ranges } = resources.staticData;
  gl.bindVertexArray(buffers.meshVao);
  gl.uniform3f(d.uClip, frame.bust.collarPlane[0], frame.bust.collarPlane[1], 1);
  drawRange(gl, ranges.skin);
  gl.uniform3f(d.uClip, 0, 0, 0);
  if (eyes) drawRange(gl, ranges.eye);
  if (mouth) {
    drawRange(gl, ranges.teeth);
    drawRange(gl, ranges.tongue);
  }
  // The hair envelope is an occluder for the AO bake and the rim map only;
  // in the key map the strands themselves cast.
  if (shell && frame.appearance.hairStyle) {
    gl.bindVertexArray(buffers.shellVao);
    drawRange(gl, ranges.hair);
  }
  for (const mesh of [buffers.bust, buffers.bun, buffers.frames]) {
    if (mesh.count <= 0) continue;
    gl.bindVertexArray(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
  }
  gl.bindVertexArray(null);
}

/** Shadow maps sized by the canvas: thumbnails use smaller maps; the rim map is half the key map. */
function ensureShadowTarget(state, canvas, light) {
  const keySize = Math.max(canvas.width, canvas.height) <= 320 ? GNM_PLAYER_SHADOW.smallCanvasSize : GNM_PLAYER_SHADOW.size;
  const size = light === "rim" ? keySize / 2 : keySize;
  const current = state.shadows[light];
  if (!current || (current.status === "complete" && current.size !== size)) {
    if (current) {
      state.gl.deleteFramebuffer(current.framebuffer);
      state.gl.deleteTexture(current.texture);
    }
    state.shadows[light] = createShadowTarget(state.gl, size);
  }
  return state.shadows[light];
}

/**
 * Depth map of one camera-mounted light for the current camera. GPU only, per
 * redraw. Strands (scalp `hair`, beard and brows `facial`, eyelashes
 * `lashes`) cast stochastic partial coverage into the key map only (fine
 * hair shadows); the soft rim light ignores them and sees the hair envelope.
 * Eyeballs and the mouth interior sit behind the lids/lips and are left out
 * of both maps.
 */
function renderShadowMap(state, shadow, matrix, { lashes = null, hair = null, facial = null } = {}) {
  const { gl } = state;
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadow.framebuffer);
  gl.viewport(0, 0, shadow.size, shadow.size);
  gl.disable(gl.BLEND);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LESS);
  gl.depthMask(true);
  gl.clear(gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.POLYGON_OFFSET_FILL);
  gl.polygonOffset(1.1, 2.0);
  gl.useProgram(state.depthProgram);
  gl.uniformMatrix4fv(state.depthUniforms.uLightMatrix, false, matrix);
  gl.uniform1i(state.depthUniforms.uSkipSocket, 1);
  drawCasters(state, { lashes, hair, facial, shell: !hair });
  gl.uniform1i(state.depthUniforms.uSkipSocket, 0);
  gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/**
 * Where this frame's scene renders. The photographic path renders linear
 * (float) or compressed (RGBA8) radiance into the offscreen MSAA target for
 * the final composite; debug views and the capture-only `postEffects: false`
 * comparison render tone-mapped display colours there and pass them through;
 * without a complete offscreen target the scene goes straight to the canvas.
 */
function preparePostTargets(state, canvas) {
  const current = state.sceneTargets;
  if (!current || current.width !== canvas.width || current.height !== canvas.height) {
    deleteSceneTargets(state.gl, current);
    state.sceneTargets = createSceneTargets(state.gl, canvas.width, canvas.height);
  }
  const targets = state.sceneTargets;
  const photographic = state.postEffects !== false && !(state.debugField >= 0);
  if (targets.status !== "complete") return { targets, mode: "direct", encoding: SCENE_ENCODING.display, photographic: false };
  return { targets, mode: photographic ? targets.mode : "display-passthrough", encoding: photographic ? targets.encoding : SCENE_ENCODING.display, photographic };
}

/**
 * Strand draw settings (scalp hair, beard or brows) for this canvas and
 * pipeline: the full tier in the multisampled main view; the reduced tier
 * (wider strands) on thumbnails, on frames built reduced and on the direct
 * fallback, which also dithers coverage and keeps strands at least one
 * pixel wide.
 */
const STRAND_MESHES = Object.freeze({ hair: "hairStrands", beard: "beardStrands", brow: "browStrands" });
function strandDrawSettings(state, canvas, post, part) {
  const target = state.buffers[STRAND_MESHES[part]];
  const tiers = target.tiers;
  const direct = post.mode === "direct";
  const builtReduced = state.frame.groom[part].lod === "reduced";
  const reduced = builtReduced || direct || Math.max(canvas.width, canvas.height) <= HAIR_REDUCED_CANVAS;
  const indexCount = !tiers || target.count <= 0 ? 0 : reduced ? tiers.reducedIndexCount : tiers.fullIndexCount;
  return {
    lod: indexCount === 0 ? "none" : reduced ? "reduced" : "full",
    indexCount,
    strands: indexCount === 0 ? 0 : reduced ? tiers.reduced : tiers.full,
    widthScale: reduced ? HAIR_REDUCED_WIDTH_SCALE : 1,
    minPixels: direct ? HAIR_MIN_PIXELS.direct : part === "hair" ? HAIR_MIN_PIXELS.multisampled : FACIAL_HAIR_MIN_PIXELS[part],
    dither: direct,
  };
}

/**
 * Fibre shading inputs from the appearance: the un-greyed pigment and the
 * grey strand colour (linear; their age-weighted mean is today's hair
 * colour), sun-lightened tips for lighter pigments and the longitudinal
 * roughness (curly and textured styles are more matte).
 */
export function gnmPlayerHairFibre(appearance) {
  const linear = (rgb) => srgbToLinear(rgb);
  const pigment = linear(appearance.hairPigment ?? appearance.hair);
  const luminance = 0.2126 * pigment[0] + 0.7152 * pigment[1] + 0.0722 * pigment[2];
  const t = clamp((luminance - 0.02) / 0.23, 0, 1);
  return {
    pigment,
    grey: linear(appearance.hairGreyColor ?? appearance.hair),
    greyFraction: appearance.hairGrey ?? 0,
    tipLightening: 0.45 * t * t * (3 - 2 * t),
    roughness: 0.12 + 0.1 * (appearance.hairStyle?.texture ?? 0.3),
  };
}

/**
 * Beard or brow fibre shading inputs: the un-greyed pigment and grey strand
 * colour (their age-weighted mean is the appearance's beard/brow colour),
 * the grey fraction, fainter sun-lightened tips than the scalp and the
 * groom's roughness and tip fade.
 */
export function gnmPlayerFacialHairFibre(appearance, mesh, part) {
  const beard = part === "beard";
  const pigment = srgbToLinear(beard ? appearance.beardPigment ?? appearance.beard : appearance.browPigment ?? appearance.brow);
  const luminance = 0.2126 * pigment[0] + 0.7152 * pigment[1] + 0.0722 * pigment[2];
  const t = clamp((luminance - 0.02) / 0.23, 0, 1);
  return {
    pigment,
    grey: srgbToLinear(appearance.hairGreyColor ?? (beard ? appearance.beard : appearance.brow)),
    greyFraction: (beard ? appearance.beardGrey : appearance.browGrey) ?? 0,
    tipLightening: (beard ? 0.25 : 0.12) * t * t * (3 - 2 * t),
    roughness: mesh?.roughness ?? 0.2,
    tipFade: mesh?.tipFade ?? 0.8,
  };
}

function drawFrame(canvas, state) {
  const { gl, buffers, meshUniforms: u, frame, resources } = state;
  const { ranges } = resources.staticData;
  const aspect = resizeCanvas(canvas, gl);
  const camera = buildGnmPlayerCamera(state.camera, aspect);
  const appearance = frame.appearance;
  const linear = (rgb) => srgbToLinear(rgb);
  const studio = gnmPlayerStudioLighting();
  const keyWorld = viewDirectionToWorld(camera.view, studio.key.direction);
  const keyMatrix = buildGnmPlayerLightMatrix(keyWorld);
  const rimMatrix = buildGnmPlayerLightMatrix(viewDirectionToWorld(camera.view, studio.rim.direction));
  const shadow = ensureShadowTarget(state, canvas, "key");
  const rimShadow = ensureShadowTarget(state, canvas, "rim");
  // Lashes thinner than ~1/8 pixel (small thumbnails) would resolve to no
  // MSAA sample at all: skip them there, the skin lash line remains.
  state.lashesDrawn = buffers.lashes.count > 0 && eyePixelSize(camera, frame, canvas.height) < STRAND_MAX_PIXEL_SIZE;
  const lashCasters = state.lashesDrawn ? { direction: keyWorld, minHalfWidth: (STRAND_SHADOW_TEXELS * GNM_PLAYER_LIGHT_VOLUME.radius * 2) / shadow.size } : null;
  const post = preparePostTargets(state, canvas);
  // Strand levels of detail: thumbnails and the direct fallback draw the
  // reduced tiers (uniform subsets of fewer, wider strands).
  state.hairDraw = strandDrawSettings(state, canvas, post, "hair");
  state.facialDraw = { beard: strandDrawSettings(state, canvas, post, "beard"), brow: strandDrawSettings(state, canvas, post, "brow") };
  const strandShadowWidth = (STRAND_SHADOW_TEXELS * GNM_PLAYER_LIGHT_VOLUME.radius * 2) / shadow.size;
  const hairCasters = state.hairDraw.indexCount > 0 ? { direction: keyWorld, minHalfWidth: strandShadowWidth, widthScale: state.hairDraw.widthScale, indexCount: state.hairDraw.indexCount } : null;
  const facialCasters = {
    direction: keyWorld,
    minHalfWidth: strandShadowWidth,
    draws: ["beard", "brow"].map((part) => ({ part, indexCount: state.facialDraw[part].indexCount, widthScale: state.facialDraw[part].widthScale * FACIAL_HAIR_SHADOW.widthScale, coverage: FACIAL_HAIR_SHADOW.coverage })),
  };
  if (shadow.status === "complete") renderShadowMap(state, shadow, keyMatrix, { lashes: lashCasters, hair: hairCasters, facial: facialCasters });
  if (rimShadow.status === "complete") renderShadowMap(state, rimShadow, rimMatrix);
  gl.bindFramebuffer(gl.FRAMEBUFFER, post.mode === "direct" ? null : post.targets.sceneFramebuffer);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.depthMask(true);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(state.backgroundProgram);
  const backdrop = state.backgroundUniforms;
  gl.uniform3fv(backdrop.uPaper, gnmPlayerBackdropPaper(appearance.kit.primary));
  gl.uniform3fv(backdrop.uKitPrimary, linear(appearance.kit.primary));
  gl.uniform1f(backdrop.uAspect, aspect);
  gl.uniform1i(backdrop.uBackdrop, state.postEffects === false ? 1 : 0);
  gl.uniform1i(backdrop.uSceneEncoding, post.encoding);
  gl.bindVertexArray(state.backgroundVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.CULL_FACE);
  gl.useProgram(state.meshProgram);
  gl.uniformMatrix4fv(u.uProjection, false, camera.projection);
  gl.uniformMatrix4fv(u.uView, false, camera.view);
  gl.uniform1i(u.uSceneEncoding, post.encoding);
  gl.uniform3fv(u.uCameraPosition, camera.eye);
  gl.uniform2f(u.uViewport, canvas.width, canvas.height);
  gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT.shadowCompare);
  gl.bindTexture(gl.TEXTURE_2D, shadow.texture);
  gl.bindSampler(TEXTURE_UNIT.shadowCompare, state.shadowSamplers.compare);
  gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT.shadowDepth);
  gl.bindTexture(gl.TEXTURE_2D, shadow.texture);
  gl.bindSampler(TEXTURE_UNIT.shadowDepth, state.shadowSamplers.depth);
  gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT.skinLut);
  gl.bindTexture(gl.TEXTURE_2D, state.skinLut.texture);
  gl.bindSampler(TEXTURE_UNIT.skinLut, null);
  gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT.rimShadow);
  gl.bindTexture(gl.TEXTURE_2D, rimShadow.texture);
  gl.bindSampler(TEXTURE_UNIT.rimShadow, state.shadowSamplers.compare);
  const baked = frame.ambientOcclusion?.status === "complete";
  gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT.bakedAo);
  gl.bindTexture(gl.TEXTURE_2D, baked ? state.ao.smoothTexture : state.unbakedAo);
  gl.bindSampler(TEXTURE_UNIT.bakedAo, null);
  gl.activeTexture(gl.TEXTURE0);
  // Baked AO texel base per draw (see bakeAmbientOcclusion); -1 groom roots, -2 none.
  const aoBase = (base) => gl.uniform2i(u.uAo, base, baked ? 1 : 0);
  gl.uniformMatrix4fv(u.uKeyLightMatrix, false, keyMatrix);
  gl.uniform4f(u.uShadowParams, shadow.status === "complete" ? 1 : 0, 1 / shadow.size, studio.key.angularRadiusTan, GNM_PLAYER_LIGHT_VOLUME.radius * 2);
  gl.uniformMatrix4fv(u.uRimLightMatrix, false, rimMatrix);
  gl.uniform4f(u.uRimShadowParams, rimShadow.status === "complete" ? 1 : 0, 1 / rimShadow.size, 0, GNM_PLAYER_LIGHT_VOLUME.radius * 2);
  const regions = frame.skinRegions;
  gl.uniform4f(u.uSkinRegions, regions.redness, regions.periorbital, regions.beardShadow, regions.oiliness);
  gl.uniform1f(u.uSkinLightness, regions.lightness);
  gl.uniform3fv(u.uSkinMottleOffset, regions.mottleOffset);
  gl.uniform4fv(u.uFieldMin, buffers.fieldMin);
  gl.uniform4fv(u.uFieldMax, buffers.fieldMax);
  gl.uniform3fv(u.uSkin, linear(appearance.skin));
  gl.uniform3fv(u.uLip, linear(appearance.lip));
  gl.uniform3fv(u.uIris, linear(appearance.iris));
  gl.uniform3fv(u.uHair, linear(appearance.hair));
  // Skin under the beard and brows: darker roots of their mean colour.
  gl.uniform3fv(u.uBeardRoot, linear(appearance.beard).map((value) => value * 0.62));
  gl.uniform3fv(u.uBrowRoot, linear(appearance.brow).map((value) => value * 0.62));
  gl.uniform3fv(u.uKitPrimary, linear(appearance.kit.primary));
  gl.uniform3fv(u.uKitSecondary, linear(appearance.kit.secondary));
  const hair = appearance.hairStyle;
  gl.uniform4f(u.uHairStyle, hair?.hairline ?? 0, hair?.back ?? 0, hair?.fade ?? 0, hair?.thickness ?? 0);
  gl.uniform4f(u.uHairStyle2, hair?.top ?? 0, hair?.texture ?? 0, HAIR_PATTERNS[hair?.pattern] ?? 0, hair ? 1 : 0);
  const part = frame.groom.hair.part ?? { type: 0, x0: 0, slope: 0 };
  gl.uniform4f(u.uHairPart, part.type, part.x0, part.slope, hair ? gnmPlayerHairGroom(hair).scalpTint : 0);
  gl.uniform1f(u.uHairlineSoftness, hair ? gnmPlayerHairGroom(hair).hairlineSoftness : 1);
  const beardGroom = gnmPlayerBeardGroom(appearance.beardStyle);
  const browGroom = gnmPlayerBrowGroom(appearance.browStyle);
  gl.uniform4f(u.uFacialUnderlay, beardGroom?.underlay ?? 0, beardGroom?.follicles ?? 0, browGroom?.underlay ?? 0, 0);
  gl.uniform4f(u.uFlags, appearance.freckles ? 1 : 0, appearance.scar ? 1 : 0, appearance.ageShading, 0);
  const eyes = frame.eyes;
  gl.uniform4fv(u["uEyeCenters[0]"], eyes.uniforms.centers);
  gl.uniform4fv(u["uEyeAxes[0]"], eyes.uniforms.axes);
  gl.uniform3fv(u["uIrisCenters[0]"], eyes.uniforms.irisCenters);
  gl.uniform4fv(u["uIrisNormals[0]"], eyes.uniforms.irisNormals);
  gl.uniform3fv(u["uEyeUps[0]"], eyes.uniforms.ups);
  gl.uniform4fv(u["uCorneas[0]"], eyes.uniforms.corneas);
  gl.uniform4fv(u["uLidContact[0]"], eyes.uniforms.contact);
  gl.uniform3fv(u["uInnerCanthi[0]"], eyes.uniforms.innerCanthi);
  gl.uniform4f(u.uIrisDetail, eyes.iris.pupil, eyes.iris.collarette, eyes.iris.fiberContrast, eyes.iris.crypts);
  gl.uniform4f(u.uIrisDetail2, eyes.iris.limbalRing, eyes.iris.centralTint, eyes.iris.vessels, 0);
  gl.uniform2fv(u.uIrisOffset, eyes.iris.offset);
  gl.uniform3fv(u.uLashRoot, linear(eyes.lashPigment.root));
  gl.uniform3fv(u.uLashTip, linear(eyes.lashPigment.tip));
  gl.uniform2fv(u.uCollarPlane, frame.bust.collarPlane);
  const landmarkAverage = (indices) => [0, 1, 2].map((axis) => indices.reduce((sum, index) => sum + frame.landmarks[index * 3 + axis], 0) / indices.length);
  const ageAnchors = [[19, 24], [36], [45], [40, 41], [46, 47], [31], [35], [48], [54]].flatMap(landmarkAverage);
  gl.uniform3fv(u["uAgeAnchors[0]"], ageAnchors);
  gl.uniform1i(u.uDebugField, Number.isInteger(state.debugField) ? state.debugField : -1);
  gl.bindVertexArray(buffers.meshVao);
  gl.vertexAttrib1f(10, 0);
  aoBase(0);
  for (const [name, component] of [["skin", COMPONENT.skin], ["eye", COMPONENT.eye], ["teeth", COMPONENT.teeth], ["tongue", COMPONENT.tongue]]) {
    gl.uniform1i(u.uComponent, component);
    drawRange(gl, ranges[name]);
  }
  const drawMesh = (mesh, component, base) => {
    if (mesh.count <= 0) return;
    gl.bindVertexArray(mesh.vao);
    for (const index of [3, 4, 5, 6, 7, 9, 11]) gl.vertexAttrib4f(index, 0, 0, 0, 0);
    aoBase(base);
    gl.uniform1i(u.uComponent, component);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
  };
  const bases = state.aoBases;
  drawMesh(buffers.bust, COMPONENT.jersey, bases.bust ?? -2);
  drawMesh(buffers.bun, COMPONENT.bun, bases.bun ?? -2);
  drawMesh(buffers.frames, COMPONENT.frame, bases.frames ?? -2);
  // Strands (brows, beard, scalp hair) share one lean fibre program:
  // view-aligned ribbons whose bodies are opaque while tips and wisps use
  // alpha-to-coverage over the MSAA samples (dithered without MSAA). Each
  // draw sets its own pigment, grey fraction, roughness and tip fade.
  const hairFibre = gnmPlayerHairFibre(appearance);
  const strandDraws = [
    ["brow", state.facialDraw.brow, gnmPlayerFacialHairFibre(appearance, frame.groom.brow, "brow")],
    ["beard", state.facialDraw.beard, gnmPlayerFacialHairFibre(appearance, frame.groom.beard, "beard")],
    ["hair", state.hairDraw, { ...hairFibre, tipFade: frame.groom.hair.tipFade ?? 0.8 }],
  ].filter(([, draw]) => draw.indexCount > 0);
  if (strandDraws.length > 0) {
    const { program, uniforms: h } = state.hairPrograms[post.mode === "direct" ? 1 : 0];
    gl.useProgram(program);
    gl.uniformMatrix4fv(h.uProjection, false, camera.projection);
    gl.uniformMatrix4fv(h.uView, false, camera.view);
    gl.uniform3fv(h.uCameraPosition, camera.eye);
    gl.uniform2f(h.uViewport, canvas.width, canvas.height);
    gl.uniform1i(h.uAoBaked, baked ? 1 : 0);
    gl.uniform1i(h.uSceneEncoding, post.encoding);
    gl.uniform3fv(h.uKeyWorld, keyWorld);
    gl.uniformMatrix4fv(h.uKeyLightMatrix, false, keyMatrix);
    gl.uniform4f(h.uShadowParams, shadow.status === "complete" ? 1 : 0, 1 / shadow.size, studio.key.angularRadiusTan, GNM_PLAYER_LIGHT_VOLUME.radius * 2);
    gl.uniformMatrix4fv(h.uRimLightMatrix, false, rimMatrix);
    gl.uniform4f(h.uRimShadowParams, rimShadow.status === "complete" ? 1 : 0, 1 / rimShadow.size, 0, GNM_PLAYER_LIGHT_VOLUME.radius * 2);
    gl.uniform1i(h.uDebugField, Number.isInteger(state.debugField) && state.debugField >= 20 ? state.debugField : state.debugField >= 0 ? 0 : -1);
    for (const [part, draw, fibre] of strandDraws) {
      gl.uniform2fv(h.uStrandOpacity, part === "hair" ? HAIR_OPACITY : FACIAL_HAIR_OPACITY[part]);
      gl.uniform1f(h.uStrandMinPixels, draw.minPixels);
      gl.uniform1f(h.uStrandWidthScale, draw.widthScale);
      gl.uniform3fv(h.uHairPigment, fibre.pigment);
      gl.uniform3fv(h.uHairGrey, fibre.grey);
      gl.uniform4f(h.uHairFibre, fibre.tipLightening, fibre.greyFraction, fibre.roughness, fibre.tipFade);
      gl.bindVertexArray(buffers[STRAND_MESHES[part]].vao);
      if (!draw.dither) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      gl.drawElements(gl.TRIANGLES, draw.indexCount, gl.UNSIGNED_INT, 0);
      gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    }
    gl.useProgram(state.meshProgram);
  }
  // Eyelashes: view-aligned strands whose sub-pixel width becomes coverage,
  // resolved by alpha-to-coverage over the MSAA samples (depth stays exact,
  // so the glass pass below never draws over lashes in front of it).
  if (state.lashesDrawn) {
    gl.uniform1i(u.uStrand, 1);
    gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    drawMesh(buffers.lashes, COMPONENT.lash, -1);
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.uniform1i(u.uStrand, 0);
  }
  gl.bindVertexArray(buffers.meshVao);
  aoBase(0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false);
  gl.uniform1i(u.uComponent, COMPONENT.cornea);
  drawRange(gl, ranges.cornea);
  drawMesh(buffers.tearLine, COMPONENT.tearLine, -1);
  drawMesh(buffers.lenses, COMPONENT.lens, -2);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  gl.bindVertexArray(null);
  const postDiagnostics = compositeFrame(state, canvas, camera, post);
  const error = gl.getError();
  if (error !== gl.NO_ERROR) fail(`GNM player WebGL error ${error}`);
  return { camera, post: postDiagnostics };
}

/** World size (m) of one pixel at the depth of the eyes. */
function eyePixelSize(camera, frame, height) {
  const depth = eyeFocusDistance(camera, frame);
  return (2 * depth * Math.tan(GNM_PLAYER_FIELD_OF_VIEW / 2)) / Math.max(height, 1);
}

/**
 * Depth-of-field focus: view-space depth (m) between the cornea apexes,
 * weighted towards the nearer eye, so both eyes stay sharp in three-quarter
 * views; from behind the head it moves to the near side of the hair.
 */
function eyeFocusDistance(camera, frame) {
  const view = camera.view;
  const depth = (point) => -(view[2] * point[0] + view[6] * point[1] + view[10] * point[2] + view[14]);
  const [near, far] = frame.eyes.apexes.map(depth).sort((a, b) => a - b);
  const eyes = near + (far - near) * 0.35;
  // Views from behind (both eyes beyond the head centre): focus on the
  // near side of the head (the hair) instead of the hidden eyes. Front,
  // three-quarter and profile views keep the eye focus unchanged.
  const center = depth(GNM_PLAYER_HAIR.center);
  const behind = clamp((eyes - center) / 0.05, 0, 1);
  return eyes + (center - 0.06 - eyes) * behind * behind * (3 - 2 * behind);
}

/**
 * Resolve the MSAA scene (colour and depth), then the half-resolution depth
 * of field and the final composite into the canvas: vignette, tone mapping,
 * sRGB and deterministic grain. The canvas framebuffer is left bound, so
 * PNG export, thumbnails and readPixels see the composited image.
 */
function compositeFrame(state, canvas, camera, post) {
  const { gl } = state;
  const targets = post.targets;
  const backdropModel = state.postEffects === false ? "legacy-striped-gradient" : GNM_PLAYER_POST.backdrop.model;
  if (post.mode === "direct") {
    return { pipeline: "direct", mode: "direct", status: targets.status, reason: targets.reason, toneMapping: "scene-shader", samples: 0, depthOfField: { enabled: false }, grain: { amplitude: 0 }, vignette: { strength: 0 }, backdrop: backdropModel };
  }
  const { width, height } = targets;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, targets.sceneFramebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, targets.resolveFramebuffer);
  gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT.sceneColor);
  gl.bindTexture(gl.TEXTURE_2D, targets.colorTexture);
  gl.bindSampler(TEXTURE_UNIT.sceneColor, null);
  gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT.sceneDepth);
  gl.bindTexture(gl.TEXTURE_2D, targets.depthTexture);
  gl.bindSampler(TEXTURE_UNIT.sceneDepth, null);
  const dof = gnmPlayerDepthOfField({ width, height, focusDistance: eyeFocusDistance(camera, state.frame), enabled: post.photographic });
  const dofVector = [dof.enabled ? 1 : 0, dof.focusDistance, dof.blurPx, dof.maxCocPx];
  gl.bindVertexArray(state.backgroundVao);
  if (dof.enabled) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.blurFramebuffer);
    gl.viewport(0, 0, targets.halfWidth, targets.halfHeight);
    gl.useProgram(state.dofProgram);
    gl.uniform1i(state.dofUniforms.uEncoding, post.encoding);
    gl.uniform4fv(state.dofUniforms.uDof, dofVector);
    gl.uniform2f(state.dofUniforms.uTexel, 1 / width, 1 / height);
    gl.uniform2f(state.dofUniforms.uOutputSize, targets.halfWidth, targets.halfHeight);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, width, height);
  gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT.blur);
  gl.bindTexture(gl.TEXTURE_2D, targets.blurTexture);
  gl.bindSampler(TEXTURE_UNIT.blur, null);
  const grainAmplitude = gnmPlayerGrainAmplitude(width, height, post.photographic);
  const grainSeed = gnmPlayerGrainSeed(state.profileSeed ?? 0, camera.camera);
  const vignette = post.photographic ? GNM_PLAYER_POST.vignette : { strength: 0, power: 1 };
  const c = state.compositeUniforms;
  gl.useProgram(state.compositeProgram);
  gl.uniform1i(c.uEncoding, post.encoding);
  gl.uniform4fv(c.uDof, dofVector);
  gl.uniform2f(c.uVignette, vignette.strength, vignette.power);
  gl.uniform1f(c.uGrainAmplitude, grainAmplitude);
  gl.uniform1ui(c.uGrainSeed, grainSeed);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // Unbind the post textures so no later pass can form a feedback loop.
  for (const unit of [TEXTURE_UNIT.sceneColor, TEXTURE_UNIT.sceneDepth, TEXTURE_UNIT.blur]) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindVertexArray(null);
  return {
    pipeline: "offscreen",
    mode: post.mode,
    status: targets.status,
    colorFormat: targets.formatName,
    samples: targets.samples,
    encoding: ["linear-hdr", "compressed-rgba8", "display"][post.encoding],
    toneMapping: post.photographic ? "composite" : "scene-shader",
    framebuffers: { scene: "complete", resolve: "complete", depthOfField: "complete" },
    ...(targets.attempts.length ? { fallbacks: [...targets.attempts] } : {}),
    depthOfField: { enabled: dof.enabled, focusDistance: Number(dof.focusDistance.toFixed(5)), blurPx: Number(dof.blurPx.toFixed(3)), maxCocPx: Number(dof.maxCocPx.toFixed(3)) },
    grain: { amplitude: grainAmplitude, seed: grainSeed },
    vignette: { strength: vignette.strength },
    backdrop: backdropModel,
  };
}

/**
 * Per-profile ambient-occlusion bake, never run on camera orbit: every opaque
 * caster is rendered into fixed world-space orthographic depth layers over the
 * light volume, then each vertex (skin, eyes, mouth, hair shell, jersey, bun,
 * glasses frames) gathers cosine-weighted visibility into its own RGBA8 texel.
 * The texture stays on the GPU: the mesh vertex shader fetches its texel
 * (strands fetch their root's), so there is no readback stall.
 * Unavailable formats leave AO at 1 (cavity-only occlusion).
 *
 * Texel layout: [0, renderCount) render vertices, then the hair shell (when
 * visible), then jersey, bun and glasses frames (`state.aoBases`).
 */
function bakeAmbientOcclusion(state) {
  const { gl, buffers, frame, resources } = state;
  const { staticData } = resources;
  const count = staticData.renderCount;
  const hair = Boolean(frame.appearance.hairStyle);
  const layout = [{ key: "skin", vao: buffers.meshVao, base: 0, count }];
  let points = count;
  if (hair) { layout.push({ key: "shell", vao: buffers.shellVao, base: points, count }); points += count; }
  for (const key of ["bust", "bun", "frames"]) {
    if (buffers[key].vertexCount <= 0) continue;
    layout.push({ key, vao: buffers[key].vao, base: points, count: buffers[key].vertexCount });
    points += buffers[key].vertexCount;
  }
  if (!state.ao || (state.ao.status === "complete" && state.ao.capacity < points)) {
    if (state.ao?.status === "complete") {
      for (const framebuffer of [state.ao.depthFramebuffer, state.ao.colorFramebuffer, state.ao.smoothFramebuffer]) gl.deleteFramebuffer(framebuffer);
      for (const texture of [state.ao.depthArray, state.ao.colorTexture, state.ao.smoothTexture]) gl.deleteTexture(texture);
    }
    state.ao = createAoTarget(gl, Math.max(points, count * 2 + 4096));
  }
  const ao = state.ao;
  // Serial number of bakes on this canvas: camera orbits must never change it.
  state.aoBakes = (state.aoBakes ?? 0) + 1;
  state.aoBases = Object.fromEntries(layout.slice(1).map((entry) => [entry.key, entry.base]));
  frame.ambientOcclusion = { status: ao.status, directions: ao.directions, size: ao.size, points, storage: "gpu-texture", bakeSerial: state.aoBakes, ...(ao.reason ? { reason: ao.reason } : {}) };
  if (ao.status !== "complete") return;
  // 1. Directional depth layers (fixed world directions, fixed volume).
  gl.useProgram(state.depthProgram);
  gl.bindFramebuffer(gl.FRAMEBUFFER, ao.depthFramebuffer);
  gl.viewport(0, 0, ao.size, ao.size);
  gl.disable(gl.BLEND);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LESS);
  gl.depthMask(true);
  gl.enable(gl.POLYGON_OFFSET_FILL);
  gl.polygonOffset(1.5, 3.0);
  // Strands occlude too (skin, jersey and the envelope under hanging hair
  // darken), from the first third of the reduced tier only: that prefix is
  // the same in every level of detail, so thumbnails and the main view bake
  // the same AO, and its widths are scaled up to keep the full coverage.
  const hairMesh = frame.groom.hair;
  const aoStrandWidth = (STRAND_SHADOW_TEXELS * GNM_PLAYER_LIGHT_VOLUME.radius * 2) / ao.size;
  const hairAo = hair && buffers.hairStrands.count > 0 && hairMesh.tiers.aoIndexCount > 0
    ? { minHalfWidth: aoStrandWidth, widthScale: 3 / GNM_PLAYER_HAIR.reducedFraction, indexCount: hairMesh.tiers.aoIndexCount }
    : null;
  // The beard occludes the same way (its volume shades the neck and jaw);
  // brows lie within the bake's bias of the skin and are left out.
  const beardMesh = frame.groom.beard;
  const beardAo = buffers.beardStrands.count > 0 && beardMesh.tiers.aoIndexCount > 0
    ? { minHalfWidth: aoStrandWidth, draws: [{ part: "beard", indexCount: beardMesh.tiers.aoIndexCount, widthScale: 3 / GNM_PLAYER_FACIAL_HAIR.reducedFraction, coverage: 1 }] }
    : null;
  gnmPlayerAoDirections(ao.directions).forEach((direction, layer) => {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, ao.depthArray, 0, layer);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(state.depthUniforms.uLightMatrix, false, buildGnmPlayerLightMatrix(direction));
    drawCasters(state, { eyes: true, hair: hairAo && { ...hairAo, direction }, facial: beardAo && { ...beardAo, direction } });
  });
  gl.disable(gl.POLYGON_OFFSET_FILL);
  // 2. Per-vertex gather: one point per vertex into its own texel.
  gl.bindFramebuffer(gl.FRAMEBUFFER, ao.colorFramebuffer);
  gl.viewport(0, 0, ao.width, ao.height);
  gl.disable(gl.DEPTH_TEST);
  gl.clearColor(1, 1, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(state.aoProgram);
  gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT.aoMaps);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, ao.depthArray);
  gl.bindSampler(TEXTURE_UNIT.aoMaps, null);
  const texelWorld = (2 * GNM_PLAYER_LIGHT_VOLUME.radius) / ao.size;
  gl.uniform3f(state.aoUniforms.uBias, texelWorld * 1.25, 1.5 / ao.size, 1 / ao.size);
  gl.uniform2i(state.aoUniforms.uTarget, ao.width, ao.height);
  for (const entry of layout) {
    gl.uniform1i(state.aoUniforms.uBase, entry.base);
    gl.bindVertexArray(entry.vao);
    gl.drawArrays(gl.POINTS, 0, entry.count);
  }
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  // 3. One neighbour-averaging pass into the smoothed texture (bun/frames copied).
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, ao.colorFramebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, ao.smoothFramebuffer);
  gl.blitFramebuffer(0, 0, ao.width, ao.height, 0, 0, ao.width, ao.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, ao.smoothFramebuffer);
  gl.useProgram(state.aoSmoothProgram);
  gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT.rawAo);
  gl.bindTexture(gl.TEXTURE_2D, ao.colorTexture);
  gl.bindSampler(TEXTURE_UNIT.rawAo, null);
  gl.uniform2i(state.aoSmoothUniforms.uTarget, ao.width, ao.height);
  const bustVertices = buffers.bust.vertexCount;
  if (!state.aoNeighbors.bust || state.aoNeighbors.bust.count !== bustVertices) {
    state.aoNeighbors.bust = createNeighborVao(gl, buildGnmPlayerBustAoNeighbors(bustVertices, frame.bust.collarVertexCount));
  }
  const smoothBlocks = [[state.aoNeighbors.render, 0], ...(hair ? [[state.aoNeighbors.render, count]] : []), [state.aoNeighbors.bust, state.aoBases.bust]];
  for (const [neighbors, base] of smoothBlocks) {
    gl.uniform1i(state.aoSmoothUniforms.uBase, base);
    gl.bindVertexArray(neighbors.vao);
    gl.drawArrays(gl.POINTS, 0, neighbors.count);
  }
  gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.activeTexture(gl.TEXTURE0);
}

function shadowDiagnostics(target, filter) {
  return { status: target?.status ?? "not-rendered", format: target?.format ?? null, size: target?.size ?? 0, filter, ...(target?.reason ? { reason: target.reason } : {}) };
}

/** Beard and brow strand diagnostics: what was built for the profile and what this frame drew. */
function facialHairDiagnostics(groom, draws) {
  const part = (mesh, draw) => ({
    groom: mesh.groom,
    built: mesh.lod,
    strands: mesh.strandCount,
    points: mesh.pointCount,
    kinds: { ...mesh.kinds },
    tipFadeStart: Math.round((mesh.tipFade ?? 0.8) * 1000) / 1000,
    drawn: draw ? { lod: draw.lod, strands: draw.strands, widthScale: draw.widthScale, minPixels: draw.minPixels, dithered: draw.dither } : { lod: "none", strands: 0 },
  });
  return {
    model: GNM_PLAYER_FACIAL_HAIR.model,
    version: GNM_PLAYER_FACIAL_HAIR.version,
    shading: "marschner-r-tt-trt-deep-shadow-approximation",
    underlay: "per-vertex-root-density",
    beard: part(groom.beard, draws?.beard),
    brows: part(groom.brow, draws?.brow),
  };
}

/** Strand-hair diagnostics: what was built for the profile and what this frame drew. */
function hairDiagnostics(mesh, draw) {
  return {
    model: GNM_PLAYER_HAIR.model,
    version: GNM_PLAYER_HAIR.version,
    shading: "marschner-r-tt-trt-deep-shadow-approximation",
    groom: mesh.groom,
    built: mesh.lod,
    strands: mesh.strandCount,
    guides: mesh.guides,
    points: mesh.pointCount,
    babyHairs: mesh.babyHairs,
    kinds: { ...mesh.kinds },
    tipFadeStart: Math.round((mesh.tipFade ?? 0.8) * 1000) / 1000,
    drawn: draw ? { lod: draw.lod, strands: draw.strands, widthScale: draw.widthScale, minPixels: draw.minPixels, dithered: draw.dither } : { lod: "none", strands: 0 },
  };
}

function diagnosticsFor(canvas, state, { camera, post }) {
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
    groomingStrands: Object.fromEntries(Object.entries(frame.groom).map(([key, mesh]) => [key, mesh.strandCount])),
    hair: hairDiagnostics(frame.groom.hair, state.hairDraw),
    facialHair: facialHairDiagnostics(frame.groom, state.facialDraw),
    wrinkleStrength: frame.appearance.ageShading,
    collar: { model: "fitted-ribbed-crew-neck", plane: frame.bust.collarPlane, ringVertices: frame.bust.collarVertexCount },
    lighting: {
      ...GNM_PLAYER_LIGHTING,
      shadowMap: shadowDiagnostics(state.shadows.key, GNM_PLAYER_SHADOW.filter),
      rimShadowMap: shadowDiagnostics(state.shadows.rim, "4-tap bilinear PCF"),
      ambientOcclusionBake: { ...(frame.ambientOcclusion ?? { status: "not-baked" }) },
      skinLut: { size: state.skinLut.size, maxCurvaturePerMm: state.skinLut.maxCurvaturePerMm, encoding: state.skinLut.encoding },
      skinRegions: { ...frame.skinRegions, mottleOffset: [...frame.skinRegions.mottleOffset] },
    },
    eyes: {
      ...GNM_PLAYER_EYE_RENDERING,
      lashes: { ...frame.eyes.lashes.counts, strands: frame.eyes.lashes.strandCount, drawn: Boolean(state.lashesDrawn) },
      tearLineVertices: frame.eyes.tearLine.vertices.length / 3,
      contactSamples: GNM_PLAYER_EYES.contactSamples,
      iris: { ...frame.eyes.iris, offset: [...frame.eyes.iris.offset] },
      lashPigment: { root: [...frame.eyes.lashPigment.root], tip: [...frame.eyes.lashPigment.tip] },
    },
    post,
    camera: { ...camera.camera },
    canvas: { width: canvas.width, height: canvas.height },
  };
}

function redraw(canvas, state) {
  canvas.__sportsFaceWebglDiagnostics = diagnosticsFor(canvas, state, drawFrame(canvas, state));
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

async function renderInto(canvas, profile, options) {
  // The scene is multisampled offscreen; the canvas only receives the composite.
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  const resources = await loadGnmPlayerResources();
  let state = canvasState.get(canvas);
  if (!state || state.gl !== gl || state.resources !== resources) {
    state = { ...createGlState(gl, resources), resources, camera: { ...GNM_PLAYER_DEFAULT_CAMERA }, frame: null };
    canvasState.set(canvas, state);
  }
  if (options.camera) state.camera = clampGnmPlayerCamera(options.camera);
  state.debugField = Number.isInteger(options.debugField) && options.debugField >= 0 && options.debugField <= GNM_PLAYER_DEBUG_VIEWS.skinRegions ? options.debugField : -1;
  // Capture-only comparison switch: never persisted or exposed in the UI.
  state.postEffects = options.postEffects !== false;
  state.profileSeed = profile.seed >>> 0;
  state.frame = computeGnmPlayerFrame(resources, profile, options);
  uploadFrame(state, state.frame);
  // Geometry changed: bake AO once here; camera orbits only redraw.
  bakeAmbientOcclusion(state);
  return { state, diagnostics: redraw(canvas, state) };
}

/** Render one player into a WebGL2 canvas; rejects when rendering is unavailable. */
export function renderGnmPlayerFace(canvas, profile, options = {}) {
  return Promise.resolve().then(async () => {
    if (!canvas || typeof canvas.getContext !== "function") throw new Error("WebGL canvas is unavailable");
    const result = await renderInto(canvas, profile, options);
    if (!result) throw new Error("WebGL2 context is unavailable");
    attachCameraControls(canvas, result.state);
    return { canvas, fallback: false, renderer: GNM_PLAYER_RENDER_STYLE, diagnostics: result.diagnostics };
  });
}

let thumbnailCanvas = null;
let thumbnailQueue = Promise.resolve();

/** Render a 3D thumbnail into a 2D canvas through one shared offscreen WebGL2 canvas. */
export function renderGnmPlayerThumbnail(target, profile, options = {}) {
  const job = thumbnailQueue.then(async () => {
    if (typeof document === "undefined") throw new Error("document is unavailable");
    if (!thumbnailCanvas) {
      thumbnailCanvas = document.createElement("canvas");
      thumbnailCanvas.width = 256;
      thumbnailCanvas.height = 256;
    }
    // Thumbnails build only the reduced hair tier (fewer strands, same grooming).
    const result = await renderInto(thumbnailCanvas, profile, { ...options, camera: options.camera || GNM_PLAYER_DEFAULT_CAMERA, hairDetail: "reduced" });
    if (!result) throw new Error("WebGL2 context is unavailable");
    const context = target.getContext("2d");
    context.drawImage(thumbnailCanvas, 0, 0, target.width, target.height);
    return { canvas: target, fallback: false, renderer: GNM_PLAYER_RENDER_STYLE };
  });
  thumbnailQueue = job.catch(() => undefined);
  return job;
}

export function describeGnmPlayerRender(profile, options = {}) {
  return describeGnmPlayerMapping(profile, options);
}
