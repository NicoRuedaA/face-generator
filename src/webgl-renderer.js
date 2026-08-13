/* Dependency-free WebGL2 prototype for the geometry-derived GNM morph GLB. */
import { getFaceValues, hashSeed } from "./face-model.js";
import { renderGnmMorphFace } from "./morph-renderer.js";

export const WEBGL_MORPH_RENDER_STYLE = "sports/morph-webgl-v1";
export const WEBGL_MORPH_ASSET_URL = "./tools/gnm/work/head-morph.glb";
export const WEBGL_OFFICIAL_RENDER_STYLE = "sports/morph-webgl-official-v1";
export const WEBGL_OFFICIAL_ASSET_URL = "./tools/gnm/work/gnm-official-head-render.glb";
export const WEBGL_OFFICIAL_BASIS_LAB_STYLE = "sports/morph-webgl-official-basis-lab-v1";
export const WEBGL_OFFICIAL_BASIS_LAB_PAYLOAD_URL = "./tools/gnm/work/gnm-official-basis-lab.bin";
export const WEBGL_OFFICIAL_BASIS_LAB_METADATA_URL = "./tools/gnm/work/gnm-official-basis-lab.json";
export const BASIS_LAB_MAX_BYTES = 3 * 1024 * 1024;
export const BASIS_LAB_COEFFICIENT_LIMIT = 0.25;
const BASIS_LAB_UNAVAILABLE_MESSAGE = "Basis Lab no disponible: hash/schema inválido o presupuesto excedido";
export const OFFICIAL_MATERIAL_MODEL_VERSION = "neutral-procedural-components-v2";
export const OFFICIAL_COMPONENT_NAMES = Object.freeze([
  "skin", "left_eye", "right_eye", "upper_teeth_and_gums", "lower_teeth_and_gums", "tongue",
]);
export const OFFICIAL_LIGHTING_FEATURES = Object.freeze({
  hemisphere: true,
  key: true,
  fill: true,
  rim: true,
  specular: true,
  cavity: true,
});
/* Technical deformation visualization (inspection aid, OFF by default).
   These overlays render in the official fragment shader over the neutral
   procedural material. They are procedural debug patterns sampled from the
   exact official per-vertex TEXCOORD_0 and a deterministic LINES edge pass;
   they are explicitly NOT official textures and never mutate FaceDNA/SF2. */
export const TECHNICAL_VISUALIZATION_NONE = "none";
export const TECHNICAL_VISUALIZATION_UV_CHECKER = "uv-checker";
export const TECHNICAL_VISUALIZATION_WIREFRAME = "wireframe";
export const TECHNICAL_VISUALIZATION_COMBINED = "uv-checker+wireframe";
export const TECHNICAL_VISUALIZATION_VALUES = Object.freeze([
  TECHNICAL_VISUALIZATION_NONE,
  TECHNICAL_VISUALIZATION_UV_CHECKER,
  TECHNICAL_VISUALIZATION_WIREFRAME,
  TECHNICAL_VISUALIZATION_COMBINED,
]);
export const TECHNICAL_VISUALIZATION_NOTE = "Inspection aid: procedural UV-checker/wireframe overlay over the neutral material; not an official texture or material";
export const OFFICIAL_UV_CHECKER_DENSITY = 16;
export const OFFICIAL_WIREFRAME_COLOR = Object.freeze([0.96, 0.16, 0.86]);
export function clampTechnicalVisualization(value) {
  return TECHNICAL_VISUALIZATION_VALUES.includes(value) ? value : TECHNICAL_VISUALIZATION_NONE;
}
export function technicalVisualizationState(uvChecker, wireframe) {
  const checker = Boolean(uvChecker);
  const edges = Boolean(wireframe);
  if (checker && edges) return TECHNICAL_VISUALIZATION_COMBINED;
  if (checker) return TECHNICAL_VISUALIZATION_UV_CHECKER;
  if (edges) return TECHNICAL_VISUALIZATION_WIREFRAME;
  return TECHNICAL_VISUALIZATION_NONE;
}
export function describeTechnicalVisualization(technicalVisualization) {
  return {
    technicalVisualization: clampTechnicalVisualization(technicalVisualization),
    technicalVisualizationNote: TECHNICAL_VISUALIZATION_NOTE,
  };
}
export function technicalVisualizationFlags(technicalVisualization) {
  const state = clampTechnicalVisualization(technicalVisualization);
  return {
    uvChecker: state === TECHNICAL_VISUALIZATION_UV_CHECKER || state === TECHNICAL_VISUALIZATION_COMBINED,
    wireframe: state === TECHNICAL_VISUALIZATION_WIREFRAME || state === TECHNICAL_VISUALIZATION_COMBINED,
  };
}
const freezeMaterial = (material) => Object.freeze({
  ...material,
  baseColor: Object.freeze([...material.baseColor]),
});
export const OFFICIAL_MATERIAL_PALETTE = Object.freeze([
  freezeMaterial({ component: "skin", materialIndex: 0, baseColor: [0.62, 0.65, 0.68], perceptualRoughness: 0.68, specularStrength: 0.18 }),
  freezeMaterial({ component: "left_eye", materialIndex: 1, baseColor: [0.74, 0.78, 0.82], perceptualRoughness: 0.22, specularStrength: 0.52 }),
  freezeMaterial({ component: "right_eye", materialIndex: 2, baseColor: [0.70, 0.75, 0.80], perceptualRoughness: 0.24, specularStrength: 0.50 }),
  freezeMaterial({ component: "upper_teeth_and_gums", materialIndex: 3, baseColor: [0.80, 0.78, 0.72], perceptualRoughness: 0.38, specularStrength: 0.32 }),
  freezeMaterial({ component: "lower_teeth_and_gums", materialIndex: 4, baseColor: [0.76, 0.74, 0.69], perceptualRoughness: 0.42, specularStrength: 0.28 }),
  freezeMaterial({ component: "tongue", materialIndex: 5, baseColor: [0.58, 0.40, 0.42], perceptualRoughness: 0.50, specularStrength: 0.24 }),
]);
const BASIS_LAB_CANONICAL_SHA256 = "eb1179cb2724b3034e768c13b807f890fac250a5fb9e236a94d4ac345a9d342d";
const BASIS_LAB_RENDER_SHA256 = "081ddb9b1f6b26a76255fb1710b763bcb105941139cba1490a501b99c568e23f";
export const WEBGL_MORPH_WEIGHT_LIMIT = 0.75;
export const WEBGL_FRAME_MARGIN = 0.12;
export const DEFAULT_WEBGL_CAMERA = Object.freeze({ yaw: 0, pitch: 0, distance: 1 });
export const WEBGL_CAMERA_LIMITS = Object.freeze({
  yaw: [-Math.PI, Math.PI],
  pitch: [-1.15, 1.15],
  distance: [0.72, 1.65],
});
const TARGET_COUNT = 16;
const DEFAULT_FALLBACK_MESSAGE = "WebGL2 no disponible; se ha usado el renderer GNM SVG.";
const assetCache = new Map();
const basisLabCache = new Map();
const canvasState = new WeakMap();

