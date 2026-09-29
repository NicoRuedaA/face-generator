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
  DEFAULT_RENDER_STYLE, describeRender, downloadPng, resetGnmPlayerCamera,
  renderPortrait, renderPortraitThumbnail,
} from "./render-router.js";

const gnm3dCanvas = document.querySelector("#portrait-gnm3d");
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
const expressionModeInput = document.querySelector("#expression-mode");
const EXPRESSION_MODE_STORAGE_KEY = "sports-face-expression-mode";
const EXPRESSION_MODES = ["auto", "neutral", "alert", "soft", "focused"];
let profile = createProfile({ seed: Date.now(), age: 22, presentation: "neutral" });
const renderStyle = DEFAULT_RENDER_STYLE;
function loadExpressionMode() {
  try {
    const saved = window.localStorage.getItem(EXPRESSION_MODE_STORAGE_KEY);
    return EXPRESSION_MODES.includes(saved) ? saved : "auto";
  } catch {
    return "auto";
  }
}
let expressionMode = loadExpressionMode();
let hairstylePrototype = "original";
const hairstylePrototypeInput = document.querySelector("#hairstyle-prototype");
hairstylePrototypeInput.addEventListener("change", () => {
  hairstylePrototype = hairstylePrototypeInput.value === "side-part" ? "side-part" : "original";
  refresh();
});
const renderStatus = document.querySelector("#render-status");
const downloadButton = document.querySelector("#download-png");
let mainRenderPromise = Promise.resolve(null);
let renderRevision = 0;
let toastTimer = null;

function showToast(message, type = "ok") {
  toast.textContent = message;
  toast.dataset.type = type;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2400);
}

const STYLE_NAMES = Object.freeze({
  hair: ["Rapado", "Corto con volumen", "Flequillo corto", "Raya lateral", "Media melena", "Raya central", "Rizado con volumen", "Largo", "Largo abundante", "Degradado alto", "Trenzado", "Moño"],
  beard: ["Sin barba", "Barba de tres días", "Barba corta", "Barba completa", "Perilla", "Bigote"],
  brows: ["Suaves", "Rectas", "Arqueadas", "Gruesas", "Cortas", "Angulares", "Bajas", "Altas"],
  eyes: ["Almendrados", "Redondos", "Hundidos", "Estrechos", "Inclinados arriba", "Inclinados abajo"],
  nose: ["Recta", "Ancha", "Estrecha", "Corta", "Larga", "Aguileña", "Redondeada", "Puente bajo"],
  mouth: ["Neutra", "Ancha", "Estrecha", "Labios gruesos", "Labios finos", "Comisuras arriba", "Comisuras abajo"],
  earShape: ["Medianas", "Pequeñas", "Grandes", "Separadas"],
  eyeColor: ["Marrón", "Avellana", "Azul", "Verde"],
});

function chooseStyle(key, value) {
  if (key === "hair") {
    hairstylePrototype = "original";
    // Enable before selecting: FaceDNA canonicalizes hidden hair to slot zero.
    profile = setFeature(profile, "hairVisible", 1);
  }
  profile = setFeature(profile, key, value);
  refresh({ rebuildGallery: false });
}

