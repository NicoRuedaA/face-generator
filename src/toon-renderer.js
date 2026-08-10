/*
 * Sports Toon Prototype renderer — polish pass v0.3.1.
 * Uses a curated and modified subset of ToonHead by Johan Melin (CC BY 4.0).
 */

import { getFaceValues, hashSeed } from "./face-model.js";
import {
  BEARD_PATHS,
  BODY_PATHS,
  HAIR_PATHS,
  HEAD_PATHS,
  SHIRT_PATHS,
  TOON_EYE_COLORS,
  TOON_HAIR_COLORS,
  TOON_HEAD_ATTRIBUTION,
  TOON_SKIN_COLORS,
} from "./toon-head-assets.js";

const canvasTokens = new WeakMap();

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function hex(value) { return /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : "#111827"; }
function path(d, fill, extra = "") { return `<path d="${d}" fill="${fill}" ${extra}/>`; }

function rgbOf(input) {
  const value = hex(input).slice(1);
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
}

function toHex(rgb) {
  return `#${rgb.map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function shadeHex(input, amount) {
  return toHex(rgbOf(input).map((channel) => channel + amount * 255));
}

function mixHex(a, b, amount) {
  const left = rgbOf(a);
  const right = rgbOf(b);
  const t = clamp(amount, 0, 1);
  return toHex(left.map((channel, index) => channel + (right[index] - channel) * t));
}

function mappedHair(values) {
  return [
    "crop", "sidePart", "crew", "softSpiky", "mediumSide", "undercut",
    "curly", "longStraight", "longWavy", "fade", "braids", "bun",
  ][values.hair % 12];
}

function mappedRearHair(values) {
  if (values.hairVisible !== 1) return null;
  if (values.hair === 7) return "longStraight";
  if (values.hair === 8) return "longWavy";
  return null;
}

function mappedEyes(values) {
  return ["almond", "round", "deep", "narrow", "upturned", "downturned"][values.eyes % 6];
}

function mappedBrows(values) {
  return ["soft", "flat", "arched", "thick", "short", "angular", "low", "high"][values.brows % 8];
}

function mappedMouth(values) {
  return ["neutral", "wide", "narrow", "full", "thin", "slightSmile", "softDownturn"][values.mouth % 7];
}

function mappedBeard(values, age) {
  const requested = [null, "stubble", "short", "full", "goatee", "moustache"][values.beard] ?? null;
  if (!requested || age < 18) return null;
  if (age <= 20) return "stubble";
  if (age <= 23 && ["full", "goatee"].includes(requested)) return "short";
  return requested;
}

function morphFor(values) {
  const headScale = [0.99, 1.045, 0.955, 1.02, 1.055, 0.97][values.head] ?? 1;
  const jawAdjustments = [-0.024, -0.014, 0, 0.014, 0.027, 0.02];
  const ratioAdjustments = [-0.03, -0.018, 0, 0.018, 0.036, 0.048];
  return {
    sx: clamp(headScale + (jawAdjustments[values.jaw] ?? 0), 0.94, 1.075),
    sy: clamp(1 + (ratioAdjustments[values.faceProportion] ?? 0), 0.96, 1.06),
  };
}

function resolveHairColour(profile, values) {
  const grey = "#a5a7a5";
  let base;
  let prematureGreySuppressed = false;

  if (values.hairColor === 7 && profile.age < 30) {
    const naturalIndex = hashSeed(`toon-natural-hair:${profile.seed}`) % 7;
    base = TOON_HAIR_COLORS[naturalIndex];
    prematureGreySuppressed = true;
  } else if (values.hairColor === 7 && profile.age < 40) {
    const naturalIndex = hashSeed(`toon-natural-hair:${profile.seed}`) % 7;
    base = mixHex(TOON_HAIR_COLORS[naturalIndex], grey, (profile.age - 30) / 40);
  } else {
    base = TOON_HAIR_COLORS[values.hairColor % TOON_HAIR_COLORS.length];
  }

  const greyStart = 39 + (hashSeed(`toon-grey-start:${profile.seed}`) % 10);
  const ageGrey = profile.age > greyStart ? clamp((profile.age - greyStart) / 24, 0, 0.74) : 0;
  const logicalGrey = values.hairColor === 7 && profile.age >= 40 ? 0.74 : 0;
  const greyLevel = Math.max(ageGrey, logicalGrey);
  return {
    colour: mixHex(base, grey, greyLevel),
    greyLevel,
    greyStart,
    prematureGreySuppressed,
  };
}

function renderPaths(paths, fill, { opacity = 1, stroke = "#111111", width = 2.7 } = {}) {
  return paths.map((d, index) => path(
    d,
    index === 1 && opacity < 1 ? "#000000" : fill,
    `stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round" opacity="${index === 1 ? opacity : 1}"`,
  )).join("");
}

