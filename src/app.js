/* Sports Face MVP UI - SPDX-License-Identifier: GPL-2.0-only */

import {
  FACE_VARS,
  ageProfile,
  cloneProfile,
  createProfile,
  describeProfile,
  formatFaceCode,
  getFaceValues,
  hashSeed,
  parseFaceCode,
  setFeature,
  setKit,
  setPresentation,
} from "./face-model.js";
import {
  DEFAULT_RENDER_STYLE,
  GNM_MORPH_RENDER_STYLE,
  MORPH_RENDER_STYLE,
  RENDER_STYLES,
  TOON_RENDER_STYLE,
  WEBGL_MORPH_RENDER_STYLE,
  describeRender,
  downloadPng,
  resetWebglCamera,
  renderPortrait,
} from "./render-router.js";

const canvas = document.querySelector("#portrait");
const webglCanvas = document.querySelector("#portrait-webgl");
const webglCameraControls = document.querySelector("#webgl-camera-controls");
const gallery = document.querySelector("#gallery");
const seedInput = document.querySelector("#seed");
const ageInput = document.querySelector("#age");
const ageValue = document.querySelector("#age-value");
const presentationInput = document.querySelector("#presentation");
const kitPrimary = document.querySelector("#kit-primary");
const kitSecondary = document.querySelector("#kit-secondary");
const faceCode = document.querySelector("#face-code");
const debugOutput = document.querySelector("#debug-output");
const featureControls = document.querySelector("#feature-controls");
const toast = document.querySelector("#toast");
const renderStyleInput = document.querySelector("#render-style");
const expressionModeField = document.querySelector("#expression-mode-field");
const expressionModeInput = document.querySelector("#expression-mode");
const toonAttribution = document.querySelector("#toon-attribution");
const landmarksInput = document.querySelector("#show-landmarks");
const landmarkField = document.querySelector("#landmark-field");
const EXPRESSION_MODE_STORAGE_KEY = "sports-face-expression-mode";
const EXPRESSION_MODES = ["auto", "neutral", "alert", "soft", "focused"];

let profile = createProfile({ seed: Date.now(), age: 22, presentation: "neutral" });
function loadRenderStyle() {
  try {
    const saved = window.localStorage.getItem("sports-face-render-style");
    return RENDER_STYLES.some((style) => style.id === saved) ? saved : DEFAULT_RENDER_STYLE;
  } catch {
    return DEFAULT_RENDER_STYLE;
  }
}
let renderStyle = loadRenderStyle();
function loadExpressionMode() {
  try {
    const saved = window.localStorage.getItem(EXPRESSION_MODE_STORAGE_KEY);
    return EXPRESSION_MODES.includes(saved) ? saved : "auto";
  } catch {
    return "auto";
  }
}
let expressionMode = loadExpressionMode();
function loadLandmarkPreference() {
  try { return window.localStorage.getItem("sports-face-show-landmarks") === "1"; }
  catch { return false; }
}
let showLandmarks = loadLandmarkPreference();
let mainRenderPromise = Promise.resolve(canvas);
let renderRevision = 0;
let toastTimer = null;

function showToast(message, type = "ok") {
  toast.textContent = message;
  toast.dataset.type = type;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2400);
}

function populateRenderStyles() {
  renderStyleInput.innerHTML = "";
  for (const style of RENDER_STYLES) {
    const option = document.createElement("option");
    option.value = style.id;
    option.textContent = style.label;
    renderStyleInput.append(option);
  }
}

function populateFeatureControls() {
  featureControls.innerHTML = "";
  for (const variable of FACE_VARS) {
    const wrapper = document.createElement("label");
    wrapper.className = "field compact";
    const text = document.createElement("span");
    text.textContent = `${variable.domain === "identity" ? "Identidad" : "Apariencia"} · ${variable.label}`;
    const select = document.createElement("select");
    select.dataset.feature = variable.key;
    for (let index = 0; index < variable.validValues; index += 1) {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = variable.type === "toggle" ? (index === 0 ? "No" : "Sí") : `${index + 1}`;
      select.append(option);
    }
    select.addEventListener("change", () => {
      profile = setFeature(profile, variable.key, Number(select.value));
      refresh({ rebuildGallery: false });
    });
    wrapper.append(text, select);
    featureControls.append(wrapper);
  }
}