/** Real renderer previews on a fixed reference face, using one shared WebGL context. */
function populateStyleCatalogs() {
  const host = document.querySelector("#style-catalogs");
  let reference = createProfile({ seed: hashSeed("style-catalog-reference"), age: 24 });
  for (const [key, value] of Object.entries({ skin: 2, hairColor: 2, hairVisible: 1, hair: 0, beard: 0, brows: 0, glasses: 0, scar: 0, freckles: 0 })) reference = setFeature(reference, key, value);
  for (const [key, title] of [["hair", "Peinados"], ["beard", "Barbas"], ["brows", "Cejas"]]) {
    const details = document.createElement("details");
    details.dataset.catalog = key;
    const summary = document.createElement("summary");
    summary.textContent = `${title} · ${STYLE_NAMES[key].length} estilos`;
    const grid = document.createElement("div");
    grid.className = "style-catalog";
    let loaded = false;
    details.addEventListener("toggle", () => {
      if (!details.open || loaded) return;
      loaded = true;
      for (const [index, name] of STYLE_NAMES[key].entries()) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "style-card";
        button.dataset.styleFeature = key;
        button.dataset.styleValue = String(index);
        button.setAttribute("aria-pressed", String(getFaceValues(profile)[key] === index));
        const canvas = document.createElement("canvas");
        canvas.width = 160; canvas.height = 160; canvas.setAttribute("aria-hidden", "true");
        const label = document.createElement("span"); label.textContent = name;
        button.append(canvas, label);
        button.addEventListener("click", () => chooseStyle(key, index));
        grid.append(button);
        renderPortraitThumbnail(canvas, setFeature(reference, key, index), { expressionMode: "neutral", hairstylePrototype: "original", camera: { yaw: key === "hair" ? (index === 11 ? 1.25 : 0.38) : 0, pitch: -0.06, distance: 1 } }).then(() => {
          if (key !== "hair") {
            const context = canvas.getContext("2d");
            context.drawImage(canvas, 35, key === "brows" ? 28 : 62, 90, 85, 0, 0, 160, 160);
          }
          canvas.dataset.ready = "true";
        }).catch(() => { button.title = "Vista previa no disponible; puedes seleccionar el estilo"; });
      }
    });
    details.append(summary, grid); host.append(details);
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
      option.textContent = variable.type === "toggle" ? (index === 0 ? "No" : "Sí") : (STYLE_NAMES[variable.key]?.[index] ?? `${index + 1}`);
      select.append(option);
    }
    select.addEventListener("change", () => {
      chooseStyle(variable.key, Number(select.value));
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
  for (const button of document.querySelectorAll("button[data-style-feature]")) {
    button.setAttribute("aria-pressed", String(values[button.dataset.styleFeature] === Number(button.dataset.styleValue)));
  }
  debugOutput.textContent = JSON.stringify({
    ...describeProfile(profile),
    selectedRenderer: renderStyle,
    selectedExpressionMode: expressionMode,
    hairstylePrototype,
    renderMapping: describeRender(profile, renderStyle, { expressionMode, hairstylePrototype }),
  }, null, 2);
  expressionModeInput.value = expressionMode;
  hairstylePrototypeInput.value = hairstylePrototype;
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
    renderPortraitThumbnail(miniCanvas, itemProfile, { expressionMode, hairstylePrototype }).catch(() => { button.title = "Vista 3D no disponible"; });
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
  downloadButton.disabled = true;
  renderStatus.hidden = false;
  renderStatus.textContent = "Cargando retrato 3D…";
  mainRenderPromise = renderPortrait(gnm3dCanvas, profile, { expressionMode, hairstylePrototype }).then((result) => {
    if (revision !== renderRevision) return null;
    gnm3dCanvas.hidden = false;
    webglCameraControls.hidden = false;
    renderStatus.hidden = true;
    downloadButton.disabled = false;
    return result;
  }).catch((error) => {
    if (revision !== renderRevision) return null;
    gnm3dCanvas.hidden = true;
    webglCameraControls.hidden = true;
    renderStatus.hidden = false;
    renderStatus.textContent = `No se puede mostrar el retrato 3D: ${error.message}. Usa un navegador con WebGL2 y abre la aplicación mediante HTTP. No hay renderizado 2D alternativo.`;
    return null;
  });
  syncControls();
  if (rebuildGallery) renderGallery();
}

document.querySelector("#reset-webgl-camera").addEventListener("click", () => {
  resetGnmPlayerCamera(gnm3dCanvas);
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

downloadButton.addEventListener("click", async () => {
  const pending = mainRenderPromise;
  const result = await pending;
  if (!result || pending !== mainRenderPromise || downloadButton.disabled) return;
  try {
    await downloadPng(gnm3dCanvas, `sports-face-gnm-3d-player-v1-${profile.seed}.png`);
    showToast("PNG preparado");
  } catch (error) { showToast(error.message, "error"); }
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

expressionModeInput.addEventListener("change", () => {
  expressionMode = EXPRESSION_MODES.includes(expressionModeInput.value) ? expressionModeInput.value : "auto";
  try { window.localStorage.setItem(EXPRESSION_MODE_STORAGE_KEY, expressionMode); } catch { /* file:// may disable storage */ }
  refresh();
  showToast("Microexpresión actualizada");
});

for (const input of [kitPrimary, kitSecondary]) {
  input.addEventListener("input", () => {
    profile = setKit(profile, kitPrimary.value, kitSecondary.value);
    refresh({ rebuildGallery: false });
  });
}

populateFeatureControls();
populateStyleCatalogs();
refresh();
