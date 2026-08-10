/* Sports Morph Lab renderer v0.4.0. */

import { buildToonSvg, describeToonMapping, TOON_HEAD_ATTRIBUTION } from "./toon-renderer.js";
import {
  GNM_MORPH_RENDER_STYLE,
  GNM_MORPHOLOGY_VERSION,
  MORPH_RENDER_STYLE,
  buildHeadPath,
  buildGnmMorphology,
  buildMorphology,
  buildMorphologySvgOverlay,
} from "./morphology.js";

const canvasTokens = new WeakMap();

// The fixed BODY_PATHS asset in toon-renderer.js is placed at y=556.
const FIXED_NECK_JOIN_Y = 556;
const MORPH_RIGHT_SHADE_GRADIENT = `<linearGradient id="morphRightShadeGradient" gradientUnits="userSpaceOnUse" x1="384" y1="0" x2="768" y2="0">
  <stop offset="0" stop-color="#000" stop-opacity="0"/>
  <stop offset=".3" stop-color="#000" stop-opacity="0"/>
  <stop offset=".7" stop-color="#000" stop-opacity=".012"/>
  <stop offset="1" stop-color="#000" stop-opacity=".035"/>
</linearGradient>`;

function round(value, places = 4) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function transformGroup(transform) {
  return `translate(${round(transform.cx)} ${round(transform.cy)}) scale(${round(transform.sx)} ${round(transform.sy)}) translate(${-round(transform.originX)} ${-round(transform.originY)})`;
}

function morphologyJoinOffset(morphology) {
  return round(Math.max(0, FIXED_NECK_JOIN_Y - morphology.bounds.bottom));
}

function replaceOpening(svg, original, replacement) {
  if (!svg.includes(original)) throw new Error(`Marcador SVG ausente: ${original}`);
  return svg.replace(original, replacement);
}

function buildHeadMarkup(morphology) {
  const l = morphology.landmarks;
  const d = morphology.dimensions;
  const headPath = buildHeadPath(morphology);
  const earStroke = "#17110f";
  const earMarkup = `<g data-morph-ears="true" fill="url(#skinGradient)" stroke="${earStroke}" stroke-width="3">
    <ellipse cx="${l.earLeft.x}" cy="${l.earLeft.y}" rx="${round(d.earWidth)}" ry="${round(d.earHeight / 2)}"/>
    <ellipse cx="${l.earRight.x}" cy="${l.earRight.y}" rx="${round(d.earWidth)}" ry="${round(d.earHeight / 2)}"/>
    <path d="M${round(l.earLeft.x - d.earWidth * .18)} ${round(l.earLeft.y - d.earHeight * .14)} Q${round(l.earLeft.x - d.earWidth * .42)} ${round(l.earLeft.y)} ${round(l.earLeft.x - d.earWidth * .12)} ${round(l.earLeft.y + d.earHeight * .17)}" fill="none" opacity=".35"/>
    <path d="M${round(l.earRight.x + d.earWidth * .18)} ${round(l.earRight.y - d.earHeight * .14)} Q${round(l.earRight.x + d.earWidth * .42)} ${round(l.earRight.y)} ${round(l.earRight.x + d.earWidth * .12)} ${round(l.earRight.y + d.earHeight * .17)}" fill="none" opacity=".35"/>
  </g>`;
  const rightShade = `M${l.top.x} ${l.top.y}
    C${round(l.top.x + d.craniumHalf * .7)} ${round(l.top.y - 2)} ${l.templeRight.x} ${l.templeRight.y} ${l.cheekRight.x} ${l.cheekRight.y}
    C${round(l.cheekRight.x - 2)} ${round(l.cheekRight.y + d.faceHeight * .11)} ${l.jawRight.x} ${l.jawRight.y} ${l.chinRight.x} ${l.chinRight.y}
    C${round(l.chinRight.x - 12)} ${round(l.chinRight.y + d.faceHeight * .05)} ${round(l.chin.x + 12)} ${l.chin.y} ${l.chin.x} ${l.chin.y}
    L${l.top.x} ${l.top.y}Z`;
  const cheekLight = `M${round(l.cheekLeft.x + d.cheekHalf * .30)} ${round(l.cheekLeft.y - d.faceHeight * .12)}
    Q${round(l.top.x - d.cheekHalf * .28)} ${round(l.cheekLeft.y)} ${round(l.cheekLeft.x + d.cheekHalf * .42)} ${round(l.cheekLeft.y + d.faceHeight * .12)}`;
  return `<g data-morph-head="${morphology.family.id}">
    ${earMarkup}
    <path d="${headPath}" fill="url(#skinGradient)" stroke="#17110f" stroke-width="3.2" stroke-linejoin="round"/>
    <path d="${rightShade}" fill="url(#morphRightShadeGradient)"/>
    <path d="${cheekLight}" fill="none" stroke="#fff" stroke-width="9" opacity=".055" stroke-linecap="round"/>
  </g>`;
}