function eyeSpec(kind) {
  const specs = {
    almond: { rx: 42, ry: 20, y: 39, leftRotation: -1, rightRotation: 1, lid: 0.45 },
    round: { rx: 34, ry: 28, y: 39, leftRotation: 0, rightRotation: 0, lid: 0.26 },
    deep: { rx: 40, ry: 18, y: 42, leftRotation: 0, rightRotation: 0, lid: 0.72 },
    narrow: { rx: 44, ry: 13, y: 40, leftRotation: 0, rightRotation: 0, lid: 0.82 },
    upturned: { rx: 41, ry: 20, y: 40, leftRotation: -5, rightRotation: 5, lid: 0.46 },
    downturned: { rx: 41, ry: 20, y: 39, leftRotation: 5, rightRotation: -5, lid: 0.5 },
  };
  return specs[kind] ?? specs.almond;
}

function renderSingleEye({ cx, cy, rx, ry, rotation, eyeColor, side }) {
  const irisRadius = clamp(ry * 0.72, 9, 18);
  const pupilRadius = clamp(irisRadius * 0.44, 4.5, 8);
  const upperStart = cx - rx * 0.9;
  const upperEnd = cx + rx * 0.9;
  const upperControl = cy - ry * 0.88;
  const lowerControl = cy + ry * 0.64;
  const highlightX = cx - irisRadius * 0.32 * side;
  const transform = `rotate(${rotation} ${cx} ${cy})`;
  return `<g transform="${transform}">
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#f7f2e8" stroke="#4b2a24" stroke-width="3"/>
    <circle cx="${cx}" cy="${cy + 1}" r="${irisRadius}" fill="${eyeColor}"/>
    <circle cx="${cx}" cy="${cy + 1}" r="${pupilRadius}" fill="#161211"/>
    <circle cx="${highlightX}" cy="${cy - irisRadius * 0.28}" r="${Math.max(2.4, irisRadius * 0.19)}" fill="#fff" opacity=".9"/>
    <path d="M${upperStart} ${cy} Q${cx} ${upperControl} ${upperEnd} ${cy}" fill="none" stroke="#4b2a24" stroke-width="4" stroke-linecap="round"/>
    <path d="M${upperStart + 5} ${cy + 2} Q${cx} ${lowerControl} ${upperEnd - 5} ${cy + 2}" fill="none" stroke="#6b4138" stroke-width="1.8" opacity=".48"/>
  </g>`;
}

function renderEyes(kind, eyeColor) {
  const spec = eyeSpec(kind);
  return `${renderSingleEye({ cx: 61, cy: spec.y, rx: spec.rx, ry: spec.ry, rotation: spec.leftRotation, eyeColor, side: 1 })}
    ${renderSingleEye({ cx: 200, cy: spec.y, rx: spec.rx, ry: spec.ry, rotation: spec.rightRotation, eyeColor, side: -1 })}`;
}

function browSpec(kind) {
  const specs = {
    soft: { left: "M8 56 Q42 37 79 51", right: "M159 51 Q196 37 230 56", width: 9 },
    flat: { left: "M8 53 Q43 48 79 52", right: "M159 52 Q195 48 230 53", width: 9 },
    arched: { left: "M7 59 Q39 24 80 48", right: "M158 48 Q199 24 231 59", width: 8 },
    thick: { left: "M6 56 Q42 34 81 50", right: "M157 50 Q196 34 232 56", width: 14 },
    short: { left: "M20 54 Q46 42 72 51", right: "M166 51 Q192 42 218 54", width: 9 },
    angular: { left: "M7 59 L43 39 L80 52", right: "M158 52 L195 39 L231 59", width: 9 },
    low: { left: "M7 66 Q43 51 80 59", right: "M158 59 Q195 51 231 66", width: 10 },
    high: { left: "M8 43 Q42 26 79 40", right: "M159 40 Q196 26 230 43", width: 8 },
  };
  return specs[kind] ?? specs.soft;
}

