/* Renderer selector. Selection is deliberately not part of FaceDNA/SF2. */
import { downloadPng, renderFace } from "./renderer.js";
import { buildToonSvg, describeToonMapping, renderToonFace, TOON_HEAD_ATTRIBUTION } from "./toon-renderer.js";
import {
  GNM_MORPH_RENDER_STYLE,
  MORPH_RENDER_STYLE,
  buildGnmMorphSvg,
  buildMorphSvg,
  describeGnmMorphMapping,
  describeMorphMapping,
  renderGnmMorphFace,
  renderMorphFace,
} from "./morph-renderer.js";
import {
  WEBGL_MORPH_RENDER_STYLE,
  WEBGL_OFFICIAL_RENDER_STYLE,
  WEBGL_OFFICIAL_BASIS_LAB_STYLE,
  describeWebglMapping,
  describeOfficialBasisLabMapping,
  describeOfficialWebglMapping,
  resetWebglCamera,
  renderWebglFace,
  TECHNICAL_VISUALIZATION_NONE,
  technicalVisualizationState,
} from "./webgl-renderer.js";

export const DEFAULT_RENDER_STYLE = "sports/default-v2";
export const TOON_RENDER_STYLE = "sports/toon-prototype";
export { GNM_MORPH_RENDER_STYLE, MORPH_RENDER_STYLE, WEBGL_MORPH_RENDER_STYLE, WEBGL_OFFICIAL_RENDER_STYLE, WEBGL_OFFICIAL_BASIS_LAB_STYLE, TECHNICAL_VISUALIZATION_NONE, technicalVisualizationState };
export const RENDER_STYLES = Object.freeze([
  Object.freeze({ id: DEFAULT_RENDER_STYLE, label: "Sports Default v2", attributionRequired: false }),
  Object.freeze({ id: TOON_RENDER_STYLE, label: "Sports Toon Polish v0.3.1", attributionRequired: true }),
  Object.freeze({ id: MORPH_RENDER_STYLE, label: "Sports Morph Lab v0.4.0", attributionRequired: true }),
  Object.freeze({ id: GNM_MORPH_RENDER_STYLE, label: "Sports Morph Lab GNM v1", attributionRequired: true }),
  Object.freeze({ id: WEBGL_MORPH_RENDER_STYLE, label: "Sports Morph Lab WebGL2 v1 (opt-in)", attributionRequired: true }),
  Object.freeze({ id: WEBGL_OFFICIAL_RENDER_STYLE, label: "Sports GNM Official 3D v1 (opt-in)", attributionRequired: true }),
  Object.freeze({ id: WEBGL_OFFICIAL_BASIS_LAB_STYLE, label: "Sports GNM Official Basis Lab v1 (opt-in)", attributionRequired: true }),
]);

export function isRenderStyle(value) { return RENDER_STYLES.some((style) => style.id === value); }

export function renderPortrait(canvas, profile, { style = DEFAULT_RENDER_STYLE, expressionMode = "auto", ...options } = {}) {
  const renderOptions = { ...options, expressionMode };
  if (style === GNM_MORPH_RENDER_STYLE) return renderGnmMorphFace(canvas, profile, renderOptions);
  if (style === WEBGL_MORPH_RENDER_STYLE) return renderWebglFace(canvas, profile, renderOptions);
  if (style === WEBGL_OFFICIAL_RENDER_STYLE) return renderWebglFace(canvas, profile, { ...renderOptions, official: true });
  if (style === WEBGL_OFFICIAL_BASIS_LAB_STYLE) return renderWebglFace(canvas, profile, { ...renderOptions, official: true, basisLab: true, basisCoefficients: options.basisCoefficients });
  if (style === MORPH_RENDER_STYLE) return renderMorphFace(canvas, profile, renderOptions);
  if (style === TOON_RENDER_STYLE) return renderToonFace(canvas, profile, options);
  renderFace(canvas, profile, options);
  return Promise.resolve(canvas);
}

export function describeRender(profile, style = DEFAULT_RENDER_STYLE, options = {}) {
  if (style === GNM_MORPH_RENDER_STYLE) return describeGnmMorphMapping(profile, options);
  if (style === WEBGL_MORPH_RENDER_STYLE) return describeWebglMapping(profile, options);
  if (style === WEBGL_OFFICIAL_RENDER_STYLE) return describeOfficialWebglMapping(options);
  if (style === WEBGL_OFFICIAL_BASIS_LAB_STYLE) return describeOfficialBasisLabMapping(options.basisCoefficients, options);
  if (style === MORPH_RENDER_STYLE) return describeMorphMapping(profile, options);
  return style === TOON_RENDER_STYLE
    ? describeToonMapping(profile)
    : { renderer: DEFAULT_RENDER_STYLE, mapping: "native FaceDNA v2" };
}

export { buildGnmMorphSvg, buildMorphSvg, buildToonSvg, downloadPng, resetWebglCamera, TOON_HEAD_ATTRIBUTION };
