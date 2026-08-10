/*
 * Sports Face MVP vector renderer
 * SPDX-License-Identifier: GPL-2.0-only
 */

import { getFaceValues, hashSeed, Randomizer } from "./face-model.js";

const SKINS = Object.freeze([
  { base: "#f6d2b8", light: "#ffe5d3", shadow: "#c98f70", line: "#704638", blush: "#db8b86" },
  { base: "#eab58f", light: "#f8cfad", shadow: "#b87857", line: "#684235", blush: "#cc7f78" },
  { base: "#d99a6c", light: "#eeb78e", shadow: "#a86141", line: "#5b392f", blush: "#be6d66" },
  { base: "#c88052", light: "#dda071", shadow: "#8e4c33", line: "#4e3029", blush: "#ac615a" },
  { base: "#ac673f", light: "#c98459", shadow: "#743a28", line: "#40271f", blush: "#96514d" },
  { base: "#895032", light: "#a86a46", shadow: "#5b2e20", line: "#321f1a", blush: "#76413e" },
  { base: "#673b27", light: "#855339", shadow: "#422219", line: "#241714", blush: "#5b3533" },
  { base: "#4a2a1e", light: "#653d2c", shadow: "#2d1812", line: "#180f0d", blush: "#432827" },
]);

const HAIR = Object.freeze([
  "#15120f", "#2b1c16", "#4a2a1e", "#6f3f26", "#9a5e32", "#d0a45f", "#c47a3a", "#8b8b88",
]);

const EYES = Object.freeze(["#25190f", "#4b321f", "#7a5228", "#51646c", "#3d6f62", "#748a9c"]);