function renderBrows(kind, colour) {
  const spec = browSpec(kind);
  return `<g fill="none" stroke="${colour}" stroke-width="${spec.width}" stroke-linecap="round" stroke-linejoin="round">
    <path d="${spec.left}"/><path d="${spec.right}"/>
  </g>`;
}

function renderMouth(kind, skin) {
  const lip = mixHex(shadeHex(skin, -0.28), "#8d3e49", 0.44);
  const dark = shadeHex(lip, -0.15);
  const variants = {
    neutral: `<path d="M15 26 Q58 30 102 26" fill="none" stroke="${dark}" stroke-width="5" stroke-linecap="round"/>`,
    wide: `<path d="M5 25 Q58 31 112 25" fill="none" stroke="${dark}" stroke-width="5" stroke-linecap="round"/>`,
    narrow: `<path d="M28 26 Q58 29 88 26" fill="none" stroke="${dark}" stroke-width="5" stroke-linecap="round"/>`,
    full: `<path d="M12 27 Q58 15 105 27 Q58 42 12 27Z" fill="${lip}" opacity=".82"/><path d="M17 27 Q58 30 100 27" fill="none" stroke="${dark}" stroke-width="2.5" opacity=".7"/>`,
    thin: `<path d="M17 27 Q58 28 100 27" fill="none" stroke="${dark}" stroke-width="3.5" stroke-linecap="round"/>`,
    slightSmile: `<path d="M11 23 Q58 35 106 23" fill="none" stroke="${dark}" stroke-width="5" stroke-linecap="round"/>`,
    softDownturn: `<path d="M12 31 Q58 20 105 31" fill="none" stroke="${dark}" stroke-width="5" stroke-linecap="round"/>`,
  };
  return variants[kind] ?? variants.neutral;
}

function renderNose(index, skin) {
  const dark = shadeHex(skin, -0.3);
  const variants = [
    "M380 420 Q375 452 384 468 Q393 452 388 420",
    "M372 426 Q367 454 384 468 Q401 454 396 426",
    "M381 421 Q377 452 384 466 Q391 452 387 421",
    "M379 432 Q377 451 384 460 Q391 451 389 432",
    "M379 411 Q375 452 384 472 Q393 452 389 411",
    "M378 417 Q367 442 384 465 Q399 457 393 446",
    "M376 424 Q373 453 384 466 Q395 453 392 424 M375 465 Q384 472 395 465",
    "M373 430 Q375 454 384 465 Q393 454 395 430",
  ];
  return `<path d="${variants[index % variants.length]}" fill="none" stroke="${dark}" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round" opacity=".5"/>`;
}

function renderFreckles(seed, enabled, skin) {
  if (!enabled) return "";
  let state = hashSeed(`toon-freckles:${seed}`);
  const dots = [];
  for (let i = 0; i < 16; i += 1) {
    state = (Math.imul(state ^ (state >>> 15), 1 | state) + i) >>> 0;
    const side = i % 2 === 0 ? -1 : 1;
    const x = 384 + side * (64 + (state % 43));
    const y = 462 + ((state >>> 8) % 31);
    dots.push(`<circle cx="${x}" cy="${y}" r="${1.35 + (state % 2) * .45}" fill="${shadeHex(skin, -0.34)}" opacity=".38"/>`);
  }
  return dots.join("");
}