function wrapNose(svg, morphology) {
  const t = morphology.transforms.nose;
  const regex = /<path d="M(?:380|372|381|379|378|376|373)[^"]*" fill="none" stroke="[^"]+" stroke-width="4\.2"[^>]*\/>/;
  const match = svg.match(regex);
  if (!match) throw new Error("No se encontró la nariz Toon para deformarla");
  return svg.replace(match[0], `<g data-morph-feature="nose" transform="${transformGroup(t)}">${match[0]}</g>`);
}

function wrapGlasses(svg, morphology) {
  const t = morphology.transforms.glasses;
  const regex = /<g fill="#b6dded" fill-opacity="\.08" stroke="#202a32" stroke-width="6">[\s\S]*?<\/g>/;
  const match = svg.match(regex);
  if (!match) return svg;
  return svg.replace(match[0], `<g data-morph-feature="glasses" transform="${transformGroup(t)}">${match[0]}</g>`);
}

export function describeMorphMapping(profile, { expressionMode } = {}) {
  const morphology = buildMorphology(profile, { expressionMode });
  const toon = describeToonMapping(profile);
  return {
    ...toon,
    renderer: MORPH_RENDER_STYLE,
    morphVersion: "0.4.0",
    family: morphology.family,
    source: morphology.source,
    identitySignature: morphology.identitySignature,
    expression: morphology.expression,
    expressionMode: {
      requested: morphology.expression.requestedMode,
      selected: morphology.expression.mode,
    },
    metrics: morphology.metrics,
    bounds: morphology.bounds,
    landmarks: morphology.landmarks,
    transforms: morphology.transforms,
    localDeformation: true,
    gnmRuntimeDependency: false,
  };
}

export function describeGnmMorphMapping(profile, { gnmAdapter, expressionMode } = {}) {
  const morphology = buildGnmMorphology(profile, gnmAdapter, { expressionMode });
  const toon = describeToonMapping(profile);
  return {
    ...toon,
    renderer: GNM_MORPH_RENDER_STYLE,
    morphVersion: GNM_MORPHOLOGY_VERSION,
    family: morphology.family,
    familySelection: morphology.familySelection,
    source: morphology.source,
    identitySignature: morphology.identitySignature,
    expression: morphology.expression,
    expressionMode: {
      requested: morphology.expression.requestedMode,
      selected: morphology.expression.mode,
    },
    metrics: morphology.metrics,
    bounds: morphology.bounds,
    landmarks: morphology.landmarks,
    transforms: morphology.transforms,
    localDeformation: true,
    gnmRuntimeDependency: true,
  };
}

