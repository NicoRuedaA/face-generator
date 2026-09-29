/* Deterministic expression selection for the 3D player. SPDX-License-Identifier: GPL-2.0-only */
export const MICRO_EXPRESSION_VERSION = "micro-expression-v1";
export const MICRO_EXPRESSION_MODES = Object.freeze(["neutral", "alert", "soft", "focused"]);
export const EXPRESSION_MODES = Object.freeze(["auto", ...MICRO_EXPRESSION_MODES]);
function round(value, places = 3) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}
function freezeExpressionFeature(feature) {
  return Object.freeze({
    offsetX: round(feature.offsetX, 4),
    offsetY: round(feature.offsetY, 4),
    scaleX: round(feature.scaleX, 4),
    scaleY: round(feature.scaleY, 4),
  });
}

export function deriveMicroExpressionProfile(profile, requestedMode = "auto") {
  const autoMode = MICRO_EXPRESSION_MODES[(profile.seed >>> 0) % MICRO_EXPRESSION_MODES.length];
  const resolvedRequestedMode = EXPRESSION_MODES.includes(requestedMode) ? requestedMode : "auto";
  const mode = resolvedRequestedMode === "auto" ? autoMode : resolvedRequestedMode;
  const modeIndex = MICRO_EXPRESSION_MODES.indexOf(mode);
  const modeNudges = {
    neutral: { eyesY: 0, browsY: 0, mouthY: 0, eyesSY: 0, browsSY: 0, mouthSY: 0 },
    alert: { eyesY: -0.7, browsY: -0.9, mouthY: -0.2, eyesSY: 0.006, browsSY: 0.004, mouthSY: 0 },
    soft: { eyesY: 0.6, browsY: 0.6, mouthY: 0.5, eyesSY: -0.004, browsSY: -0.003, mouthSY: 0.004 },
    focused: { eyesY: 0.9, browsY: 1.0, mouthY: -0.3, eyesSY: -0.007, browsSY: -0.005, mouthSY: -0.002 },
  }[mode];
  const parameters = Object.freeze({
    eyes: freezeExpressionFeature({
      offsetX: 0,
      offsetY: modeNudges.eyesY,
      scaleX: 1,
      scaleY: 1 + modeNudges.eyesSY,
    }),
    brows: freezeExpressionFeature({
      offsetX: 0,
      offsetY: modeNudges.browsY,
      scaleX: 1,
      scaleY: 1 + modeNudges.browsSY,
    }),
    mouth: freezeExpressionFeature({
      offsetX: 0,
      offsetY: modeNudges.mouthY,
      scaleX: 1,
      scaleY: 1 + modeNudges.mouthSY,
    }),
  });
  return Object.freeze({
    version: MICRO_EXPRESSION_VERSION,
    requestedMode: resolvedRequestedMode,
    mode,
    modeIndex,
    inputs: Object.freeze({ seed: profile.seed >>> 0 }),
    parameters,
  });
}