function renderGlasses(enabled, profile, values) {
  if (!enabled) return "";
  const round = (hashSeed(`toon-glasses:${profile.seed}`) + values.head) % 2 === 0;
  const lens = "#b6dded";
  if (round) {
    return `<g fill="${lens}" fill-opacity=".08" stroke="#202a32" stroke-width="6">
      <ellipse cx="318" cy="405" rx="45" ry="36"/>
      <ellipse cx="450" cy="405" rx="45" ry="36"/>
      <path d="M363 399 Q384 388 405 399M273 397l-37-12M495 397l37-12" fill="none" stroke-linecap="round"/>
      <path d="M289 386l22-8M421 386l22-8" stroke="#eaf8ff" stroke-width="3" opacity=".34"/>
    </g>`;
  }
  return `<g fill="${lens}" fill-opacity=".08" stroke="#202a32" stroke-width="6">
    <rect x="270" y="373" width="98" height="66" rx="17"/>
    <rect x="400" y="373" width="98" height="66" rx="17"/>
    <path d="M368 399 Q384 390 400 399M270 394l-35-11M498 394l35-11" fill="none" stroke-linecap="round"/>
    <path d="M285 386l25-8M415 386l25-8" stroke="#eaf8ff" stroke-width="3" opacity=".34"/>
  </g>`;
}

function renderAge(age, skin) {
  if (age < 34) return "";
  const dark = shadeHex(skin, -0.27);
  const opacity = clamp((age - 33) / 55, 0.1, 0.34);
  const underEyes = age >= 34 ? '<path d="M278 438 Q294 443 306 452 M490 438 Q474 443 462 452"/>' : "";
  const forehead = age >= 40 ? '<path d="M327 326 Q384 316 441 326 M337 340 Q384 333 431 340"/>' : "";
  const mouth = age >= 46 ? '<path d="M320 516 Q331 528 344 532 M448 516 Q437 528 424 532"/>' : "";
  const crowsFeet = age >= 52 ? '<path d="M274 414l-20-6M277 423l-22 2M494 414l20-6M491 423l22 2"/>' : "";
  return `<g fill="none" stroke="${dark}" stroke-width="2.7" stroke-linecap="round" opacity="${opacity}">${underEyes}${forehead}${mouth}${crowsFeet}</g>`;
}

function renderScar(enabled, skin) {
  if (!enabled) return "";
  return `<g stroke="${shadeHex(skin, -0.37)}" stroke-width="3.5" stroke-linecap="round" opacity=".55">
    <path d="M472 410l-22 52M463 425l13 5M456 443l13 5"/>
  </g>`;
}

function renderKit(primary, secondary, pattern) {
  const patternMarkup = [
    `<path d="M32 82L188 45M529 82L373 45" stroke="${secondary}" stroke-width="25" opacity=".9"/>`,
    `<rect x="245" y="56" width="64" height="255" rx="10" fill="${secondary}" opacity=".9"/>`,
    `<path d="M86 300L259 48M475 300L302 48" stroke="${secondary}" stroke-width="27" opacity=".88"/>`,
    `<g stroke="${secondary}" stroke-width="8" opacity=".72">${[95,145,195,245,295,345,395,445].map((x) => `<path d="M${x} 56v252"/>`).join("")}</g>`,
  ][pattern % 4];
  return `<g transform="translate(107.32 587.5)">
    ${path(SHIRT_PATHS.base, primary, 'stroke="#111" stroke-width="3"')}
    <g clip-path="url(#shirtClip)">${patternMarkup}${path(SHIRT_PATHS.shade, "#000", 'opacity=".16"')}</g>
    <path d="M219 48 Q276 111 334 48 Q322 103 276 122 Q230 103 219 48Z" fill="${secondary}" stroke="#111" stroke-width="2.5"/>
    <path d="M237 54 Q276 93 316 54 Q306 86 276 99 Q246 86 237 54Z" fill="${primary}" opacity=".9"/>
  </g>`;
}

function sourceHair(name, colour, transform = "") {
  return `<g transform="${transform}">${renderPaths(HAIR_PATHS[name], colour, { opacity: .18, width: 2.7 })}</g>`;
}

