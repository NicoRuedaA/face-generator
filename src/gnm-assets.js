/* GNM GLB loading and integrity utilities. SPDX-License-Identifier: GPL-2.0-only */
export const WEBGL_OFFICIAL_ASSET_URL = "./tools/gnm/work/gnm-official-head-render.glb";
export const OFFICIAL_COMPONENT_NAMES = Object.freeze([
  "skin", "left_eye", "right_eye", "upper_teeth_and_gums", "lower_teeth_and_gums", "tongue",
]);
export const WEBGL_CAMERA_LIMITS = Object.freeze({
  yaw: [-Math.PI, Math.PI],
  pitch: [-1.15, 1.15],
  distance: [0.72, 1.65],
});
function fail(message) { throw new Error(message); }
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

export async function sha256Bytes(bytes) {
  if (globalThis.crypto?.subtle?.digest) return sha256Hex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return sha256BytesFallback(bytes);
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

export function parseWebglGlb(data) {
  const { json, binary } = parseGlb(data);
  if (json.extras?.sportsFaceGnmOfficial?.schema !== "sports-face-gnm-official-head/v1") fail("Expected an official GNM GLB");
  return parseOfficialAsset(json, binary);
}
