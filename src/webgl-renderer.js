/* Dependency-free WebGL2 prototype for the geometry-derived GNM morph GLB. */
import { getFaceValues, hashSeed } from "./face-model.js";
import { renderGnmMorphFace } from "./morph-renderer.js";

export const WEBGL_MORPH_RENDER_STYLE = "sports/morph-webgl-v1";
export const WEBGL_MORPH_ASSET_URL = "./tools/gnm/work/head-morph.glb";
export const WEBGL_OFFICIAL_RENDER_STYLE = "sports/morph-webgl-official-v1";
export const WEBGL_OFFICIAL_ASSET_URL = "./tools/gnm/work/gnm-official-head.glb";
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

export function describeOfficialWebglMapping() {
  return {
    renderer: WEBGL_OFFICIAL_RENDER_STYLE,
    prototype: true,
    source: "official GNM Head v3.0 template and basis metadata",
    targetSemantics: "neutral official template; no semantic basis mapping",
    officialTexturesIncluded: false,
    mapping: {
      identityOnly: true,
      applied: false,
      identityBasis: "disabled: official head_/eyes_/teeth_ names do not safely map to FaceDNA variables",
      expressionBasis: "disabled: regional expression names do not safely map to application expression modes",
      identityInvariant: true,
    },
  };
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

function accessorView(json, binary, accessorIndex, componentType, type) {
  const accessor = json.accessors?.[accessorIndex];
  const view = json.bufferViews?.[accessor?.bufferView];
  const componentCount = type === "VEC3" ? 3 : type === "VEC2" ? 2 : 1;
  if (!accessor || !view || accessor.componentType !== componentType || accessor.type !== type) fail(`invalid official accessor ${accessorIndex}`);
  const offset = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const bytes = accessor.count * componentCount * 4;
  if (offset % 4 !== 0 || view.byteLength !== bytes || offset + bytes > binary.byteLength) fail(`invalid official bufferView ${accessorIndex}`);
  return { accessor, view, offset };
}

function parseOfficialAsset(json, binary) {
  if (json.asset?.version !== "2.0" || json.scene !== 0 || json.scenes?.length !== 1 || json.nodes?.length !== 1 || json.meshes?.length !== 1) fail("official GLB scene structure is unsupported");
  const mesh = json.meshes[0];
  const names = ["skin", "left_eye", "right_eye", "upper_teeth_and_gums", "lower_teeth_and_gums", "tongue"];
  if (mesh.primitives?.length !== names.length || json.materials?.length !== names.length || json.buffers?.[0]?.byteLength !== binary.byteLength) fail("official GLB component structure is invalid");
  const primitives = mesh.primitives.map((primitive, index) => {
    if (primitive.mode !== 4 || primitive.material !== index || primitive.extras?.componentName !== names[index]) fail("official GLB component order is invalid");
    const position = accessorView(json, binary, primitive.attributes?.POSITION, 5126, "VEC3");
    const uv = accessorView(json, binary, primitive.attributes?.TEXCOORD_0, 5126, "VEC2");
    const indices = accessorView(json, binary, primitive.indices, 5125, "SCALAR");
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
  if (official.basis?.identity?.count !== 253 || official.basis?.expression?.count !== 383 || official.mapping?.identity?.applied !== false || official.mapping?.expression?.applied !== false) fail("official basis or mapping metadata is unsafe");
  return { official: true, json, binary, primitives, bounds, morphDisplacementBound: [0, 0, 0], vertexCount: 17821 };
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
    uniform mat4 uProjection;
    uniform mat4 uCamera;
    out vec3 vPosition;
    void main() { vPosition = aPosition; gl_Position = uProjection * uCamera * vec4(aPosition, 1.0); }`);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float;
    uniform vec4 uColor;
    in vec3 vPosition;
    out vec4 color;
    void main() {
      vec3 normal = normalize(cross(dFdx(vPosition), dFdy(vPosition)));
      normal = faceforward(normal, vec3(0.0, 0.0, -1.0), normal);
      vec3 keyLight = normalize(vec3(-0.45, 0.72, 1.0));
      vec3 fillLight = normalize(vec3(0.70, 0.15, 0.55));
      float diffuse = max(dot(normal, keyLight), 0.0);
      float fill = max(dot(normal, fillLight), 0.0);
      color = vec4(uColor.rgb * (0.24 + 0.58 * diffuse + 0.16 * fill), uColor.a);
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

function uploadOfficial(gl, asset) {
  const read = (entry, Type) => new Type(asset.binary.buffer.slice(asset.binary.byteOffset + entry.offset, asset.binary.byteOffset + entry.offset + entry.view.byteLength));
  const primitives = asset.primitives.map((primitive) => {
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const position = read(primitive.position, Float32Array);
    const positionBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer); gl.bufferData(gl.ARRAY_BUFFER, position, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const indices = read(primitive.indices, Uint32Array);
    const indexBuffer = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, indexCount: indices.length, color: primitive.color };
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

function drawOfficial(canvas, asset, resources) {
  const gl = resources.gl;
  const aspect = resizeCanvas(canvas, gl);
  gl.useProgram(resources.program);
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.clearDepth(1); gl.disable(gl.CULL_FACE);
  gl.clearColor(0.035, 0.05, 0.075, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const projection = buildWebglProjection(asset.bounds, aspect);
  const camera = buildWebglCameraMatrix(asset.bounds, aspect, resources.camera);
  gl.uniformMatrix4fv(resources.uniforms.projection, false, projection);
  gl.uniformMatrix4fv(resources.uniforms.camera, false, camera);
  for (const primitive of resources.primitives) {
    gl.bindVertexArray(primitive.vao);
    gl.uniform4fv(resources.uniforms.color, primitive.color);
    gl.drawElements(gl.TRIANGLES, primitive.indexCount, gl.UNSIGNED_INT, 0);
  }
  gl.bindVertexArray(null);
  if (gl.getError() !== gl.NO_ERROR) fail("official WebGL resource or draw error");
  return { viewport: [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight], aspect, depthTest: true, components: resources.primitives.length, materials: resources.primitives.length, officialTexturesIncluded: false, mapping: "neutral-template-only; identity/expression semantic mapping disabled", camera: { ...resources.camera }, framebufferStatus: gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE ? "complete" : "incomplete" };
}

function redraw(canvas, state) {
  canvas.__sportsFaceWebglDiagnostics = state.asset.official
    ? drawOfficial(canvas, state.asset, state)
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
  const official = options.official === true || options.assetUrl === WEBGL_OFFICIAL_ASSET_URL;
  const assetUrl = options.assetUrl || (official ? WEBGL_OFFICIAL_ASSET_URL : WEBGL_MORPH_ASSET_URL);
  const fallbackOptions = { ...options };
  delete fallbackOptions.assetUrl;
  return Promise.resolve().then(async () => {
    if (!canvas || typeof canvas.getContext !== "function") return fallback(canvas, profile, fallbackOptions, "WebGL canvas is unavailable");
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: true, preserveDrawingBuffer: true });
    if (!gl) return fallback(canvas, profile, fallbackOptions, "WebGL2 context is unavailable");
    const asset = await fetchAsset(assetUrl);
    let state = canvasState.get(canvas);
    if (!state || state.asset !== asset || state.gl !== gl) {
      const webglProgram = asset.official ? officialProgram(gl) : program(gl);
      const resources = asset.official ? uploadOfficial(gl, asset) : upload(gl, asset);
      state = { asset, gl, ...resources, program: webglProgram, camera: { ...DEFAULT_WEBGL_CAMERA }, weights: mapWebglWeights(profile), uniforms: {
        texture: gl.getUniformLocation(webglProgram, "uMorphDeltas"),
        weights: gl.getUniformLocation(webglProgram, "uWeights"),
        textureSize: gl.getUniformLocation(webglProgram, "uTextureSize"),
        projection: gl.getUniformLocation(webglProgram, "uProjection"),
        camera: gl.getUniformLocation(webglProgram, "uCamera"),
        color: gl.getUniformLocation(webglProgram, "uColor"),
      } };
      canvasState.set(canvas, state);
    }
    attachCameraControls(canvas, state);
    state.weights = mapWebglWeights(profile);
    const diagnostics = asset.official ? drawOfficial(canvas, asset, state) : draw(canvas, asset, state, state.weights);
    canvas.__sportsFaceWebglDiagnostics = diagnostics;
    return { canvas, fallback: false, renderer: asset.official ? WEBGL_OFFICIAL_RENDER_STYLE : WEBGL_MORPH_RENDER_STYLE, diagnostics };
  }).catch((error) => fallback(canvas, profile, fallbackOptions, error instanceof Error ? error.message : String(error)));
}