function renderRearHair(kind, colour) {
  if (!kind) return "";
  const stroke = "#17110f";
  const shadow = shadeHex(colour, -0.16);
  if (kind === "longStraight") {
    return `<g stroke="${stroke}" stroke-width="3" stroke-linejoin="round">
      <path d="M224 1C126 1 65 47 45 121 25 198 47 292 23 414h131c-14-71-10-140 5-207 14-64 34-130 65-206Z" fill="${colour}"/>
      <path d="M224 1c98 0 159 46 179 120 20 77-2 171 22 293H294c14-71 10-140-5-207-14-64-34-130-65-206Z" fill="${colour}"/>
      <path d="M127 76c-37 84-38 199-17 316H78c-16-112-12-223 49-316Zm194 0c37 84 38 199 17 316h32c16-112 12-223-49-316Z" fill="${shadow}" opacity=".28" stroke="none"/>
    </g>`;
  }
  return `<g stroke="${stroke}" stroke-width="3" stroke-linejoin="round">
    <path d="M224 1C128 1 67 45 47 112c-22 73 17 113-8 171-22 51 7 82-17 131h143c-24-58 4-101-11-153-17-58 17-132 70-260Z" fill="${colour}"/>
    <path d="M224 1c96 0 157 44 177 111 22 73-17 113 8 171 22 51-7 82 17 131H283c24-58-4-101 11-153 17-58-17-132-70-260Z" fill="${colour}"/>
    <path d="M105 98c-21 53 12 94-7 145-17 45 5 86-15 151h39c12-59-9-103 7-148 20-57-1-101-24-148Zm238 0c21 53-12 94 7 145 17 45-5 86 15 151h-39c-12-59 9-103-7-148-20-57 1-101 24-148Z" fill="${shadow}" opacity=".28" stroke="none"/>
  </g>`;
}