function buildMorphSvgWithBuilder(profile, { showAge = true, showLandmarks = false, landmarkLabels = false, expressionMode } = {}, buildMorphologyForProfile = buildMorphology, renderStyle = MORPH_RENDER_STYLE, attributionText = "ToonHead by Johan Melin, CC BY 4.0; modified for Sports Face MVP. Morph Lab 0.4.0. Starter morphology pack is analytic and GNM-ready, not GNM-derived.") {
  const morphology = buildMorphologyForProfile(profile, { expressionMode });
  const joinOffset = morphologyJoinOffset(morphology);
  let svg = buildToonSvg(profile, { showAge });

  svg = svg.replace("<defs>", `<defs>\n      ${MORPH_RIGHT_SHADE_GRADIENT}`);

  svg = svg.replace(
    'data-expression-mode="neutral-portrait"',
    `data-expression-mode="neutral-portrait" data-micro-expression-mode="${morphology.expression.mode}" data-expression-mode-requested="${morphology.expression.requestedMode}" data-renderer="${renderStyle}" data-morphology-family="${morphology.family.id}"`,
  );
  svg = svg.replace(
    "ToonHead by Johan Melin, CC BY 4.0; modified for Sports Face MVP. Polish version 0.3.1.",
    attributionText,
  );

  svg = svg.replace(
    /<g transform="translate\(384 384\) scale\([^)]*\) translate\(-384 -384\)">/,
    `<g data-morphology-root="${morphology.family.id}" transform="translate(0 ${joinOffset})">`,
  );
  svg = svg.replace(
    /<g transform="translate\(186\.52 139\.5\)">[\s\S]*?<\/g>/,
    buildHeadMarkup(morphology),
  );

  svg = replaceOpening(
    svg,
    '<g transform="translate(253 367)">',
    `<g data-morph-feature="eyes" transform="${transformGroup(morphology.transforms.eyes)}">`,
  );
  svg = replaceOpening(
    svg,
    '<g transform="translate(265.82 287.36)">',
    `<g data-morph-feature="brows" transform="${transformGroup(morphology.transforms.brows)}">`,
  );
  svg = replaceOpening(
    svg,
    '<g transform="translate(326 487)">',
    `<g data-morph-feature="mouth" transform="${transformGroup(morphology.transforms.mouth)}">`,
  );
  svg = svg.replaceAll(
    'transform="translate(223.48 402.09)"',
    `data-morph-feature="beard" transform="${transformGroup(morphology.transforms.beard)}"`,
  );
  svg = svg.replace(
    '<g transform="translate(158.16)">',
    `<g data-morph-feature="hair-front" transform="${transformGroup(morphology.transforms.hairFront)}">`,
  );
  svg = svg.replace(
    '<g transform="translate(160.62 339.51)">',
    `<g data-morph-feature="hair-rear" transform="${transformGroup(morphology.transforms.hairRear)}">`,
  );
  svg = wrapNose(svg, morphology);
  svg = wrapGlasses(svg, morphology);

  const overlay = showLandmarks ? buildMorphologySvgOverlay(morphology, { labels: landmarkLabels }) : "";
  if (overlay) {
    const rootEnd = '    </g>\n    <rect width="768" height="768" fill="url(#vignette)"/>';
    svg = replaceOpening(svg, rootEnd, `    ${overlay}\n${rootEnd}`);
  }
  return svg;
}

export function buildMorphSvg(profile, options = {}) {
  return buildMorphSvgWithBuilder(profile, options);
}

export function buildGnmMorphSvg(profile, { gnmAdapter, ...options } = {}) {
  return buildMorphSvgWithBuilder(
    profile,
    options,
    (currentProfile, currentOptions) => buildGnmMorphology(currentProfile, gnmAdapter, currentOptions),
    GNM_MORPH_RENDER_STYLE,
    "ToonHead by Johan Melin, CC BY 4.0; modified for Sports Face MVP. Morph Lab 0.4.0. GNM-derived runtime morphology pack; family assignment uses the reviewed semantic FaceDNA shape mapping.",
  );
}

function renderMorphCanvas(canvas, profile, options, buildSvg) {
  if (!canvas || typeof canvas.getContext !== "function") {
    return Promise.reject(new TypeError("renderMorphFace necesita un canvas compatible"));
  }
  const token = Symbol("morph-render");
  canvasTokens.set(canvas, token);
  const svg = buildSvg(profile, options);
  const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (canvasTokens.get(canvas) !== token) return resolve(canvas);
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      ctx.restore();
      resolve(canvas);
    };
    image.onerror = () => reject(new Error("No se pudo rasterizar el SVG morfológico"));
    image.src = uri;
  });
}

export function renderMorphFace(canvas, profile, options = {}) {
  return renderMorphCanvas(canvas, profile, options, buildMorphSvg);
}

export function renderGnmMorphFace(canvas, profile, options = {}) {
  return renderMorphCanvas(canvas, profile, options, buildGnmMorphSvg);
}

export { GNM_MORPH_RENDER_STYLE, MORPH_RENDER_STYLE, TOON_HEAD_ATTRIBUTION };
