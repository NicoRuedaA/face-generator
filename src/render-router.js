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

export const DEFAULT_RENDER_STYLE = "sports/default-v2";
export const TOON_RENDER_STYLE = "sports/toon-prototype";
export { GNM_MORPH_RENDER_STYLE, MORPH_RENDER_STYLE };
export const RENDER_STYLES = Object.freeze([
  Object.freeze({ id: DEFAULT_RENDER_STYLE, label: "Sports Default v2", attributionRequired: false }),
  Object.freeze({ id: TOON_RENDER_STYLE, label: "Sports Toon Polish v0.3.1", attributionRequired: true }),
  Object.freeze({ id: MORPH_RENDER_STYLE, label: "Sports Morph Lab v0.4.0", attributionRequired: true }),
  Object.freeze({ id: GNM_MORPH_RENDER_STYLE, label: "Sports Morph Lab GNM v1", attributionRequired: true }),
]);

export function isRenderStyle(value) { return RENDER_STYLES.some((style) => style.id === value); }

export function renderPortrait(canvas, profile, { style = DEFAULT_RENDER_STYLE, expressionMode = "auto", ...options } = {}) {
  const renderOptions = { ...options, expressionMode };
  if (style === GNM_MORPH_RENDER_STYLE) return renderGnmMorphFace(canvas, profile, renderOptions);
  if (style === MORPH_RENDER_STYLE) return renderMorphFace(canvas, profile, renderOptions);
  if (style === TOON_RENDER_STYLE) return renderToonFace(canvas, profile, options);
  renderFace(canvas, profile, options);
  return Promise.resolve(canvas);
}

export function describeRender(profile, style = DEFAULT_RENDER_STYLE, options = {}) {
  if (style === GNM_MORPH_RENDER_STYLE) return describeGnmMorphMapping(profile, options);
  if (style === MORPH_RENDER_STYLE) return describeMorphMapping(profile, options);
  return style === TOON_RENDER_STYLE
    ? describeToonMapping(profile)
    : { renderer: DEFAULT_RENDER_STYLE, mapping: "native FaceDNA v2" };
}

export { buildGnmMorphSvg, buildMorphSvg, buildToonSvg, downloadPng, TOON_HEAD_ATTRIBUTION };