function syncControls() {
  seedInput.value = String(profile.seed >>> 0);
  ageInput.value = String(profile.age);
  ageValue.textContent = `${profile.age}`;
  presentationInput.value = profile.presentation;
  kitPrimary.value = profile.kit.primary;
  kitSecondary.value = profile.kit.secondary;
  faceCode.value = formatFaceCode(profile);

  const values = getFaceValues(profile);
  for (const select of featureControls.querySelectorAll("select[data-feature]")) {
    select.value = String(values[select.dataset.feature]);
  }
  debugOutput.textContent = JSON.stringify({
    ...describeProfile(profile),
    selectedRenderer: renderStyle,
    selectedExpressionMode: expressionMode,
    renderMapping: describeRender(profile, renderStyle, { expressionMode }),
  }, null, 2);
  renderStyleInput.value = renderStyle;
  expressionModeInput.value = expressionMode;
   toonAttribution.hidden = ![TOON_RENDER_STYLE, MORPH_RENDER_STYLE, GNM_MORPH_RENDER_STYLE].includes(renderStyle);
   landmarkField.hidden = ![MORPH_RENDER_STYLE, GNM_MORPH_RENDER_STYLE].includes(renderStyle);
   expressionModeField.hidden = ![MORPH_RENDER_STYLE, GNM_MORPH_RENDER_STYLE].includes(renderStyle);
  landmarksInput.checked = showLandmarks;
}

function renderGallery() {
  gallery.innerHTML = "";
  for (let index = 0; index < 12; index += 1) {
    const itemProfile = createProfile({
      seed: hashSeed(`${profile.seed}:gallery:${index}`),
      age: 17 + ((profile.age + index * 3) % 25),
      presentation: ["masculine", "feminine", "neutral"][index % 3],
    });
    const button = document.createElement("button");
    button.className = "gallery-item";
    button.type = "button";
    button.title = "Usar este jugador";
    const miniCanvas = document.createElement("canvas");
    miniCanvas.width = 192;
    miniCanvas.height = 192;
     const galleryStyle = renderStyle === WEBGL_MORPH_RENDER_STYLE ? GNM_MORPH_RENDER_STYLE : renderStyle;
     renderPortrait(miniCanvas, itemProfile, { style: galleryStyle, expressionMode, showAge: false, showLandmarks: false }).catch((error) => showToast(error.message, "error"));
    button.append(miniCanvas);
    button.addEventListener("click", () => {
      profile = cloneProfile(itemProfile);
      refresh({ rebuildGallery: false });
      showToast("Jugador cargado");
    });
    gallery.append(button);
  }
}

function refresh({ rebuildGallery = true } = {}) {
  const revision = ++renderRevision;
  if (renderStyle !== WEBGL_MORPH_RENDER_STYLE) {
    webglCanvas.hidden = true;
    canvas.hidden = false;
    webglCameraControls.hidden = true;
  }
  const targetCanvas = renderStyle === WEBGL_MORPH_RENDER_STYLE ? webglCanvas : canvas;
  mainRenderPromise = renderPortrait(targetCanvas, profile, {
    style: renderStyle,
    expressionMode,
    showLandmarks,
    fallbackCanvas: canvas,
  }).then((result) => {
    if (revision !== renderRevision) return result;
    if (renderStyle === WEBGL_MORPH_RENDER_STYLE) {
      const usedFallback = result?.fallback === true;
      webglCanvas.hidden = usedFallback;
      canvas.hidden = !usedFallback;
      webglCameraControls.hidden = usedFallback;
      if (usedFallback) showToast(`WebGL2 fallback: ${result.reason}`, "error");
    }
    return result;
  }).catch((error) => { showToast(error.message, "error"); throw error; });
  syncControls();
  if (rebuildGallery) renderGallery();
}