function fail(message) { throw new Error(message); }
function finite(value) { return Number.isFinite(value); }

export function clampWebglCamera(camera = DEFAULT_WEBGL_CAMERA) {
  const value = (key) => camera?.[key] !== null && finite(Number(camera?.[key])) ? Number(camera[key]) : DEFAULT_WEBGL_CAMERA[key];
  return {
    yaw: Math.max(WEBGL_CAMERA_LIMITS.yaw[0], Math.min(WEBGL_CAMERA_LIMITS.yaw[1], value("yaw"))),
    pitch: Math.max(WEBGL_CAMERA_LIMITS.pitch[0], Math.min(WEBGL_CAMERA_LIMITS.pitch[1], value("pitch"))),
    distance: Math.max(WEBGL_CAMERA_LIMITS.distance[0], Math.min(WEBGL_CAMERA_LIMITS.distance[1], value("distance"))),
  };
}

function clampWebglWeight(value) {
  return Math.max(-WEBGL_MORPH_WEIGHT_LIMIT, Math.min(WEBGL_MORPH_WEIGHT_LIMIT, value));
}

function clampBasisCoefficient(value) {
  const numeric = Number(value);
  return finite(numeric) ? Math.max(-BASIS_LAB_COEFFICIENT_LIMIT, Math.min(BASIS_LAB_COEFFICIENT_LIMIT, numeric)) : 0;
}

export function mapWebglWeights(profile) {
  const values = getFaceValues(profile);
  const identity = [
    values.head, values.skin, values.eyes, values.brows, values.nose, values.mouth,
    values.freckles, values.eyeColor, values.earShape, values.jaw, values.faceProportion,
  ];
  // PCA decorrelation is derived from permanent identityBits only. It must not
  // make mutable presentation, appearance, age, kit, or expression affect geometry.
  const identityHash = hashSeed(`identity:${profile.identityBits >>> 0}`);
  const weights = [];
  for (let index = 0; index < TARGET_COUNT; index += 1) {
    const identityValue = identity[index % identity.length] / 5;
    const phase = ((identityHash ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0) / 0x100000000;
    const raw = (identityValue - 0.5) * 0.42 + (phase - 0.5) * 0.18;
    weights.push(clampWebglWeight(raw));
  }
  return weights;
}

export function describeWebglMapping(profile) {
  return {
    renderer: WEBGL_MORPH_RENDER_STYLE,
    prototype: true,
    source: "geometry-derived PCA targets from retained GNM mesh samples",
    gnmRuntimeDependency: false,
    targetSemantics: "neutral PCA components; not anatomical controls",
    targetCount: TARGET_COUNT,
    weights: mapWebglWeights(profile),
    mapping: {
      identityOnly: true,
      inputs: ["head", "skin", "eyes", "brows", "nose", "mouth", "freckles", "eyeColor", "earShape", "jaw", "faceProportion"],
      method: "identityBits-only deterministic hash plus normalized permanent FaceDNA identity slots; each component is clamped to [-0.75, 0.75]",
      note: "Age, appearance, presentation, kit, expression options, and seed do not affect geometry weights; PCA component directions and neutral IDs are geometry-derived and are not interpreted as semantic facial controls.",
    },
  };
}

export function describeOfficialWebglMapping(options = {}) {
  return {
    renderer: WEBGL_OFFICIAL_RENDER_STYLE,
    prototype: true,
    source: "official GNM Head v3.0 template and basis metadata",
    targetSemantics: "neutral official template; no semantic basis mapping",
    officialTexturesIncluded: false,
    materialModel: OFFICIAL_MATERIAL_MODEL_VERSION,
    materialModelVersion: OFFICIAL_MATERIAL_MODEL_VERSION,
    lighting: { ...OFFICIAL_LIGHTING_FEATURES },
    componentMaterialInfo: materialDiagnostics(),
    ...describeTechnicalVisualization(options?.technicalVisualization),
    mapping: {
      identityOnly: true,
      applied: false,
      identityBasis: "disabled: official head_/eyes_/teeth_ names do not safely map to FaceDNA variables",
      expressionBasis: "disabled: regional expression names do not safely map to application expression modes",
      identityInvariant: true,
    },
  };
}

export function describeOfficialBasisLabMapping(coefficients = {}, options = {}) {
  const values = Object.fromEntries(BASIS_LAB_VECTOR_LABELS.map((label, index) => [label, clampBasisCoefficient(Array.isArray(coefficients) ? coefficients[index] : coefficients[label])]));
  return {
    renderer: WEBGL_OFFICIAL_BASIS_LAB_STYLE,
    prototype: true,
    source: "separately delivered projected official GNM basis subset",
    targetSemantics: "technical basis directions; no anatomical controls",
    basisIncluded: true,
    materialModel: OFFICIAL_MATERIAL_MODEL_VERSION,
    materialModelVersion: OFFICIAL_MATERIAL_MODEL_VERSION,
    lighting: { ...OFFICIAL_LIGHTING_FEATURES },
    componentMaterialInfo: materialDiagnostics(),
    identityCount: 4,
    expressionCount: 4,
    selectedVectors: BASIS_LAB_VECTOR_LABELS,
    coefficients: values,
    ...describeTechnicalVisualization(options?.technicalVisualization),
    mapping: "technical coefficients only; semanticMapping disabled",
  };
}

const BASIS_LAB_VECTOR_LABELS = Object.freeze([
  "GNM identity basis 000", "GNM identity basis 001", "GNM identity basis 002", "GNM identity basis 003",
  "GNM expression basis 000", "GNM expression basis 001", "GNM expression basis 002", "GNM expression basis 003",
]);

function materialDiagnostics() {
  return OFFICIAL_MATERIAL_PALETTE.map((material) => ({
    ...material,
    baseColor: [...material.baseColor],
    materialSource: "neutral-procedural",
    officialTexturesIncluded: false,
  }));
}

function parseGlb(data) {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 20) fail("GLB is shorter than its header");
  const header = new DataView(data, 0, 12);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2) fail("unsupported GLB header");
  if (header.getUint32(8, true) !== data.byteLength) fail("GLB length is invalid");
  let offset = 12;
  let json = null;
  let binary = null;
  while (offset < data.byteLength) {
    if (offset + 8 > data.byteLength) fail("truncated GLB chunk");
    const length = headerFor(data, offset).getUint32(0, true);
    const type = headerFor(data, offset).getUint32(4, true);
    const start = offset + 8;
    const end = start + length;
    if (end > data.byteLength || length % 4 !== 0) fail("invalid GLB chunk range");
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, start, length)).trim());
    if (type === 0x004e4942) binary = new Uint8Array(data, start, length);
    offset = end;
  }
  if (!json || !binary) fail("GLB must contain JSON and BIN chunks");
  return { json, binary };
}