const HEADS = Object.freeze([
  { width: 250, height: 305, temple: 0.48, jaw: 0.39, chin: 0.22, top: 0.42 },
  { width: 278, height: 294, temple: 0.50, jaw: 0.44, chin: 0.25, top: 0.45 },
  { width: 235, height: 320, temple: 0.46, jaw: 0.35, chin: 0.18, top: 0.39 },
  { width: 290, height: 310, temple: 0.50, jaw: 0.47, chin: 0.29, top: 0.47 },
  { width: 258, height: 288, temple: 0.48, jaw: 0.41, chin: 0.30, top: 0.43 },
  { width: 270, height: 326, temple: 0.49, jaw: 0.37, chin: 0.17, top: 0.40 },
]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mixHex(a, b, t) {
  const parse = (hex) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  const aa = parse(a);
  const bb = parse(b);
  const cc = aa.map((value, index) => Math.round(value + (bb[index] - value) * t));
  return `#${cc.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function headPath(spec) {
  const cx = 256;
  const top = 70;
  const bottom = top + spec.height;
  const half = spec.width / 2;
  const templeX = half * spec.temple * 2;
  const jawX = half * spec.jaw * 2;
  const path = new Path2D();
  path.moveTo(cx, top);
  path.bezierCurveTo(cx - half * spec.top, top - 2, cx - templeX, top + 25, cx - half, top + 94);
  path.bezierCurveTo(cx - half - 2, top + 176, cx - jawX, bottom - 72, cx - spec.width * spec.chin, bottom - 22);
  path.bezierCurveTo(cx - 36, bottom + 4, cx - 16, bottom + 8, cx, bottom + 9);
  path.bezierCurveTo(cx + 16, bottom + 8, cx + 36, bottom + 4, cx + spec.width * spec.chin, bottom - 22);
  path.bezierCurveTo(cx + jawX, bottom - 72, cx + half + 2, top + 176, cx + half, top + 94);
  path.bezierCurveTo(cx + templeX, top + 25, cx + half * spec.top, top - 2, cx, top);
  path.closePath();
  return path;
}

function drawBackdrop(ctx, profile) {
  const randomizer = new Randomizer(hashSeed(profile.seed) ^ 0x09273a4f);
  const hue = randomizer.int(360);
  const gradient = ctx.createLinearGradient(0, 0, 512, 512);
  gradient.addColorStop(0, `hsl(${hue} 30% 19%)`);
  gradient.addColorStop(1, `hsl(${(hue + 30) % 360} 28% 9%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 512, 512);

  ctx.globalAlpha = 0.13;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  for (let x = -512; x < 1024; x += 36) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x - 512, 512);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const vignette = ctx.createRadialGradient(256, 235, 80, 256, 260, 330);
  vignette.addColorStop(0, "rgba(255,255,255,0.07)");
  vignette.addColorStop(1, "rgba(0,0,0,0.58)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, 512, 512);
}

function drawKit(ctx, profile) {
  ctx.save();
  const shoulder = new Path2D();
  shoulder.moveTo(52, 512);
  shoulder.bezierCurveTo(74, 432, 142, 404, 204, 399);
  shoulder.lineTo(308, 399);
  shoulder.bezierCurveTo(370, 404, 438, 432, 460, 512);
  shoulder.closePath();
  const gradient = ctx.createLinearGradient(0, 395, 0, 512);
  gradient.addColorStop(0, mixHex(profile.kit.primary, "#ffffff", 0.13));
  gradient.addColorStop(1, mixHex(profile.kit.primary, "#000000", 0.28));
  ctx.fillStyle = gradient;
  ctx.fill(shoulder);

  ctx.clip(shoulder);
  ctx.strokeStyle = profile.kit.secondary;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.moveTo(118, 420);
  ctx.lineTo(185, 512);
  ctx.moveTo(394, 420);
  ctx.lineTo(327, 512);
  ctx.stroke();
  ctx.globalAlpha = 0.16;
  ctx.lineWidth = 2;
  for (let x = 40; x < 480; x += 18) {
    ctx.beginPath();
    ctx.moveTo(x, 404);
    ctx.lineTo(x + 42, 512);
    ctx.stroke();
  }
  ctx.restore();

  ctx.fillStyle = profile.kit.secondary;
  ctx.beginPath();
  ctx.arc(256, 424, 41, Math.PI, 0);
  ctx.lineTo(296, 443);
  ctx.arc(256, 444, 40, 0, Math.PI, true);
  ctx.closePath();
  ctx.fill();
}

function drawNeck(ctx, skin) {
  const gradient = ctx.createLinearGradient(210, 355, 302, 438);
  gradient.addColorStop(0, skin.shadow);
  gradient.addColorStop(0.46, skin.base);
  gradient.addColorStop(1, skin.shadow);
  ctx.fillStyle = gradient;
  roundRect(ctx, 210, 342, 92, 105, 27);
  ctx.fill();
}

function drawHairBack(ctx, style, color, spec, visible) {
  if (!visible || ![7, 10, 11].includes(style)) return;
  ctx.fillStyle = color;
  ctx.strokeStyle = mixHex(color, "#000000", 0.45);
  ctx.lineWidth = 4;
  const path = new Path2D();
  path.moveTo(150, 100);
  path.bezierCurveTo(92, 168, 104, 330, 142, 420);
  path.bezierCurveTo(172, 448, 202, 415, 212, 361);
  path.lineTo(300, 361);
  path.bezierCurveTo(310, 415, 340, 448, 370, 420);
  path.bezierCurveTo(408, 330, 420, 168, 362, 100);
  path.bezierCurveTo(320, 47, 192, 47, 150, 100);
  path.closePath();
  ctx.fill(path);
  ctx.stroke(path);
}

function drawEars(ctx, spec, skin, seed, earShape = 0) {
  const randomizer = new Randomizer(seed ^ 0x17d2a711);
  const y = 222 + randomizer.int(12);
  const earWidthAdjust = [-5, -3, 4, 8][earShape] ?? 0;
  const earHeightAdjust = [0, -8, 9, 4][earShape] ?? 0;
  const width = 31 + randomizer.int(8) + earWidthAdjust;
  const height = 65 + randomizer.int(12) + earHeightAdjust;
  const half = spec.width / 2;
  for (const direction of [-1, 1]) {
    const x = 256 + direction * (half - 2);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(direction, 1);
    ctx.fillStyle = skin.base;
    ctx.strokeStyle = skin.line;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(0, 0, width, height / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = mixHex(skin.shadow, skin.line, 0.35);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(-2, 0, width * 0.48, -1.1, 1.2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawHead(ctx, spec, skin, age) {
  const path = headPath(spec);
  ctx.fillStyle = skin.base;
  ctx.strokeStyle = skin.line;
  ctx.lineWidth = 5;
  ctx.fill(path);
  ctx.stroke(path);

  ctx.save();
  ctx.clip(path);
  const light = ctx.createRadialGradient(205, 145, 30, 218, 194, 210);
  light.addColorStop(0, skin.light);
  light.addColorStop(0.45, skin.base);
  light.addColorStop(1, skin.shadow);
  ctx.globalAlpha = 0.47;
  ctx.fillStyle = light;
  ctx.fillRect(90, 50, 340, 370);

  const rightShadow = ctx.createLinearGradient(225, 0, 380, 0);
  rightShadow.addColorStop(0, "rgba(0,0,0,0)");
  rightShadow.addColorStop(1, "rgba(0,0,0,0.25)");
  ctx.globalAlpha = 0.62;
  ctx.fillStyle = rightShadow;
  ctx.fillRect(230, 60, 190, 350);

  ctx.globalAlpha = clamp((age - 28) / 60, 0, 0.22);
  ctx.fillStyle = "#6d4b3c";
  for (let y = 110; y < 365; y += 5) {
    for (let x = 135; x < 380; x += 5) {
      if (((x * 13 + y * 7) % 29) === 0) ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.restore();
}

function drawEyes(ctx, style, spec, skin, eyeColor, seed) {
  const randomizer = new Randomizer(seed ^ 0xac19ff09);
  const spacing = 53 + (style === 2 ? 5 : style === 4 ? -4 : 0);
  const y = 218 + (style === 3 ? 5 : style === 4 ? -3 : 0);
  const width = [54, 49, 56, 52, 50, 58][style];
  const height = [24, 30, 18, 22, 27, 20][style];
  const pupilOffset = randomizer.int(7) - 3;

  for (const direction of [-1, 1]) {
    const x = 256 + direction * spacing;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(direction, 1);
    const eye = new Path2D();
    eye.moveTo(-width / 2, 1);
    eye.quadraticCurveTo(0, -height, width / 2, style === 3 ? 4 : 0);
    eye.quadraticCurveTo(0, height, -width / 2, 1);
    eye.closePath();
    ctx.fillStyle = "#f7f5ef";
    ctx.strokeStyle = skin.line;
    ctx.lineWidth = 4;
    ctx.fill(eye);
    ctx.stroke(eye);

    const irisR = Math.min(13, height * 0.72);
    ctx.fillStyle = eyeColor;
    ctx.beginPath();
    ctx.arc(pupilOffset, 2, irisR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#090909";
    ctx.beginPath();
    ctx.arc(pupilOffset, 2, irisR * 0.52, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    ctx.arc(pupilOffset - 4, -3, 3.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawBrows(ctx, style, hairColor, skin, age) {
  const y = 178 + (style % 3) * 3;
  const thickness = 5 + (style % 4);
  const angle = [-8, -3, 2, 7, -5, 4, 10, 0][style] * (Math.PI / 180);
  ctx.strokeStyle = mixHex(hairColor, skin.line, 0.25);
  ctx.lineWidth = thickness;
  ctx.lineCap = "round";
  for (const direction of [-1, 1]) {
    ctx.save();
    ctx.translate(256 + direction * 54, y);
    ctx.scale(direction, 1);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(-29, style === 6 ? 5 : 2);
    ctx.quadraticCurveTo(0, -8 - (style % 2) * 3, 31, style === 2 ? 3 : 0);
    ctx.stroke();
    ctx.restore();
  }

  if (age > 34) {
    ctx.globalAlpha = clamp((age - 34) / 30, 0, 0.34);
    ctx.strokeStyle = skin.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(191, y - 18);
    ctx.quadraticCurveTo(220, y - 27, 244, y - 20);
    ctx.moveTo(268, y - 20);
    ctx.quadraticCurveTo(294, y - 27, 321, y - 18);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawNose(ctx, style, skin) {
  const lengths = [55, 62, 70, 49, 67, 58, 74, 52];
  const widths = [34, 42, 31, 47, 38, 29, 44, 36];
  const length = lengths[style];
  const width = widths[style];
  const y0 = 225;
  ctx.strokeStyle = mixHex(skin.shadow, skin.line, 0.38);
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  if ([0, 4, 6].includes(style)) {
    ctx.moveTo(252, y0);
    ctx.bezierCurveTo(246, y0 + 25, 244, y0 + length - 18, 236, y0 + length);
  } else {
    ctx.moveTo(259, y0);
    ctx.bezierCurveTo(264, y0 + 24, 267, y0 + length - 18, 274, y0 + length);
  }
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(256 - width / 2, y0 + length + 1);
  ctx.quadraticCurveTo(256 - 5, y0 + length + 11, 256, y0 + length + 5);
  ctx.quadraticCurveTo(256 + 5, y0 + length + 11, 256 + width / 2, y0 + length + 1);
  ctx.stroke();

  ctx.fillStyle = mixHex(skin.shadow, skin.line, 0.45);
  ctx.beginPath();
  ctx.ellipse(256 - width * 0.28, y0 + length + 4, 3.5, 2, 0, 0, Math.PI * 2);
  ctx.ellipse(256 + width * 0.28, y0 + length + 4, 3.5, 2, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawMouth(ctx, style, skin) {
  const y = 328;
  const widths = [58, 67, 52, 72, 61, 47, 64];
  const width = widths[style];
  const curve = [-2, 8, -7, 3, 0, 5, -3][style];
  ctx.strokeStyle = mixHex("#7f2433", skin.line, 0.2);
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(256 - width / 2, y);
  ctx.quadraticCurveTo(256, y + curve, 256 + width / 2, y);
  ctx.stroke();

  if ([1, 3, 5].includes(style)) {
    ctx.fillStyle = "rgba(115,25,34,0.55)";
    ctx.beginPath();
    ctx.moveTo(256 - width * 0.37, y + 2);
    ctx.quadraticCurveTo(256, y + 15, 256 + width * 0.37, y + 2);
    ctx.quadraticCurveTo(256, y + 8, 256 - width * 0.37, y + 2);
    ctx.fill();
  }
}

function drawFreckles(ctx, skin, seed, enabled) {
  if (!enabled) return;
  const randomizer = new Randomizer(seed ^ 0x2f09d31a);
  ctx.fillStyle = mixHex(skin.shadow, skin.line, 0.15);
  ctx.globalAlpha = 0.42;
  for (let index = 0; index < 28; index += 1) {
    const side = index % 2 === 0 ? -1 : 1;
    const x = 256 + side * (22 + randomizer.int(70));
    const y = 276 + randomizer.int(38) - 18;
    const radius = 0.9 + randomizer.nextFloat() * 1.3;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawScar(ctx, skin, seed, enabled) {
  if (!enabled) return;
  const side = (seed & 1) === 0 ? -1 : 1;
  ctx.strokeStyle = mixHex(skin.shadow, "#7b2630", 0.35);
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.62;
  ctx.beginPath();
  ctx.moveTo(256 + side * 80, 230);
  ctx.lineTo(256 + side * 61, 270);
  ctx.lineTo(256 + side * 72, 296);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawBeard(ctx, style, hairColor, skin, age) {
  if (style === 0) return;
  const color = mixHex(hairColor, skin.line, 0.16);
  ctx.fillStyle = color;
  ctx.strokeStyle = mixHex(color, "#000000", 0.28);
  ctx.lineWidth = 2;
  ctx.globalAlpha = style === 1 ? 0.48 : 0.88;

  if (style === 1) {
    for (let y = 305; y < 386; y += 6) {
      for (let x = 178; x < 334; x += 6) {
        const dx = (x - 256) / 82;
        const dy = (y - 347) / 48;
        if (dx * dx + dy * dy < 1 && ((x + y) % 4 === 0)) ctx.fillRect(x, y, 1.5, 1.5);
      }
    }
  } else {
    const beard = new Path2D();
    beard.moveTo(168, 305);
    beard.bezierCurveTo(170, 354, 205, 392, 256, 405 + (style === 5 ? 14 : 0));
    beard.bezierCurveTo(307, 392, 342, 354, 344, 305);
    beard.bezierCurveTo(317, 324, 299, 339, 281, 345);
    beard.quadraticCurveTo(256, 352, 231, 345);
    beard.bezierCurveTo(213, 339, 195, 324, 168, 305);
    beard.closePath();
    ctx.fill(beard);
    ctx.stroke(beard);

    if ([3, 4, 5].includes(style)) {
      ctx.beginPath();
      ctx.roundRect(225, 296, 62, style === 5 ? 26 : 18, 9);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  if (age > 33) {
    ctx.strokeStyle = "rgba(225,225,220,0.28)";
    ctx.lineWidth = 1.5;
    for (let index = 0; index < Math.min(18, age - 30); index += 1) {
      const x = 205 + (index * 23) % 105;
      const y = 337 + (index * 17) % 48;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 2, y + 5);
      ctx.stroke();
    }
  }
}

function drawHairFront(ctx, style, color, spec, visible, age) {
  if (!visible) return;
  const agedColor = age > 32 ? mixHex(color, "#b6b5ae", clamp((age - 32) / 55, 0, 0.38)) : color;
  ctx.fillStyle = agedColor;
  ctx.strokeStyle = mixHex(agedColor, "#000000", 0.48);
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";

  const half = spec.width / 2;
  const left = 256 - half + 7;
  const right = 256 + half - 7;

  const cap = new Path2D();
  switch (style) {
    case 0:
      cap.moveTo(left + 8, 143);
      cap.quadraticCurveTo(154, 59, 256, 68);
      cap.quadraticCurveTo(360, 60, right - 8, 146);
      cap.lineTo(right - 24, 165);
      cap.quadraticCurveTo(318, 122, 256, 125);
      cap.quadraticCurveTo(194, 122, left + 24, 165);
      cap.closePath();
      break;
    case 1:
      cap.moveTo(left + 10, 145);
      cap.quadraticCurveTo(165, 72, 256, 72);
      cap.quadraticCurveTo(350, 70, right - 10, 145);
      cap.lineTo(right - 16, 156);
      cap.quadraticCurveTo(256, 106, left + 16, 156);
      cap.closePath();
      break;
    case 2:
      cap.moveTo(left + 3, 154);
      cap.quadraticCurveTo(154, 54, 242, 65);
      cap.quadraticCurveTo(305, 40, right, 134);
      cap.lineTo(right - 20, 166);
      cap.quadraticCurveTo(292, 111, 221, 122);
      cap.quadraticCurveTo(177, 119, left + 18, 168);
      cap.closePath();
      break;
    case 3:
      for (let i = 0; i < 16; i += 1) {
        const angle = Math.PI + (i / 15) * Math.PI;
        const x = 256 + Math.cos(angle) * (half - 24);
        const y = 129 + Math.sin(angle) * 66;
        ctx.beginPath();
        ctx.arc(x, y, 27 + (i % 3) * 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      return;
    case 4:
      ctx.beginPath();
      ctx.ellipse(256, 118, half + 13, 82, 0, Math.PI, 0);
      ctx.lineTo(right - 16, 167);
      ctx.quadraticCurveTo(256, 105, left + 16, 167);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      return;
    case 5:
      cap.moveTo(226, 143);
      cap.lineTo(237, 55);
      cap.lineTo(255, 20);
      cap.lineTo(272, 55);
      cap.lineTo(286, 143);
      cap.quadraticCurveTo(256, 112, 226, 143);
      cap.closePath();
      break;
    case 6:
      // Very short shaved head: only a translucent scalp shadow.
      ctx.globalAlpha = 0.34;
      ctx.beginPath();
      ctx.ellipse(256, 119, half - 12, 63, 0, Math.PI, 0);
      ctx.fill();
      ctx.globalAlpha = 1;
      return;
    case 7:
      cap.moveTo(left - 4, 160);
      cap.quadraticCurveTo(148, 43, 256, 59);
      cap.quadraticCurveTo(370, 42, right + 5, 158);
      cap.lineTo(right - 4, 193);
      cap.quadraticCurveTo(315, 116, 256, 119);
      cap.quadraticCurveTo(190, 113, left + 2, 194);
      cap.closePath();
      break;
    case 8:
      cap.moveTo(left + 13, 155);
      cap.quadraticCurveTo(188, 94, 226, 100);
      cap.quadraticCurveTo(255, 43, 354, 72);
      cap.quadraticCurveTo(382, 102, right - 5, 146);
      cap.lineTo(right - 20, 165);
      cap.quadraticCurveTo(301, 100, 226, 126);
      cap.quadraticCurveTo(185, 125, left + 26, 168);
      cap.closePath();
      break;
    case 9:
      cap.moveTo(left + 15, 154);
      cap.quadraticCurveTo(179, 75, 229, 84);
      cap.quadraticCurveTo(245, 105, 256, 132);
      cap.quadraticCurveTo(267, 105, 283, 84);
      cap.quadraticCurveTo(333, 75, right - 15, 154);
      cap.lineTo(right - 23, 164);
      cap.quadraticCurveTo(315, 118, 286, 122);
      cap.quadraticCurveTo(267, 126, 256, 145);
      cap.quadraticCurveTo(245, 126, 226, 122);
      cap.quadraticCurveTo(197, 118, left + 23, 164);
      cap.closePath();
      break;
    case 10:
      cap.moveTo(left + 1, 161);
      cap.bezierCurveTo(135, 115, 155, 63, 211, 63);
      cap.bezierCurveTo(247, 35, 291, 48, 309, 70);
      cap.bezierCurveTo(366, 61, 390, 109, right - 1, 161);
      cap.lineTo(right - 12, 182);
      cap.bezierCurveTo(340, 130, 314, 127, 288, 132);
      cap.bezierCurveTo(260, 117, 231, 118, 204, 134);
      cap.bezierCurveTo(178, 127, 153, 135, left + 12, 182);
      cap.closePath();
      break;
    default:
      for (let i = 0; i < 11; i += 1) {
        const x = 170 + i * 17;
        const y = 74 + (i % 2) * 7;
        ctx.lineWidth = 10;
        ctx.beginPath();
        ctx.moveTo(x, 151);
        ctx.quadraticCurveTo(x - 7, 108, x + (i % 3 - 1) * 8, y);
        ctx.stroke();
      }
      return;
  }
  ctx.fill(cap);
  ctx.stroke(cap);
}

function drawGlasses(ctx, enabled, skin) {
  if (!enabled) return;
  ctx.strokeStyle = "rgba(20,24,28,0.9)";
  ctx.lineWidth = 6;
  for (const direction of [-1, 1]) {
    roundRect(ctx, 256 + direction * 55 - 39, 193, 78, 51, 17);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(238, 209);
  ctx.quadraticCurveTo(256, 201, 274, 209);
  ctx.stroke();
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(162, 205);
  ctx.lineTo(130, 194);
  ctx.moveTo(350, 205);
  ctx.lineTo(382, 194);
  ctx.stroke();
  ctx.fillStyle = "rgba(195,225,245,0.10)";
  ctx.fillRect(174, 197, 64, 42);
  ctx.fillRect(274, 197, 64, 42);
}

function drawAgeDetails(ctx, age, skin) {
  if (age < 29) return;
  const amount = clamp((age - 28) / 22, 0, 0.78);
  ctx.strokeStyle = mixHex(skin.shadow, skin.line, 0.42);
  ctx.globalAlpha = amount * 0.55;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(176, 250);
  ctx.quadraticCurveTo(187, 254, 196, 263);
  ctx.moveTo(336, 250);
  ctx.quadraticCurveTo(325, 254, 316, 263);
  if (age > 34) {
    ctx.moveTo(228, 154);
    ctx.quadraticCurveTo(256, 146, 284, 154);
    ctx.moveTo(221, 163);
    ctx.quadraticCurveTo(256, 156, 291, 163);
  }
  if (age > 39) {
    ctx.moveTo(200, 340);
    ctx.quadraticCurveTo(213, 350, 222, 352);
    ctx.moveTo(312, 340);
    ctx.quadraticCurveTo(299, 350, 290, 352);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawNameplate(ctx, profile) {
  ctx.save();
  ctx.globalAlpha = 0.86;
  ctx.fillStyle = "rgba(4,8,12,0.78)";
  roundRect(ctx, 18, 18, 112, 39, 11);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#f8fafc";
  ctx.font = "700 18px system-ui, sans-serif";
  ctx.fillText(`${profile.age} años`, 36, 44);
  ctx.restore();
}

export function renderFace(canvas, profile, { showAge = true } = {}) {
  if (!canvas || typeof canvas.getContext !== "function") throw new TypeError("renderFace necesita un canvas compatible");
  const ctx = canvas.getContext("2d", { alpha: false });
  const scaleX = canvas.width / 512;
  const scaleY = canvas.height / 512;
  ctx.save();
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  ctx.clearRect(0, 0, 512, 512);

  const values = getFaceValues(profile);
  const baseSpec = HEADS[values.head];
  const jawDelta = (values.jaw - 2.5) * 0.012;
  const proportionDelta = (values.faceProportion - 2.5) * 7;
  const spec = {
    ...baseSpec,
    height: clamp(baseSpec.height + proportionDelta, 270, 350),
    jaw: clamp(baseSpec.jaw + jawDelta, 0.31, 0.52),
    chin: clamp(baseSpec.chin + jawDelta * 0.5, 0.15, 0.34),
  };
  const skin = SKINS[values.skin];
  const baseHair = HAIR[values.hairColor];
  const eyeColor = EYES[values.eyeColor % EYES.length];
  const hairVisible = values.hairVisible === 1;

  drawBackdrop(ctx, profile);
  drawKit(ctx, profile);
  drawNeck(ctx, skin);
  drawHairBack(ctx, values.hair, baseHair, spec, hairVisible);
  drawEars(ctx, spec, skin, profile.seed, values.earShape);
  drawHead(ctx, spec, skin, profile.age);
  drawEyes(ctx, values.eyes, spec, skin, eyeColor, profile.seed);
  drawBrows(ctx, values.brows, baseHair, skin, profile.age);
  drawNose(ctx, values.nose, skin);
  drawFreckles(ctx, skin, profile.seed, values.freckles === 1);
  drawScar(ctx, skin, profile.seed, values.scar === 1);
  drawMouth(ctx, values.mouth, skin);
  drawBeard(ctx, values.beard, baseHair, skin, profile.age);
  drawAgeDetails(ctx, profile.age, skin);
  drawHairFront(ctx, values.hair, baseHair, spec, hairVisible, profile.age);
  drawGlasses(ctx, values.glasses === 1, skin);
  if (showAge) drawNameplate(ctx, profile);

  ctx.restore();
}

export function downloadPng(canvas, filename = "sports-face.png") {
  canvas.toBlob((blob) => {
    if (!blob) throw new Error("No se pudo generar el PNG");
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}