function renderFrontHair(kind, colour) {
  const stroke = "#17110f";
  const shadow = shadeHex(colour, -0.16);
  if (kind === "sidePart") {
    return `<g stroke="${stroke}" stroke-width="3" stroke-linejoin="round">
      <path d="M74 282c12-111 70-178 151-178 78 0 137 55 159 151-48-27-93-45-139-53-54-10-105 12-171 80Z" fill="${colour}"/>
      <path d="M225 105c-13 36-10 68 8 97-8-35-2-66 18-93Z" fill="${shadow}" opacity=".42" stroke="none"/>
      <path d="M95 253c50-38 94-56 136-54 53 2 96 17 132 43-45-17-89-26-132-26-43 0-88 12-136 37Z" fill="${shadow}" opacity=".22" stroke="none"/>
    </g>`;
  }
  if (kind === "mediumSide") {
    return `<g stroke="${stroke}" stroke-width="3" stroke-linejoin="round">
      <path d="M62 326c-2-132 60-220 160-220 91 0 150 66 169 181-51-33-99-54-146-63-58-11-115 18-183 102Z" fill="${colour}"/>
      <path d="M70 278c-8 42-5 82 8 119-25-22-37-51-34-88 2-23 11-43 26-61Zm314-20c16 35 23 70 19 105-3 26-13 47-30 64 9-49 7-94-6-135Z" fill="${colour}"/>
      <path d="M221 108c-12 40-7 77 21 112-15-42-9-77 18-105Z" fill="${shadow}" opacity=".4" stroke="none"/>
    </g>`;
  }
  if (kind === "undercut") return sourceHair("undercut", colour, "translate(13 24) scale(.94)");
  if (kind === "crop") {
    return `<g stroke="${stroke}" stroke-width="3" stroke-linejoin="round">
      <path d="M72 281C82 173 142 112 226 112c85 0 145 61 156 169-36-37-90-55-157-55-65 0-117 18-153 55Z" fill="${colour}"/>
      <path d="M93 250c39-30 84-44 134-44 51 0 96 14 134 44-41-18-85-26-134-26-48 0-93 8-134 26Z" fill="${shadow}" opacity=".28" stroke="none"/>
    </g>`;
  }
  if (kind === "crew") {
    return `<g stroke="${stroke}" stroke-width="3" stroke-linejoin="round">
      <path d="M79 278C91 156 151 96 226 96s135 60 148 182c-40-32-89-47-148-47-58 0-107 15-147 47Z" fill="${colour}"/>
      <path d="M117 206l18-48 18 33 22-57 20 43 27-67 23 62 22-44 21 54 25-34 22 61c-54-21-133-22-194-3Z" fill="${shadow}" opacity=".22" stroke="none"/>
    </g>`;
  }
  if (kind === "softSpiky") {
    return `<g stroke="${stroke}" stroke-width="3" stroke-linejoin="round">
      <path d="M72 292 91 218 116 231 126 164 157 184 177 119 210 158 239 91 263 157 302 113 318 181 354 154 360 226 390 218 383 293c-43-39-96-58-158-58-61 0-112 19-153 57Z" fill="${colour}"/>
      <path d="M103 252c44-25 86-36 126-35 46 1 88 13 127 37-43-13-85-19-128-19-42 0-84 6-125 17Z" fill="${shadow}" opacity=".24" stroke="none"/>
    </g>`;
  }
  if (kind === "curly") {
    const curls = [
      [104,210,35],[139,173,38],[181,150,40],[226,142,42],[270,151,40],[311,176,38],[346,214,35],
      [122,237,37],[168,214,41],[217,205,43],[266,214,41],[314,239,37],
    ].map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${colour}" stroke="${stroke}" stroke-width="3"/>`).join("");
    return `<g>${curls}<path d="M90 278c32-36 77-55 136-55 58 0 104 19 137 55-41-24-86-35-137-35-52 0-97 11-136 35Z" fill="${shadow}" opacity=".25"/></g>`;
  }
  if (kind === "fade") {
    return `<g stroke="${stroke}" stroke-width="3" stroke-linejoin="round">
      <path d="M93 285c7-92 23-138 54-168 25-24 51-35 79-35 29 0 55 11 79 35 31 30 48 76 55 168-34-31-79-47-134-47-54 0-99 16-133 47Z" fill="${colour}"/>
      <path d="M93 238c27 24 54 35 82 39M360 238c-27 24-54 35-82 39" fill="none" stroke="${shadow}" stroke-width="16" opacity=".65"/>
      <path d="M132 187c55-42 131-43 190 0-49-19-112-20-190 0Z" fill="${shadow}" opacity=".27" stroke="none"/>
    </g>`;
  }
  if (kind === "braids") {
    const rows = [112,145,178,211,244,277,310,343].map((x, index) => {
      const topX = 226 + (x - 226) * .34;
      return `<path d="M${x} 246 Q${x + (index < 4 ? 12 : -12)} 173 ${topX} 101" fill="none" stroke="${shadow}" stroke-width="8" stroke-linecap="round" opacity=".72"/>
        <path d="M${x - 4} 224l9 5m-11-28 10 5m-10-28 10 5m-8-27 9 4" stroke="${shadeHex(colour, .08)}" stroke-width="3" opacity=".8"/>`;
    }).join("");
    return `<g stroke-linejoin="round">
      <path d="M79 270c12-117 68-181 147-181s135 64 148 181c-42-28-91-42-148-42-56 0-105 14-147 42Z" fill="${colour}" stroke="${stroke}" stroke-width="3"/>
      ${rows}
      <path d="M94 247c40-25 84-37 132-37s92 12 132 37" fill="none" stroke="${stroke}" stroke-width="3" opacity=".55"/>
    </g>`;
  }
  if (kind === "bun") {
    return `<g stroke="${stroke}" stroke-width="3" stroke-linejoin="round">
      <circle cx="226" cy="72" r="52" fill="${colour}"/>
      <path d="M76 284c13-124 72-188 150-188 79 0 138 64 151 188-39-35-89-53-151-53-61 0-111 18-150 53Z" fill="${colour}"/>
      <path d="M111 244c37-25 75-37 115-37 41 0 79 12 116 37-40-12-79-18-116-18-38 0-76 6-115 18Z" fill="${shadow}" opacity=".28" stroke="none"/>
    </g>`;
  }
  if (kind === "longStraight" || kind === "longWavy") {
    const wave = kind === "longWavy" ? 18 : 0;
    return `<g stroke="${stroke}" stroke-width="3" stroke-linejoin="round">
      <path d="M67 317c3-137 63-220 159-220 94 0 154 77 163 205-47-40-96-64-149-72-58-8-114 20-173 87Z" fill="${colour}"/>
      <path d="M226 98c-16 42-12 86 13 132-11-50-3-91 25-124Z" fill="${shadow}" opacity=".42" stroke="none"/>
      <path d="M82 278Q${112-wave} 245 ${144+wave} 225M370 272Q${342+wave} 242 ${310-wave} 224" fill="none" stroke="${shadow}" stroke-width="8" opacity=".4"/>
    </g>`;
  }
  return sourceHair("undercut", colour, "translate(13 24) scale(.94)");
}