function headerFor(data, offset) { return new DataView(data, offset, 8); }

function parseAsset(data) {
  const { json, binary } = parseGlb(data);
  if (json.extras?.sportsFaceGnmOfficial?.schema === "sports-face-gnm-official-head/v1") return parseOfficialAsset(json, binary);
  if (json.asset?.version !== "2.0" || json.scene !== 0 || json.scenes?.length !== 1 || json.nodes?.length !== 1 || json.meshes?.length !== 1) fail("GLB scene structure is unsupported");
  if (json.buffers?.length !== 1 || json.buffers[0].byteLength !== binary.byteLength) fail("GLB buffer length is invalid");
  const mesh = json.meshes[0];
  const primitive = mesh.primitives?.length === 1 ? mesh.primitives[0] : null;
  if (!primitive || primitive.mode !== 4 || primitive.attributes?.POSITION !== 0 || primitive.indices !== 1) fail("GLB primitive structure is unsupported");
  if (!Array.isArray(primitive.targets) || primitive.targets.length !== TARGET_COUNT || mesh.extras?.targetNames?.length !== TARGET_COUNT) fail("GLB must contain exactly 16 morph targets");
  const accessors = json.accessors;
  const views = json.bufferViews;
  if (!Array.isArray(accessors) || !Array.isArray(views) || accessors.length !== 2 + TARGET_COUNT || views.length !== 2 + TARGET_COUNT) fail("GLB accessor count is invalid");
  const viewBytes = (accessorIndex, componentType, type, count) => {
    const accessor = accessors[accessorIndex];
    const view = views[accessor?.bufferView];
    if (!accessor || !view || accessor.componentType !== componentType || accessor.type !== type || accessor.count !== count) fail(`invalid accessor ${accessorIndex}`);
    const offset = (view.byteOffset || 0) + (accessor.byteOffset || 0);
    const componentCount = type === "VEC3" ? 3 : 1;
    const componentBytes = componentType === 5126 || componentType === 5125 ? 4 : 0;
    if (offset % 4 !== 0 || view.byteLength !== count * componentCount * componentBytes || offset + view.byteLength > binary.byteLength) fail(`invalid bufferView ${accessorIndex}`);
    return { accessor, view, offset };
  };
  const vertexCount = accessors[0]?.count;
  if (!Number.isInteger(vertexCount) || vertexCount <= 0) fail("GLB vertex count is invalid");
  const position = viewBytes(0, 5126, "VEC3", vertexCount);
  const indices = viewBytes(1, 5125, "SCALAR", accessors[1]?.count);
  if (indices.accessor.count % 3 !== 0) fail("GLB index count is not triangular");
  const targets = primitive.targets.map((target, index) => {
    if (target.POSITION !== index + 2 || mesh.extras.targetNames[index] !== `gnm-pca-${String(index + 1).padStart(2, "0")}`) fail("GLB morph target order or names are invalid");
    return viewBytes(index + 2, 5126, "VEC3", vertexCount);
  });
  const bounds = { min: json.accessors[0].min, max: json.accessors[0].max };
  if (!Array.isArray(bounds.min) || !Array.isArray(bounds.max) || bounds.min.length !== 3 || bounds.max.length !== 3 || ![...bounds.min, ...bounds.max].every(finite)) fail("GLB bounds are invalid");
  const readView = (entry) => new Float32Array(binary.buffer.slice(binary.byteOffset + entry.offset, binary.byteOffset + entry.offset + entry.view.byteLength));
  const finiteView = (entry) => {
    const values = readView(entry);
    if (!values.every(finite)) fail("GLB contains non-finite morph data");
    return values;
  };
  finiteView(position);
  const morphDisplacementBound = [0, 0, 0];
  targets.forEach((target) => {
    const values = finiteView(target);
    for (let axis = 0; axis < 3; axis += 1) {
      let maximum = 0;
      for (let index = axis; index < values.length; index += 3) maximum = Math.max(maximum, Math.abs(values[index]));
      morphDisplacementBound[axis] += maximum * WEBGL_MORPH_WEIGHT_LIMIT;
    }
  });
  return { json, binary, vertexCount, position, indices, targets, bounds, morphDisplacementBound };
}

/* SHA-256 helpers for the Basis Lab integrity check. The Web Crypto API is the
   primary path in secure contexts; the pure-JS implementation below is a
   deterministic fallback so verification still runs when the page is opened as
   file:// or in a non-secure context where crypto.subtle is unavailable. */
