import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
function read(name) { return fs.readFileSync(path.join(root, "src", name), "utf8"); }
function exportsOf(text) {
  return [...text.matchAll(/^export\s+(?:async\s+)?(?:const|class|function)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]);
}
function importNames(text, source) {
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^import\\s*\\{([^}]*)\\}\\s*from\\s*["']\\./${escaped}["'];`, "m"));
  if (!match) throw new Error(`Missing import from ${source}`);
  return `{ ${match[1].split(",").map((name) => name.trim()).filter(Boolean).join(", ")} }`;
}
function stripExports(text) {
  return text
    .replace(/^export\s+\{[\s\S]*?\};\s*$/gm, "")
    .replace(/^export\s+/gm, "");
}
function stripImports(text) { return text.replace(/^import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];\s*\n/gm, ""); }
function moduleBlock(name, text, exports, parameters = "", args = "") {
  return `const ${name} = ((${parameters}) => {\n${stripExports(stripImports(text))}\nreturn {\n  ${exports.join(",\n  ")}\n};\n})(${args});\n\n`;
}

const face = read("face-model.js");
const legacy = read("renderer.js");
const assets = read("toon-head-assets.js");
const toon = read("toon-renderer.js");
const morphology = read("morphology.js");
const morphRenderer = read("morph-renderer.js");
const webglRenderer = read("webgl-renderer.js");
const gnmPlayerModel = read("gnm-player-model.js");
const gnmPlayerRenderer = read("gnm-player-renderer.js");
const router = read("render-router.js");
const gnmPack = JSON.parse(fs.readFileSync(path.join(root, "tools", "gnm", "work", "gnm-morphology-pack.json"), "utf8"));
const serializedGnmPack = JSON.stringify(gnmPack);
let app = stripImports(read("app.js"));

let out = `/* Sports Face MVP v0.4.0 offline bundle. */\n`;
out += `const SportsFaceGnmPack = ${serializedGnmPack};\n\n`;
out += moduleBlock("SportsFaceModel", face, exportsOf(face));
out += moduleBlock("SportsFaceLegacyRenderer", legacy, exportsOf(legacy), "{ getFaceValues, hashSeed, Randomizer }", "SportsFaceModel");
out += moduleBlock("SportsFaceToonAssets", assets, exportsOf(assets));
out += moduleBlock("SportsFaceToonRenderer", toon, [...exportsOf(toon), "TOON_HEAD_ATTRIBUTION"],
  "{ getFaceValues, hashSeed }, { BEARD_PATHS, BODY_PATHS, EYEBROW_PATHS, EYE_VARIANTS, HAIR_PATHS, HEAD_PATHS, MOUTH_PATHS, REAR_HAIR_PATHS, SHIRT_PATHS, TOON_EYE_COLORS, TOON_HAIR_COLORS, TOON_HEAD_ATTRIBUTION, TOON_SKIN_COLORS }",
  "SportsFaceModel, SportsFaceToonAssets");
out += moduleBlock("SportsFaceMorphology", morphology, exportsOf(morphology),
  "{ getFaceValues, hashSeed }, gnmPack", "SportsFaceModel, SportsFaceGnmPack");
out += moduleBlock("SportsFaceMorphRenderer", morphRenderer,
  [...exportsOf(morphRenderer), "GNM_MORPH_RENDER_STYLE", "MORPH_RENDER_STYLE", "TOON_HEAD_ATTRIBUTION"],
  "{ buildToonSvg, describeToonMapping, TOON_HEAD_ATTRIBUTION }, { GNM_MORPH_RENDER_STYLE, GNM_MORPHOLOGY_VERSION, MORPH_RENDER_STYLE, buildGnmMorphology, buildHeadPath, buildMorphology, buildMorphologySvgOverlay }",
  "SportsFaceToonRenderer, SportsFaceMorphology");
out += moduleBlock("SportsFaceWebglRenderer", webglRenderer,
  [...exportsOf(webglRenderer), "WEBGL_MORPH_RENDER_STYLE", "WEBGL_OFFICIAL_RENDER_STYLE", "WEBGL_OFFICIAL_BASIS_LAB_STYLE"],
  "{ getFaceValues, hashSeed }, { renderGnmMorphFace }",
  "SportsFaceModel, SportsFaceMorphRenderer");
