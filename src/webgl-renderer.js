/* Dependency-free WebGL2 prototype for the geometry-derived GNM morph GLB. */
import { getFaceValues, hashSeed } from "./face-model.js";
import { renderGnmMorphFace } from "./morph-renderer.js";

export const WEBGL_MORPH_RENDER_STYLE = "sports/morph-webgl-v1";
export const WEBGL_MORPH_ASSET_URL = "./tools/gnm/work/head-morph.glb";
const TARGET_COUNT = 16;
const DEFAULT_FALLBACK_MESSAGE = "WebGL2 no disponible; se ha usado el renderer GNM SVG.";
const assetCache = new Map();
const canvasState = new WeakMap();

function fail(message) { throw new Error(message); }
function finite(value) { return Number.isFinite(value); }

export function mapWebglWeights(profile) {
  const values = getFaceValues(profile);
  const identity = [values.head, values.jaw, values.faceProportion, values.eyes, values.brows, values.nose, values.mouth, values.earShape];
  const appearance = [values.hair, values.beard, values.hairColor, values.glasses, values.scar];
  const seed = hashSeed(`${profile.seed}:${profile.identityBits >>> 0}:${profile.appearanceBits >>> 0}`);
  const weights = [];
  for (let index = 0; index < TARGET_COUNT; index += 1) {
    const identityValue = identity[index % identity.length] / 5;
    const appearanceValue = appearance[index % appearance.length] / 11;
    const phase = ((seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0) / 0x100000000;
    const raw = (identityValue - 0.5) * 0.42 + (appearanceValue - 0.35) * 0.12 + (phase - 0.5) * 0.18;
    weights.push(Math.max(-0.75, Math.min(0.75, raw)));
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
      inputs: ["FaceDNA identityBits", "FaceDNA appearanceBits", "seed"],
      method: "bounded deterministic hash plus normalized FaceDNA slots; each component is clamped to [-0.75, 0.75]",
      note: "PCA component directions and neutral IDs are geometry-derived and are not interpreted as semantic facial controls.",
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
  const finiteView = (entry) => {
    const values = new Float32Array(binary.buffer.slice(binary.byteOffset + entry.offset, binary.byteOffset + entry.offset + entry.view.byteLength));
    if (!values.every(finite)) fail("GLB contains non-finite morph data");
  };
  finiteView(position);
  targets.forEach(finiteView);
  return { json, binary, vertexCount, position, indices, targets, bounds };
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
    out vec3 vPosition;
    void main() {
      vec3 position = aPosition;
      for (int index = 0; index < 16; index++) {
        int x = gl_VertexID % int(uTextureSize.x);
        int y = gl_VertexID / int(uTextureSize.x);
        position += texelFetch(uMorphDeltas, ivec3(x, y, index), 0).xyz * uWeights[index];
      }
      vPosition = position;
      gl_Position = uProjection * vec4(position, 1.0);
    }`);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float;
    in vec3 vPosition;
    out vec4 color;
    void main() {
      vec3 normal = normalize(cross(dFdx(vPosition), dFdy(vPosition)));
      vec3 light = normalize(vec3(-0.35, 0.65, 0.85));
      float diffuse = 0.52 + 0.48 * abs(dot(normal, light));
      color = vec4(vec3(0.72, 0.55, 0.43) * diffuse, 1.0);
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

function projection(bounds, aspect) {
  const center = bounds.min.map((value, index) => (value + bounds.max[index]) / 2);
  const size = bounds.max.map((value, index) => value - bounds.min[index]);
  const height = Math.max(size[1], size[0] / Math.max(aspect, 0.01), size[2]) * 1.12;
  const width = height * aspect;
  const depth = Math.max(size[2] * 2, 1);
  return new Float32Array([
    2 / width, 0, 0, 0, 0, 2 / height, 0, 0, 0, 0, -2 / depth, 0,
    -2 * center[0] / width, -2 * center[1] / height, -center[2] / depth, 1,
  ]);
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
  gl.uniformMatrix4fv(resources.uniforms.projection, false, projection(asset.bounds, aspect));
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.06, 0.08, 0.11, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.drawElements(gl.TRIANGLES, resources.indexCount, gl.UNSIGNED_INT, 0);
  if (gl.getError() !== gl.NO_ERROR) fail("WebGL resource or draw error");
}

function fallback(canvas, profile, options, reason) {
  const target = options.fallbackCanvas || canvas;
  return renderGnmMorphFace(target, profile, options).then(() => ({ canvas: target, fallback: true, reason: reason || DEFAULT_FALLBACK_MESSAGE }));
}

export function renderWebglFace(canvas, profile, options = {}) {
  const assetUrl = options.assetUrl || WEBGL_MORPH_ASSET_URL;
  const fallbackOptions = { ...options };
  delete fallbackOptions.assetUrl;
  return Promise.resolve().then(async () => {
    if (!canvas || typeof canvas.getContext !== "function") return fallback(canvas, profile, fallbackOptions, "WebGL canvas is unavailable");
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: true });
    if (!gl) return fallback(canvas, profile, fallbackOptions, "WebGL2 context is unavailable");
    const asset = await fetchAsset(assetUrl);
    let state = canvasState.get(canvas);
    if (!state || state.asset !== asset || state.gl !== gl) {
      const webglProgram = program(gl);
      const resources = upload(gl, asset);
      state = { asset, gl, ...resources, program: webglProgram, uniforms: {
        texture: gl.getUniformLocation(webglProgram, "uMorphDeltas"),
        weights: gl.getUniformLocation(webglProgram, "uWeights"),
        textureSize: gl.getUniformLocation(webglProgram, "uTextureSize"),
        projection: gl.getUniformLocation(webglProgram, "uProjection"),
      } };
      canvasState.set(canvas, state);
    }
    draw(canvas, asset, state, mapWebglWeights(profile));
    return { canvas, fallback: false, renderer: WEBGL_MORPH_RENDER_STYLE };
  }).catch((error) => fallback(canvas, profile, fallbackOptions, error instanceof Error ? error.message : String(error)));
}