function sha256Hex(digest) {
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function rotr32(value, bits) { return (value >>> bits) | (value << (32 - bits)); }

function sha256BytesFallback(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const length = data.byteLength;
  const paddedLength = Math.ceil((length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(data);
  padded[length] = 0x80;
  const lengthBits = length * 8;
  const tail = new DataView(padded.buffer, paddedLength - 8, 8);
  tail.setUint32(0, Math.floor(lengthBits / 0x100000000), false);
  tail.setUint32(4, lengthBits >>> 0, false);
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  const view = new DataView(padded.buffer);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const sigma0 = rotr32(words[index - 15], 7) ^ rotr32(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const sigma1 = rotr32(words[index - 2], 17) ^ rotr32(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + bigSigma1 + choose + K[index] + words[index]) >>> 0;
      const bigSigma0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigSigma0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }
  let hex = "";
  for (let index = 0; index < 8; index += 1) hex += H[index].toString(16).padStart(8, "0");
  return hex;
}

async function sha256Bytes(bytes) {
  if (globalThis.crypto?.subtle?.digest) return sha256Hex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return sha256BytesFallback(bytes);
}

async function fetchBasisLab() {
  const cacheKey = `${WEBGL_OFFICIAL_BASIS_LAB_METADATA_URL}|${WEBGL_OFFICIAL_BASIS_LAB_PAYLOAD_URL}`;
  if (!basisLabCache.has(cacheKey)) {
    basisLabCache.set(cacheKey, (async () => {
      try {
        const [metadataResponse, payloadResponse] = await Promise.all([fetch(WEBGL_OFFICIAL_BASIS_LAB_METADATA_URL), fetch(WEBGL_OFFICIAL_BASIS_LAB_PAYLOAD_URL)]);
        if (!metadataResponse.ok || !payloadResponse.ok) fail("Basis Lab payload fetch failed");
        const metadataText = await metadataResponse.text();
        const metadataBytes = new TextEncoder().encode(metadataText);
        if (metadataBytes.byteLength > BASIS_LAB_MAX_BYTES) fail("Basis Lab metadata exceeds the byte budget");
        const metadata = JSON.parse(metadataText);
        const payload = await payloadResponse.arrayBuffer();
        if (payload.byteLength > BASIS_LAB_MAX_BYTES || payload.byteLength !== metadata.payload?.sizeBytes || metadata.budget?.maxBytes !== BASIS_LAB_MAX_BYTES) fail("Basis Lab payload exceeds the byte budget");
        const hash = await sha256Bytes(payload);
        if (hash !== metadata.payload?.sha256 || metadata.schema !== "sports-face-gnm-official-basis-lab/v1" || metadata.source?.canonicalGlb?.sha256 !== BASIS_LAB_CANONICAL_SHA256 || metadata.source?.renderGlb?.sha256 !== BASIS_LAB_RENDER_SHA256) fail("Basis Lab metadata or hash is invalid");
        if (metadata.semanticMapping !== "disabled" || metadata.runtimeBasisLoaded !== true) fail("Basis Lab safety metadata is invalid");
        const view = new DataView(payload);
        if (payload.byteLength < 36 || new TextDecoder().decode(new Uint8Array(payload, 0, 8)) !== "SFBASIS1") fail("Basis Lab binary header is invalid");
        const version = view.getUint32(8, true);
        const headerBytes = view.getUint32(12, true);
        const vertexCount = view.getUint32(16, true);
        const vectorCount = view.getUint32(20, true);
        const sourceOffset = view.getUint32(24, true);
        const vectorOffset = view.getUint32(28, true);
        const vectorBytes = view.getUint32(32, true);
        if (version !== 1 || headerBytes !== 36 || vertexCount !== metadata.dimensions?.renderVertexCount || vectorCount !== 8 || sourceOffset !== 36 || vectorOffset !== sourceOffset + vertexCount * 4 || vectorOffset + vectorBytes !== payload.byteLength || vectorBytes !== vertexCount * vectorCount * 12) fail("Basis Lab binary dimensions are invalid");
        return { metadata, payload: new Uint8Array(payload), vertexCount, vectorCount, vectorOffset };
      } catch {
        // The payload, metadata, hash, budget, and schema checks above never
        // skip verification. Any failure surfaces as one bounded message so
        // the safe 2D GNM SVG fallback shows a clear toast instead of an
        // uncaught page error.
        throw new Error(BASIS_LAB_UNAVAILABLE_MESSAGE);
      }
    })());
  }
  return basisLabCache.get(cacheKey);
}

function accessorView(json, binary, accessorIndex, componentType, type) {
  const accessor = json.accessors?.[accessorIndex];
  const view = json.bufferViews?.[accessor?.bufferView];
  const componentCount = type === "VEC3" ? 3 : type === "VEC2" ? 2 : 1;
  if (!accessor || !view || accessor.componentType !== componentType || accessor.type !== type) fail(`invalid official accessor ${accessorIndex}`);
  const offset = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const componentBytes = componentType === 5123 ? 2 : 4;
  const bytes = accessor.count * componentCount * componentBytes;
  if (offset % 4 !== 0 || view.byteLength !== bytes || offset + bytes > binary.byteLength) fail(`invalid official bufferView ${accessorIndex}`);
  return { accessor, view, offset };
}

function parseOfficialAsset(json, binary) {
  if (json.asset?.version !== "2.0" || json.scene !== 0 || json.scenes?.length !== 1 || json.nodes?.length !== 1 || json.meshes?.length !== 1) fail("official GLB scene structure is unsupported");
  const mesh = json.meshes[0];
  const names = OFFICIAL_COMPONENT_NAMES;
  if (mesh.primitives?.length !== names.length || json.materials?.length !== names.length || json.buffers?.[0]?.byteLength !== binary.byteLength) fail("official GLB component structure is invalid");
  const primitives = mesh.primitives.map((primitive, index) => {
    if (primitive.mode !== 4 || primitive.material !== index || primitive.extras?.componentName !== names[index]) fail("official GLB component order is invalid");
    const position = accessorView(json, binary, primitive.attributes?.POSITION, 5126, "VEC3");
    const uv = accessorView(json, binary, primitive.attributes?.TEXCOORD_0, 5126, "VEC2");
    const indexComponentType = json.accessors?.[primitive.indices]?.componentType;
    if (![5123, 5125].includes(indexComponentType)) fail("official GLB indices must use uint16 or uint32");
    const indices = accessorView(json, binary, primitive.indices, indexComponentType, "SCALAR");
    if (position.accessor.count !== uv.accessor.count || indices.accessor.count % 3 !== 0) fail("official primitive counts are invalid");
    const material = json.materials[index];
    if (material.extras?.materialSource !== "neutral-procedural" || material.extras?.officialTexturesIncluded !== false) fail("official material is not explicitly neutral procedural");
    return { name: names[index], position, uv, indices, color: material.pbrMetallicRoughness?.baseColorFactor || [0.72, 0.72, 0.72, 1] };
  });
  const bounds = primitives.reduce((result, primitive) => ({
    min: result.min.map((value, axis) => Math.min(value, primitive.position.accessor.min[axis])),
    max: result.max.map((value, axis) => Math.max(value, primitive.position.accessor.max[axis])),
  }), { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  const official = json.extras.sportsFaceGnmOfficial;
  const renderOnly = official.renderOnly === true;
  if (renderOnly) {
    if (official.basisIncluded !== false || official.basis || official.lossless?.quantization !== "none") fail("official render-only metadata is unsafe");
  } else if (official.basis?.identity?.count !== 253 || official.basis?.expression?.count !== 383) {
    fail("official basis metadata is unsafe");
  }
  if (official.mapping?.identity?.applied !== false || official.mapping?.expression?.applied !== false) fail("official mapping metadata is unsafe");
  return { official: true, json, binary, primitives, bounds, morphDisplacementBound: [0, 0, 0], vertexCount: primitives.reduce((total, primitive) => total + primitive.position.accessor.count, 0) };
}

export function parseWebglGlb(data) { return parseAsset(data); }

async function fetchAsset(url) {
  if (!assetCache.has(url)) {
    assetCache.set(url, fetch(url).then((response) => {
      if (!response.ok) fail(`morph GLB fetch failed with HTTP ${response.status}`);
      return response.arrayBuffer();
    }).then(parseAsset));
  }
  return assetCache.get(url);
}

function shader(gl, type, source) {
  const result = gl.createShader(type);
  gl.shaderSource(result, source);
  gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(result);
    gl.deleteShader(result);
    fail(`WebGL shader compilation failed: ${log}`);
  }
  return result;
}

function program(gl) {
  const vertex = shader(gl, gl.VERTEX_SHADER, `#version 300 es
    layout(location=0) in vec3 aPosition;
    precision highp sampler2DArray;
    uniform highp sampler2DArray uMorphDeltas;
    uniform float uWeights[16];
    uniform vec2 uTextureSize;
    uniform mat4 uProjection;
    uniform mat4 uCamera;
    out vec3 vPosition;
    void main() {
      vec3 position = aPosition;
      for (int index = 0; index < 16; index++) {
        int x = gl_VertexID % int(uTextureSize.x);
        int y = gl_VertexID / int(uTextureSize.x);
        position += texelFetch(uMorphDeltas, ivec3(x, y, index), 0).xyz * uWeights[index];
      }
      vPosition = position;
      gl_Position = uProjection * uCamera * vec4(position, 1.0);
    }`);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float;
    in vec3 vPosition;
    out vec4 color;
    void main() {
      // The retained mesh has mixed winding, so orient derivatives toward the camera
      // for coherent two-sided lighting instead of enabling unsafe back-face culling.
      vec3 normal = normalize(cross(dFdx(vPosition), dFdy(vPosition)));
      normal = faceforward(normal, vec3(0.0, 0.0, -1.0), normal);
      vec3 viewDirection = normalize(vec3(0.0, 0.0, 1.0));
      vec3 keyLight = normalize(vec3(-0.45, 0.72, 1.0));
      vec3 fillLight = normalize(vec3(0.70, 0.15, 0.55));
      float diffuse = max(dot(normal, keyLight), 0.0);
      float fill = max(dot(normal, fillLight), 0.0);
      float rim = pow(1.0 - max(dot(normal, viewDirection), 0.0), 2.0);
      vec3 base = vec3(0.72, 0.55, 0.43);
      vec3 lit = base * (0.24 + 0.58 * diffuse + 0.16 * fill) + vec3(0.10, 0.045, 0.025) * rim;
      color = vec4(lit, 1.0);
    }`);
  const result = gl.createProgram();
  gl.attachShader(result, vertex);
  gl.attachShader(result, fragment);
  gl.linkProgram(result);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) fail(`WebGL program link failed: ${gl.getProgramInfoLog(result)}`);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  return result;
}

function officialProgram(gl) {
  const vertex = shader(gl, gl.VERTEX_SHADER, `#version 300 es
    layout(location=0) in vec3 aPosition;
    layout(location=1) in vec2 aTexCoord;
    uniform mat4 uProjection;
    uniform mat4 uCamera;
    out vec3 vViewPosition;
    out vec2 vTexCoord;
    void main() {
      vec4 viewPosition = uCamera * vec4(aPosition, 1.0);
      vViewPosition = viewPosition.xyz;
      // Exact official per-vertex TEXCOORD_0; only consumed by the technical
      // UV checker so the pattern deforms with the mesh.
      vTexCoord = aTexCoord;
      gl_Position = uProjection * viewPosition;
    }`);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float;
    uniform int uMaterialIndex;
    uniform vec4 uBaseColors[6];
    uniform float uPerceptualRoughness[6];
    uniform float uSpecularStrength[6];
    uniform int uUvCheckerEnabled;
    uniform int uWireframePass;
    uniform vec3 uInspectionColor;
    uniform float uCheckerDensity;
    in vec3 vViewPosition;
    in vec2 vTexCoord;
    out vec4 color;
    vec3 safeNormalize(vec3 value, vec3 fallback) {
      float lengthSquared = dot(value, value);
      return lengthSquared > 0.000001 ? value * inversesqrt(lengthSquared) : fallback;
    }
    void main() {
      if (uWireframePass == 1) {
        // Technical wireframe overlay pass: flat unlit inspection color over
        // the already-shaded surface. Depth testing stays enabled so only the
        // edges on or in front of the surface draw.
        color = vec4(uInspectionColor, 1.0);
        return;
      }
      int materialIndex = clamp(uMaterialIndex, 0, 5);
      vec4 material = uBaseColors[materialIndex];
      vec3 base = material.rgb;
      if (uUvCheckerEnabled == 1) {
        // Technical UV inspection pattern: deterministic checker (plus thin
        // cell lines) sampled from UV space, so the pattern deforms with the
        // mesh and exposes basis displacement. Inspection aid only; this is
        // never an official texture.
        vec2 cell = floor(vTexCoord * uCheckerDensity);
        float parity = mod(cell.x + cell.y, 2.0);
        base = mix(vec3(0.88, 0.93, 0.99), vec3(0.82, 0.10, 0.16), parity);
        vec2 edge = fract(vTexCoord * uCheckerDensity);
        float line = max(step(0.96, edge.x), step(0.96, edge.y));
        base = mix(base, vec3(0.03, 0.05, 0.10), line);
      }
      float perceptualRoughness = clamp(uPerceptualRoughness[materialIndex], 0.0, 1.0);
      float specularStrength = clamp(uSpecularStrength[materialIndex], 0.0, 1.0);
      vec3 normal = safeNormalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)), vec3(0.0, 0.0, 1.0));
      vec3 viewDirection = safeNormalize(-vViewPosition, vec3(0.0, 0.0, 1.0));
      // The retained mesh has mixed winding. Faceforward preserves two-sided rendering
      // while orienting derivative normals toward the stable view-space camera.
      normal = faceforward(normal, -viewDirection, normal);
      vec3 keyLight = safeNormalize(vec3(-0.45, 0.72, 1.0), vec3(0.0, 0.0, 1.0));
      vec3 fillLight = safeNormalize(vec3(0.70, 0.15, 0.55), vec3(0.0, 0.0, 1.0));
      vec3 rimLight = safeNormalize(vec3(0.15, 0.35, -0.85), vec3(0.0, 0.0, -1.0));
      float hemisphereFactor = clamp(normal.y * 0.5 + 0.5, 0.0, 1.0);
      vec3 hemisphere = mix(vec3(0.10, 0.115, 0.13), vec3(0.30, 0.32, 0.35), hemisphereFactor);
      float key = max(dot(normal, keyLight), 0.0);
      float fill = max(dot(normal, fillLight), 0.0);
      float rim = pow(1.0 - max(dot(normal, viewDirection), 0.0), 3.0) * max(dot(normal, rimLight), 0.0);
      float roughness = max(0.045, perceptualRoughness * perceptualRoughness);
      vec3 halfVector = safeNormalize(keyLight + viewDirection, normal);
      float shininess = mix(8.0, 128.0, 1.0 - roughness);
      float specular = pow(max(dot(normal, halfVector), 0.0), shininess) * specularStrength;
      float lightAgreement = clamp(key * 0.72 + fill * 0.28, 0.0, 1.0);
      float cavity = mix(0.78, 1.0, smoothstep(0.0, 0.85, lightAgreement));
      vec3 lit = base * (hemisphere + vec3(0.58, 0.56, 0.54) * key + vec3(0.20, 0.22, 0.25) * fill);
      lit = lit * cavity + vec3(0.14, 0.16, 0.19) * rim + vec3(specular);
      if (any(isnan(lit)) || any(isinf(lit))) lit = material.rgb;
      color = vec4(clamp(lit, vec3(0.0), vec3(1.0)), 1.0);
    }`);
  const result = gl.createProgram();
  gl.attachShader(result, vertex); gl.attachShader(result, fragment); gl.linkProgram(result);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) fail(`official WebGL program link failed: ${gl.getProgramInfoLog(result)}`);
  gl.deleteShader(vertex); gl.deleteShader(fragment);
  return result;
}

export function expandWebglBounds(bounds, displacementBound = [0, 0, 0]) {
  if (!bounds?.min || !bounds?.max || bounds.min.length !== 3 || bounds.max.length !== 3) fail("WebGL bounds must have three axes");
  if (displacementBound.length !== 3 || ![...bounds.min, ...bounds.max, ...displacementBound].every(finite)) fail("WebGL bounds must be finite");
  return {
    min: bounds.min.map((value, index) => value - Math.abs(displacementBound[index])),
    max: bounds.max.map((value, index) => value + Math.abs(displacementBound[index])),
  };
}

export function buildWebglProjection(bounds, aspect, displacementBound = [0, 0, 0]) {
  if (!finite(aspect) || aspect <= 0) fail("WebGL projection aspect must be positive");
  const expanded = expandWebglBounds(bounds, displacementBound);
  const center = expanded.min.map((value, index) => (value + expanded.max[index]) / 2);
  const size = expanded.max.map((value, index) => value - expanded.min[index]);
  const height = Math.max(size[1], size[0] / aspect) * (1 + WEBGL_FRAME_MARGIN * 2);
  const width = height * aspect;
  const depth = Math.max(size[2] * (1 + WEBGL_FRAME_MARGIN * 2), 0.5);
  return new Float32Array([
    2 / width, 0, 0, 0, 0, 2 / height, 0, 0, 0, 0, -2 / depth, 0,
    -2 * center[0] / width, -2 * center[1] / height, 2 * center[2] / depth, 1,
  ]);
}

function multiplyWebglMatrices(left, right) {
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      result[column * 4 + row] =
        left[row] * right[column * 4] +
        left[4 + row] * right[column * 4 + 1] +
        left[8 + row] * right[column * 4 + 2] +
        left[12 + row] * right[column * 4 + 3];
    }
  }
  return result;
}