out += moduleBlock("SportsFaceGnmPlayerModel", gnmPlayerModel, exportsOf(gnmPlayerModel),
  `${importNames(gnmPlayerModel, "face-model.js")}, ${importNames(gnmPlayerModel, "morphology.js")}`,
  "SportsFaceModel, SportsFaceMorphology");
out += moduleBlock("SportsFaceGnmPlayerRenderer", gnmPlayerRenderer, [...exportsOf(gnmPlayerRenderer), "GNM_PLAYER_RENDER_STYLE"],
  `${importNames(gnmPlayerRenderer, "morph-renderer.js")}, ${importNames(gnmPlayerRenderer, "webgl-renderer.js")}, ${importNames(gnmPlayerRenderer, "gnm-player-model.js")}`,
  "SportsFaceMorphRenderer, SportsFaceWebglRenderer, SportsFaceGnmPlayerModel");
out += moduleBlock("SportsFaceRenderRouter", router,
  [...exportsOf(router), "GNM_MORPH_RENDER_STYLE", "GNM_PLAYER_RENDER_STYLE", "MORPH_RENDER_STYLE", "WEBGL_MORPH_RENDER_STYLE", "WEBGL_OFFICIAL_RENDER_STYLE", "WEBGL_OFFICIAL_BASIS_LAB_STYLE", "TECHNICAL_VISUALIZATION_NONE", "technicalVisualizationState", "buildGnmMorphSvg", "buildMorphSvg", "buildToonSvg", "downloadPng", "resetGnmPlayerCamera", "resetWebglCamera", "TOON_HEAD_ATTRIBUTION"],
  `{ downloadPng, renderFace }, { buildToonSvg, describeToonMapping, renderToonFace, TOON_HEAD_ATTRIBUTION }, { GNM_MORPH_RENDER_STYLE, MORPH_RENDER_STYLE, buildGnmMorphSvg, buildMorphSvg, describeGnmMorphMapping, describeMorphMapping, renderGnmMorphFace, renderMorphFace }, { WEBGL_MORPH_RENDER_STYLE, WEBGL_OFFICIAL_RENDER_STYLE, WEBGL_OFFICIAL_BASIS_LAB_STYLE, TECHNICAL_VISUALIZATION_NONE, technicalVisualizationState, describeWebglMapping, describeOfficialWebglMapping, describeOfficialBasisLabMapping, resetWebglCamera, renderWebglFace }, ${importNames(router, "gnm-player-renderer.js")}`,
  "SportsFaceLegacyRenderer, SportsFaceToonRenderer, SportsFaceMorphRenderer, SportsFaceWebglRenderer, SportsFaceGnmPlayerRenderer");

const modelDeps = ["FACE_VARS","ageProfile","cloneProfile","createProfile","describeProfile","formatFaceCode","getFaceValues","hashSeed","parseFaceCode","setFeature","setKit","setPresentation"];
const routerDeps = ["DEFAULT_RENDER_STYLE","GNM_MORPH_RENDER_STYLE","GNM_PLAYER_RENDER_STYLE","MORPH_RENDER_STYLE","RENDER_STYLES","TOON_RENDER_STYLE","WEBGL_MORPH_RENDER_STYLE","WEBGL_OFFICIAL_RENDER_STYLE","WEBGL_OFFICIAL_BASIS_LAB_STYLE","TECHNICAL_VISUALIZATION_NONE","technicalVisualizationState","describeRender","downloadPng","resetGnmPlayerCamera","resetWebglCamera","renderPortrait","renderPortraitThumbnail"];
out += `(() => {\nconst { ${modelDeps.join(", ")} } = SportsFaceModel;\nconst { ${routerDeps.join(", ")} } = SportsFaceRenderRouter;\n${app}\n})();\n`;
fs.writeFileSync(path.join(root, "src", "app.bundle.js"), out);
fs.writeFileSync(
  path.join(root, "tools", "gnm", "work", "gnm-morphology-pack.js"),
  `/* Generated from gnm-morphology-pack.json by npm run build:offline. */\nglobalThis.sportsFaceGnmPack = ${serializedGnmPack};\n`,
);
console.log(`Built src/app.bundle.js (${out.length} bytes)`);