function renderBeard(kind, colour, skin, age) {
  if (!kind) return "";
  const stroke = shadeHex(colour, -0.18);
  if (kind === "stubble") {
    const opacity = age <= 20 ? 0.24 : 0.32;
    return `<g transform="translate(223.48 402.09)" fill="${stroke}" opacity="${opacity}">
      <path d="M42 118c18 49 62 78 118 78s101-29 119-78c-12 66-55 105-119 105S54 184 42 118Z"/>
    </g>`;
  }
  if (kind === "short") {
    return `<g transform="translate(223.48 402.09)">
      <path d="M61 112c20 37 54 57 99 57s80-20 100-57c-10 58-47 88-100 88S71 170 61 112Z" fill="${colour}" stroke="${stroke}" stroke-width="2.6"/>
      <path d="M105 105c20-10 38-14 55-14 18 0 36 4 56 14-20 3-38 4-56 4-17 0-35-1-55-4Z" fill="${colour}"/>
    </g>`;
  }
  if (kind === "full") {
    return `<g transform="translate(223.48 402.09)">${renderPaths(BEARD_PATHS.fullBeard, colour, { opacity: .18, width: 2.6 })}</g>`;
  }
  if (kind === "goatee") {
    return `<g transform="translate(223.48 402.09)" fill="${colour}" stroke="${stroke}" stroke-width="2.5">
      <path d="M122 104c14-8 26-12 38-12s25 4 39 12c-14 4-27 6-39 6s-25-2-38-6Z"/>
      <path d="M132 163c8-9 18-13 28-13 11 0 21 4 29 13-4 35-14 56-29 62-14-6-24-27-28-62Z"/>
    </g>`;
  }
  return `<g transform="translate(223.48 402.09)"><path d="M104 104c17-13 37-18 56-8 20-10 40-5 57 8-18 9-38 10-57 3-18 7-38 6-56-3Z" fill="${colour}" stroke="${stroke}" stroke-width="2.5"/></g>`;
}

export function describeToonMapping(profile) {
  const values = getFaceValues(profile);
  const hairColour = resolveHairColour(profile, values);
  return {
    renderer: "sports/toon-prototype",
    polishVersion: "0.3.1",
    frontHair: values.hairVisible === 1 ? mappedHair(values) : null,
    rearHair: mappedRearHair(values),
    eyes: mappedEyes(values),
    eyebrows: mappedBrows(values),
    mouth: mappedMouth(values),
    beardRequested: [null, "stubble", "short", "full", "goatee", "moustache"][values.beard] ?? null,
    beardRendered: mappedBeard(values, profile.age),
    hairColour: hairColour.colour,
    greyLevel: Number(hairColour.greyLevel.toFixed(3)),
    prematureGreySuppressed: hairColour.prematureGreySuppressed,
    morphology: morphFor(values),
    expressionMode: "neutral-portrait",
  };
}