function translationWebglMatrix(x, y, z) {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

export function buildWebglCameraMatrix(bounds, aspect, camera = DEFAULT_WEBGL_CAMERA, displacementBound = [0, 0, 0]) {
  const safeCamera = clampWebglCamera(camera);
  if (safeCamera.yaw === 0 && safeCamera.pitch === 0 && safeCamera.distance === 1) return new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]);
  const expanded = expandWebglBounds(bounds, displacementBound);
  const center = expanded.min.map((value, index) => (value + expanded.max[index]) / 2);
  const yawCos = Math.cos(safeCamera.yaw);
  const yawSin = Math.sin(safeCamera.yaw);
  const pitchCos = Math.cos(safeCamera.pitch);
  const pitchSin = Math.sin(safeCamera.pitch);
  const rotationY = new Float32Array([
    yawCos, 0, -yawSin, 0, 0, 1, 0, 0, yawSin, 0, yawCos, 0, 0, 0, 0, 1,
  ]);
  const rotationX = new Float32Array([
    1, 0, 0, 0, 0, pitchCos, pitchSin, 0, 0, -pitchSin, pitchCos, 0, 0, 0, 0, 1,
  ]);
  const scale = 1 / safeCamera.distance;
  const cameraTransform = multiplyWebglMatrices(
    translationWebglMatrix(center[0], center[1], center[2]),
    multiplyWebglMatrices(
      new Float32Array([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1]),
      multiplyWebglMatrices(rotationX, multiplyWebglMatrices(rotationY, translationWebglMatrix(-center[0], -center[1], -center[2]))),
    ),
  );
  return cameraTransform;
}

