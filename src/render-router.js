/* The GNM 3D player is the only rendering path. */
import {
  GNM_PLAYER_RENDER_STYLE,
  describeGnmPlayerRender,
  renderGnmPlayerFace,
  renderGnmPlayerThumbnail,
  resetGnmPlayerCamera,
} from "./gnm-player-renderer.js";
export { GNM_PLAYER_RENDER_STYLE, resetGnmPlayerCamera };
export const DEFAULT_RENDER_STYLE = GNM_PLAYER_RENDER_STYLE;
export const RENDER_STYLES = Object.freeze([
  Object.freeze({ id: GNM_PLAYER_RENDER_STYLE, label: "Sports GNM 3D Player v1", attributionRequired: true }),
]);
export function isRenderStyle(value) { return value === GNM_PLAYER_RENDER_STYLE; }
function assertStyle(style) {
  if (!isRenderStyle(style)) throw new Error(`Unsupported renderer: ${style}`);
}
export function renderPortrait(canvas, profile, { style = DEFAULT_RENDER_STYLE, ...options } = {}) {
  assertStyle(style);
  return renderGnmPlayerFace(canvas, profile, options);
}
export function describeRender(profile, style = DEFAULT_RENDER_STYLE, options = {}) {
  assertStyle(style);
  return describeGnmPlayerRender(profile, options);
}
export function renderPortraitThumbnail(canvas, profile, { style = DEFAULT_RENDER_STYLE, ...options } = {}) {
  assertStyle(style);
  return renderGnmPlayerThumbnail(canvas, profile, options);
}
export function downloadPng(canvas, filename = "sports-face.png") {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error("No se pudo generar el PNG")); return; }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      resolve();
    }, "image/png");
  });
}