export function buildToonSvg(profile, { showAge = true } = {}) {
  const values = getFaceValues(profile);
  const skin = TOON_SKIN_COLORS[values.skin % TOON_SKIN_COLORS.length];
  const hairInfo = resolveHairColour(profile, values);
  const hair = hairInfo.colour;
  const eye = TOON_EYE_COLORS[values.eyeColor % TOON_EYE_COLORS.length];
  const frontHair = mappedHair(values);
  const rearHair = mappedRearHair(values);
  const beard = mappedBeard(values, profile.age);
  const { sx, sy } = morphFor(values);
  const title = `Sports Face ${profile.seed} · Toon polish`;
  const ageBadge = showAge ? `<g><rect x="20" y="20" width="128" height="44" rx="14" fill="#071018" opacity=".84"/><text x="40" y="50" fill="#f8fafc" font-size="22" font-family="system-ui,sans-serif" font-weight="700">${profile.age} años</text></g>` : "";
  const rear = rearHair ? `<g transform="translate(160.62 339.51)">${renderRearHair(rearHair, hair)}</g>` : "";
  const hairFront = values.hairVisible === 1 ? `<g transform="translate(158.16)">${renderFrontHair(frontHair, hair)}</g>` : "";
  const beardMarkup = renderBeard(beard, hair, skin, profile.age);
  const backgroundSeed = hashSeed(`toon-bg:${profile.seed}`) % 4;
  const bg2 = ["#194b3d", "#243b63", "#57314f", "#3e4650"][backgroundSeed];
  const kitPattern = hashSeed(`toon-kit:${profile.seed}`) % 4;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768" viewBox="0 0 768 768" role="img" aria-label="${title}" data-expression-mode="neutral-portrait">
    <title>${title}</title>
    <metadata>ToonHead by Johan Melin, CC BY 4.0; modified for Sports Face MVP. Polish version 0.3.1.</metadata>
    <defs>
      <radialGradient id="bg"><stop offset="0" stop-color="${shadeHex(bg2,.18)}"/><stop offset="1" stop-color="${shadeHex(bg2,-.24)}"/></radialGradient>
      <radialGradient id="skinGradient" cx="35%" cy="26%" r="83%"><stop offset="0" stop-color="${shadeHex(skin,.08)}"/><stop offset=".62" stop-color="${skin}"/><stop offset="1" stop-color="${shadeHex(skin,-.12)}"/></radialGradient>
      <linearGradient id="bodyGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${skin}"/><stop offset="1" stop-color="${shadeHex(skin,-.1)}"/></linearGradient>
      <linearGradient id="vignette" x1="0" y1="0" x2="0" y2="1"><stop offset=".52" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".4"/></linearGradient>
      <clipPath id="shirtClip" clipPathUnits="userSpaceOnUse">${path(SHIRT_PATHS.base, "#fff")}</clipPath>
    </defs>
    <rect width="768" height="768" fill="url(#bg)"/>
    <g transform="translate(124 556)">${path(BODY_PATHS.base, "url(#bodyGradient)", 'stroke="#111" stroke-width="3"')}${path(BODY_PATHS.shade, "#000", 'opacity=".14"')}</g>
    ${renderKit(hex(profile.kit.primary), hex(profile.kit.secondary), kitPattern)}
    <g transform="translate(384 384) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(-384 -384)">
      ${rear}
      <g transform="translate(186.52 139.5)">${path(HEAD_PATHS.base, "url(#skinGradient)", 'stroke="#17110f" stroke-width="3.1"')}${path(HEAD_PATHS.shade, "#000", 'opacity=".13"')}</g>
      <g transform="translate(253 367)">${renderEyes(mappedEyes(values), eye)}</g>
      <g transform="translate(265.82 287.36)">${renderBrows(mappedBrows(values), hair)}</g>
      ${renderNose(values.nose, skin)}
      <g transform="translate(326 487)">${renderMouth(mappedMouth(values), skin)}</g>
      ${renderFreckles(profile.seed, values.freckles === 1, skin)}
      ${renderScar(values.scar === 1, skin)}
      ${beardMarkup}
      ${renderAge(profile.age, skin)}
      ${hairFront}
      ${renderGlasses(values.glasses === 1, profile, values)}
    </g>
    <rect width="768" height="768" fill="url(#vignette)"/>
    ${ageBadge}
  </svg>`;
}

export function renderToonFace(canvas, profile, options = {}) {
  if (!canvas || typeof canvas.getContext !== "function") return Promise.reject(new TypeError("renderToonFace necesita un canvas compatible"));
  const token = Symbol("toon-render");
  canvasTokens.set(canvas, token);
  const svg = buildToonSvg(profile, options);
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
    image.onerror = () => reject(new Error("No se pudo rasterizar el retrato Toon Head"));
    image.src = uri;
  });
}

export { TOON_HEAD_ATTRIBUTION };