function upload(gl, asset) {
  const positionView = asset.position.view;
  const indexView = asset.indices.view;
  const position = new Float32Array(asset.binary.buffer.slice(asset.binary.byteOffset + asset.position.offset, asset.binary.byteOffset + asset.position.offset + positionView.byteLength));
  const indices = new Uint32Array(asset.binary.buffer.slice(asset.binary.byteOffset + asset.indices.offset, asset.binary.byteOffset + asset.indices.offset + indexView.byteLength));
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, position, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  const width = 256;
  const height = Math.ceil(asset.vertexCount / width);
  const textureData = new Float32Array(width * height * 4 * TARGET_COUNT);
  asset.targets.forEach((target, layer) => {
    const values = new Float32Array(asset.binary.buffer.slice(asset.binary.byteOffset + target.offset, asset.binary.byteOffset + target.offset + target.view.byteLength));
    const layerOffset = layer * width * height * 4;
    for (let vertex = 0; vertex < asset.vertexCount; vertex += 1) {
      textureData.set(values.subarray(vertex * 3, vertex * 3 + 3), layerOffset + vertex * 4);
    }
  });
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA32F, width, height, TARGET_COUNT);
  gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, width, height, TARGET_COUNT, gl.RGBA, gl.FLOAT, textureData);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindVertexArray(null);
  return { vao, texture, indexCount: indices.length, textureSize: [width, height] };
}

function uploadOfficial(gl, asset, basisLab = null) {
  const read = (entry, Type) => new Type(asset.binary.buffer.slice(asset.binary.byteOffset + entry.offset, asset.binary.byteOffset + entry.offset + entry.view.byteLength));
  let vertexOffset = 0;
  const primitives = asset.primitives.map((primitive) => {
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const position = read(primitive.position, Float32Array);
    const positionBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer); gl.bufferData(gl.ARRAY_BUFFER, position, basisLab ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    // Upload the exact official per-vertex TEXCOORD_0 so the technical UV
    // checker can sample UV space and deforms with the mesh. It is consumed
    // only when the opt-in uv-checker visualization is enabled.
    const uv = read(primitive.uv, Float32Array);
    const uvBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    const IndexType = primitive.indices.accessor.componentType === 5123 ? Uint16Array : Uint32Array;
    const indices = read(primitive.indices, IndexType);
    const indexBuffer = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    // Deterministic wireframe index buffer generated from the existing triangle
    // indices at upload time: one LINES pair per triangle edge (shared edges
    // repeat, which is intentional and bounded). The wireframe VAO shares the
    // same position buffer, so Basis Lab CPU deformation applies to it too.
    const wireIndices = new IndexType(indices.length * 2);
    for (let index = 0, out = 0; index < indices.length; index += 3) {
      const a = indices[index];
      const b = indices[index + 1];
      const c = indices[index + 2];
      wireIndices[out++] = a; wireIndices[out++] = b;
      wireIndices[out++] = b; wireIndices[out++] = c;
      wireIndices[out++] = c; wireIndices[out++] = a;
    }
    const wireVao = gl.createVertexArray(); gl.bindVertexArray(wireVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const wireBuffer = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wireBuffer); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, wireIndices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const result = { vao, positionBuffer, basePosition: position, indexCount: indices.length, indexType: primitive.indices.accessor.componentType === 5123 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT, materialIndex: asset.primitives.indexOf(primitive), vertexOffset: basisLab ? vertexOffset : 0, wireVao, wireIndexCount: wireIndices.length };
    vertexOffset += position.length / 3;
    return result;
  });
  return { primitives };
}