document.querySelector("#reset-webgl-camera").addEventListener("click", () => {
  resetWebglCamera(webglCanvas);
  showToast("Cámara restablecida");
});

function newPlayer() {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  profile = createProfile({ seed, age: Number(ageInput.value), presentation: presentationInput.value });
  refresh();
  showToast("Nuevo jugador generado");
}

document.querySelector("#new-player").addEventListener("click", newPlayer);

document.querySelector("#apply-seed").addEventListener("click", () => {
  profile = createProfile({
    seed: hashSeed(seedInput.value),
    age: Number(ageInput.value),
    presentation: presentationInput.value,
  });
  profile = setKit(profile, kitPrimary.value, kitSecondary.value);
  refresh();
  showToast("Semilla aplicada");
});

document.querySelector("#age-five").addEventListener("click", () => {
  profile = ageProfile(profile, 5);
  refresh({ rebuildGallery: false });
  showToast("Retrato envejecido 5 años");
});

document.querySelector("#copy-code").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(formatFaceCode(profile));
    showToast("Código facial copiado");
  } catch {
    faceCode.select();
    document.execCommand("copy");
    showToast("Código facial copiado");
  }
});

document.querySelector("#load-code").addEventListener("click", () => {
  try {
    profile = parseFaceCode(faceCode.value);
    refresh();
    showToast("Código facial cargado");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Código inválido", "error");
  }
});

document.querySelector("#download-png").addEventListener("click", async () => {
  await mainRenderPromise;
  downloadPng(renderStyle === WEBGL_MORPH_RENDER_STYLE && !webglCanvas.hidden ? webglCanvas : canvas, `sports-face-${renderStyle.split("/").pop()}-${profile.seed}.png`);
  showToast("PNG preparado");
});

ageInput.addEventListener("input", () => {
  profile = ageProfile(profile, Number(ageInput.value) - profile.age);
  refresh({ rebuildGallery: false });
});

presentationInput.addEventListener("change", () => {
  profile = setPresentation(profile, presentationInput.value, { rerollAppearance: true });
  profile = setKit(profile, kitPrimary.value, kitSecondary.value);
  refresh();
  showToast("Presentación actualizada; la identidad se conserva");
});

renderStyleInput.addEventListener("change", () => {
  renderStyle = renderStyleInput.value;
  try { window.localStorage.setItem("sports-face-render-style", renderStyle); } catch { /* file:// may disable storage */ }
  refresh();
  showToast([MORPH_RENDER_STYLE, GNM_MORPH_RENDER_STYLE].includes(renderStyle)
    ? "Morph Lab activado; landmarks y FaceDNA permanecen separados"
    : renderStyle === WEBGL_MORPH_RENDER_STYLE
      ? "WebGL2 opt-in activado; fallará de forma segura a GNM SVG"
    : renderStyle === TOON_RENDER_STYLE
      ? "Toon Polish activado; FaceDNA no ha cambiado"
      : "Renderer original activado");
});

expressionModeInput.addEventListener("change", () => {
  expressionMode = EXPRESSION_MODES.includes(expressionModeInput.value) ? expressionModeInput.value : "auto";
  try { window.localStorage.setItem(EXPRESSION_MODE_STORAGE_KEY, expressionMode); } catch { /* file:// may disable storage */ }
  refresh();
  showToast("Microexpresión actualizada");
});

landmarksInput.addEventListener("change", () => {
  showLandmarks = landmarksInput.checked;
  try { window.localStorage.setItem("sports-face-show-landmarks", showLandmarks ? "1" : "0"); } catch { /* optional */ }
  refresh({ rebuildGallery: false });
  showToast(showLandmarks ? "Landmarks visibles" : "Landmarks ocultos");
});

for (const input of [kitPrimary, kitSecondary]) {
  input.addEventListener("input", () => {
    profile = setKit(profile, kitPrimary.value, kitSecondary.value);
    refresh({ rebuildGallery: false });
  });
}

populateRenderStyles();
populateFeatureControls();
refresh();