function resizeCanvas(canvas, gl) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio || canvas.width));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio || canvas.height));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  gl.viewport(0, 0, width, height);
  return width / height;
}

function draw(canvas, asset, resources, weights) {
  const gl = resources.gl;
  const aspect = resizeCanvas(canvas, gl);
  gl.useProgram(resources.program);
  gl.bindVertexArray(resources.vao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, resources.texture);
  gl.uniform1i(resources.uniforms.texture, 0);
  gl.uniform1fv(resources.uniforms.weights, weights);
  gl.uniform2f(resources.uniforms.textureSize, resources.textureSize[0], resources.textureSize[1]);
  gl.uniformMatrix4fv(resources.uniforms.projection, false, buildWebglProjection(asset.bounds, aspect, asset.morphDisplacementBound));
  gl.uniformMatrix4fv(resources.uniforms.camera, false, buildWebglCameraMatrix(asset.bounds, aspect, resources.camera, asset.morphDisplacementBound));
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.clearDepth(1);
  // Winding is mixed in the retained geometry; two-sided depth-tested drawing is intentional.
  gl.disable(gl.CULL_FACE);
  gl.frontFace(gl.CCW);
  gl.clearColor(0.035, 0.05, 0.075, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.drawElements(gl.TRIANGLES, resources.indexCount, gl.UNSIGNED_INT, 0);
  if (gl.getError() !== gl.NO_ERROR) fail("WebGL resource or draw error");
  return {
    viewport: [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight],
    aspect,
    depthTest: true,
    culling: { enabled: false, mode: "two-sided", reason: "retained mesh has mixed triangle winding" },
    weightLimit: WEBGL_MORPH_WEIGHT_LIMIT,
    maxWeight: Math.max(...weights.map((value) => Math.abs(value))),
    morphDisplacementBound: asset.morphDisplacementBound,
    framebufferStatus: gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE ? "complete" : "incomplete",
    camera: { ...resources.camera },
  };
}

function drawOfficial(canvas, asset, resources, coefficients = null) {
  const gl = resources.gl;
  const activeCoefficients = resources.basisLab
    ? (coefficients || new Array(8).fill(0)).map(clampBasisCoefficient)
    : [];
  const aspect = resizeCanvas(canvas, gl);
  const visualization = describeTechnicalVisualization(resources.technicalVisualization);
  const visualizationFlags = technicalVisualizationFlags(visualization.technicalVisualization);
  gl.useProgram(resources.program);
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.clearDepth(1); gl.disable(gl.CULL_FACE);
  gl.clearColor(0.035, 0.05, 0.075, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const projection = buildWebglProjection(asset.bounds, aspect);
  const camera = buildWebglCameraMatrix(asset.bounds, aspect, resources.camera);
   gl.uniformMatrix4fv(resources.uniforms.projection, false, projection);
   gl.uniformMatrix4fv(resources.uniforms.camera, false, camera);
   gl.uniform4fv(resources.uniforms.baseColors, OFFICIAL_MATERIAL_PALETTE.flatMap((material) => [...material.baseColor, 1]));
   gl.uniform1fv(resources.uniforms.perceptualRoughness, OFFICIAL_MATERIAL_PALETTE.map((material) => material.perceptualRoughness));
   gl.uniform1fv(resources.uniforms.specularStrength, OFFICIAL_MATERIAL_PALETTE.map((material) => material.specularStrength));
  // Technical visualization state: solid pass first, wireframe second pass after.
  gl.uniform1i(resources.uniforms.uvCheckerEnabled, visualizationFlags.uvChecker ? 1 : 0);
  gl.uniform1i(resources.uniforms.wireframePass, 0);
  gl.uniform1f(resources.uniforms.checkerDensity, OFFICIAL_UV_CHECKER_DENSITY);
  gl.uniform3fv(resources.uniforms.inspectionColor, OFFICIAL_WIREFRAME_COLOR);
  for (const primitive of resources.primitives) {
    if (resources.basisLab) {
      const positions = new Float32Array(primitive.basePosition);
      for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
        const globalVertex = primitive.vertexOffset + vertex;
        for (let vector = 0; vector < 8; vector += 1) {
          const coefficient = activeCoefficients[vector];
          if (!coefficient) continue;
          const basisOffset = resources.basisLab.vectorOffset + (vector * resources.basisLab.vertexCount + globalVertex) * 12;
          positions[vertex * 3] += new DataView(resources.basisLab.payload.buffer, resources.basisLab.payload.byteOffset + basisOffset, 12).getFloat32(0, true) * coefficient;
          positions[vertex * 3 + 1] += new DataView(resources.basisLab.payload.buffer, resources.basisLab.payload.byteOffset + basisOffset, 12).getFloat32(4, true) * coefficient;
          positions[vertex * 3 + 2] += new DataView(resources.basisLab.payload.buffer, resources.basisLab.payload.byteOffset + basisOffset, 12).getFloat32(8, true) * coefficient;
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, primitive.positionBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
    }
    gl.bindVertexArray(primitive.vao);
    gl.uniform1i(resources.uniforms.materialIndex, primitive.materialIndex);
    gl.drawElements(gl.TRIANGLES, primitive.indexCount, primitive.indexType, 0);
  }
  if (visualizationFlags.wireframe) {
    // Second pass: triangle edges over the shaded surface. Depth testing stays
    // enabled (LEQUAL) so only edges at or in front of the surface draw; the
    // two-sided solid pass above is not cleared. No culling is enabled, which
    // preserves the existing mixed-winding behavior.
    gl.uniform1i(resources.uniforms.uvCheckerEnabled, 0);
    gl.uniform1i(resources.uniforms.wireframePass, 1);
    for (const primitive of resources.primitives) {
      gl.bindVertexArray(primitive.wireVao);
      gl.drawElements(gl.LINES, primitive.wireIndexCount, primitive.indexType, 0);
    }
    gl.uniform1i(resources.uniforms.wireframePass, 0);
  }
  gl.bindVertexArray(null);
  if (gl.getError() !== gl.NO_ERROR) fail("official WebGL resource or draw error");
  const official = asset.json.extras.sportsFaceGnmOfficial;
  return { viewport: [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight], aspect, depthTest: true, culling: { enabled: false, mode: "two-sided", reason: "retained mesh has mixed triangle winding" }, components: resources.primitives.length, materials: resources.primitives.length, officialTexturesIncluded: false, renderOnly: official.renderOnly === true, basisIncluded: resources.basisLab !== null, identityCount: resources.basisLab ? 4 : 0, expressionCount: resources.basisLab ? 4 : 0, selectedVectors: resources.basisLab?.metadata.selection ? [...resources.basisLab.metadata.selection.identity, ...resources.basisLab.metadata.selection.expression] : [], activeCoefficients, semanticMapping: "disabled", runtimeBasisLoaded: resources.basisLab !== null, assetSchema: official.schema, materialModel: OFFICIAL_MATERIAL_MODEL_VERSION, materialModelVersion: OFFICIAL_MATERIAL_MODEL_VERSION, lighting: { ...OFFICIAL_LIGHTING_FEATURES }, componentMaterialInfo: materialDiagnostics(), ...visualization, uvCheckerDensity: OFFICIAL_UV_CHECKER_DENSITY, wireframeColor: [...OFFICIAL_WIREFRAME_COLOR], wireframeEdgeCount: resources.primitives.reduce((total, primitive) => total + primitive.wireIndexCount / 2, 0), mapping: resources.basisLab ? "technical basis coefficients only; semantic mapping disabled" : "neutral-template-only; identity/expression semantic mapping disabled", camera: { ...resources.camera }, framebufferStatus: gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE ? "complete" : "incomplete" };
}

function redraw(canvas, state) {
  canvas.__sportsFaceWebglDiagnostics = state.asset.official
    ? drawOfficial(canvas, state.asset, state, state.basisCoefficients)
    : draw(canvas, state.asset, state, state.weights);
}

function attachCameraControls(canvas, state) {
  if (state.cameraControlsAttached) return;
  state.cameraControlsAttached = true;
  let pointer = null;
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    state.camera = clampWebglCamera({
      yaw: state.camera.yaw + (event.clientX - pointer.x) * 0.012,
      pitch: state.camera.pitch + (event.clientY - pointer.y) * 0.012,
      distance: state.camera.distance,
    });
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    redraw(canvas, state);
  });
  const releasePointer = (event) => {
    if (pointer?.id === event.pointerId) pointer = null;
  };
  canvas.addEventListener("pointerup", releasePointer);
  canvas.addEventListener("pointercancel", releasePointer);
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    state.camera = clampWebglCamera({
      ...state.camera,
      distance: state.camera.distance * Math.exp(event.deltaY * 0.001),
    });
    redraw(canvas, state);
  }, { passive: false });
}

export function resetWebglCamera(canvas) {
  const state = canvasState.get(canvas);
  if (!state) return { ...DEFAULT_WEBGL_CAMERA };
  state.camera = { ...DEFAULT_WEBGL_CAMERA };
  redraw(canvas, state);
  return { ...state.camera };
}

function fallback(canvas, profile, options, reason) {
  const target = options.fallbackCanvas || canvas;
  return renderGnmMorphFace(target, profile, options).then(() => ({ canvas: target, fallback: true, reason: reason || DEFAULT_FALLBACK_MESSAGE }));
}

export function renderWebglFace(canvas, profile, options = {}) {
  const basisLab = options.basisLab === true;
  const official = options.official === true || basisLab || options.assetUrl === WEBGL_OFFICIAL_ASSET_URL;
  const assetUrl = options.assetUrl || (official ? WEBGL_OFFICIAL_ASSET_URL : WEBGL_MORPH_ASSET_URL);
  const fallbackOptions = { ...options };
  delete fallbackOptions.assetUrl;
  return Promise.resolve().then(async () => {
    if (!canvas || typeof canvas.getContext !== "function") return fallback(canvas, profile, fallbackOptions, "WebGL canvas is unavailable");
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: true, preserveDrawingBuffer: true });
    if (!gl) return fallback(canvas, profile, fallbackOptions, "WebGL2 context is unavailable");
    const asset = await fetchAsset(assetUrl);
    const basis = basisLab ? await fetchBasisLab() : null;
    let state = canvasState.get(canvas);
    if (!state || state.asset !== asset || state.gl !== gl || state.basisLab !== basis) {
      const webglProgram = asset.official ? officialProgram(gl) : program(gl);
      const resources = asset.official ? uploadOfficial(gl, asset, basis) : upload(gl, asset);
      state = { asset, gl, basisLab: basis, ...resources, program: webglProgram, camera: { ...DEFAULT_WEBGL_CAMERA }, basisCoefficients: basis ? new Array(8).fill(0) : null, weights: mapWebglWeights(profile), technicalVisualization: TECHNICAL_VISUALIZATION_NONE, uniforms: {
        texture: gl.getUniformLocation(webglProgram, "uMorphDeltas"),
        weights: gl.getUniformLocation(webglProgram, "uWeights"),
        textureSize: gl.getUniformLocation(webglProgram, "uTextureSize"),
        projection: gl.getUniformLocation(webglProgram, "uProjection"),
        camera: gl.getUniformLocation(webglProgram, "uCamera"),
         materialIndex: gl.getUniformLocation(webglProgram, "uMaterialIndex"),
         baseColors: gl.getUniformLocation(webglProgram, "uBaseColors"),
         perceptualRoughness: gl.getUniformLocation(webglProgram, "uPerceptualRoughness"),
         specularStrength: gl.getUniformLocation(webglProgram, "uSpecularStrength"),
         uvCheckerEnabled: gl.getUniformLocation(webglProgram, "uUvCheckerEnabled"),
         wireframePass: gl.getUniformLocation(webglProgram, "uWireframePass"),
         inspectionColor: gl.getUniformLocation(webglProgram, "uInspectionColor"),
         checkerDensity: gl.getUniformLocation(webglProgram, "uCheckerDensity"),
      } };
      canvasState.set(canvas, state);
    }
    attachCameraControls(canvas, state);
    state.weights = mapWebglWeights(profile);
    if (basis && options.basisCoefficients) state.basisCoefficients = options.basisCoefficients.map(clampBasisCoefficient);
    // Technical visualization toggles are session state only: they never touch
    // FaceDNA/SF2 and default OFF. The value survives camera redraws because it
    // lives on the per-canvas state object.
    if (options.technicalVisualization !== undefined) state.technicalVisualization = clampTechnicalVisualization(options.technicalVisualization);
    const diagnostics = asset.official ? drawOfficial(canvas, asset, state, state.basisCoefficients) : draw(canvas, asset, state, state.weights);
    canvas.__sportsFaceWebglDiagnostics = diagnostics;
    return { canvas, fallback: false, renderer: basisLab ? WEBGL_OFFICIAL_BASIS_LAB_STYLE : asset.official ? WEBGL_OFFICIAL_RENDER_STYLE : WEBGL_MORPH_RENDER_STYLE, diagnostics };
  }).catch((error) => fallback(canvas, profile, fallbackOptions, error instanceof Error ? error.message : String(error)));
}
