import assert from "node:assert/strict";
import fs from "node:fs";
import { createProfile, formatFaceCode, hashSeed, setFeature } from "../src/face-model.js";
import {
  DEFAULT_RENDER_STYLE,
  GNM_MORPH_RENDER_STYLE,
  RENDER_STYLES,
  MORPH_RENDER_STYLE,
  TOON_RENDER_STYLE,
  buildToonSvg,
  describeRender,
} from "../src/render-router.js";
import { TOON_HEAD_ATTRIBUTION } from "../src/toon-head-assets.js";

assert.deepEqual(RENDER_STYLES.map((item) => item.id), [DEFAULT_RENDER_STYLE, TOON_RENDER_STYLE, MORPH_RENDER_STYLE, GNM_MORPH_RENDER_STYLE]);
assert.equal(RENDER_STYLES[1].label, "Sports Toon Polish v0.3.1");
assert.equal(TOON_HEAD_ATTRIBUTION.creator, "Johan Melin");
assert.equal(TOON_HEAD_ATTRIBUTION.license, "CC BY 4.0");

const neutralEyes = new Set(["almond", "round", "deep", "narrow", "upturned", "downturned"]);
const neutralBrows = new Set(["soft", "flat", "arched", "thick", "short", "angular", "low", "high"]);
const neutralMouths = new Set(["neutral", "wide", "narrow", "full", "thin", "slightSmile", "softDownturn"]);

const baseline = JSON.parse(fs.readFileSync(new URL("../baseline/visual-baseline.json", import.meta.url), "utf8"));
for (const entry of baseline.entries) {
  const before = formatFaceCode(entry.profile);
  const first = buildToonSvg(entry.profile);
  const second = buildToonSvg(entry.profile);
  const mapping = describeRender(entry.profile, TOON_RENDER_STYLE);

  assert.equal(first, second, `${entry.id}: Toon SVG not deterministic`);
  assert.match(first, /^<svg /, `${entry.id}: SVG missing`);
  assert.match(first, /ToonHead by Johan Melin, CC BY 4.0/, `${entry.id}: attribution metadata missing`);
  assert.match(first, /data-expression-mode="neutral-portrait"/, `${entry.id}: neutral expression metadata missing`);
  assert.match(first, /clipPathUnits="userSpaceOnUse"/, `${entry.id}: kit clipping is not portable`);
  assert.ok(!first.includes("undefined"), `${entry.id}: undefined in SVG`);
  assert.ok(!first.includes("NaN"), `${entry.id}: NaN in SVG`);
  assert.equal(formatFaceCode(entry.profile), before, `${entry.id}: renderer changed FaceDNA`);
  assert.equal(mapping.renderer, TOON_RENDER_STYLE);
  assert.equal(mapping.polishVersion, "0.3.1");
  assert.equal(mapping.expressionMode, "neutral-portrait");
  assert.ok(neutralEyes.has(mapping.eyes), `${entry.id}: non-neutral eyes ${mapping.eyes}`);
  assert.ok(neutralBrows.has(mapping.eyebrows), `${entry.id}: non-neutral brows ${mapping.eyebrows}`);
  assert.ok(neutralMouths.has(mapping.mouth), `${entry.id}: non-neutral mouth ${mapping.mouth}`);
}

// Every FaceDNA eye/brow/mouth variant must map to a distinct neutral portrait category.
let probe = createProfile({ seed: hashSeed("toon-polish-probe"), age: 27, presentation: "neutral" });
const eyeMappings = [];
for (let index = 0; index < 6; index += 1) {
  probe = setFeature(probe, "eyes", index);
  eyeMappings.push(describeRender(probe, TOON_RENDER_STYLE).eyes);
}
assert.equal(new Set(eyeMappings).size, 6);

const browMappings = [];
for (let index = 0; index < 8; index += 1) {
  probe = setFeature(probe, "brows", index);
  browMappings.push(describeRender(probe, TOON_RENDER_STYLE).eyebrows);
}
assert.equal(new Set(browMappings).size, 8);

const mouthMappings = [];
for (let index = 0; index < 7; index += 1) {
  probe = setFeature(probe, "mouth", index);
  mouthMappings.push(describeRender(probe, TOON_RENDER_STYLE).mouth);
}
assert.equal(new Set(mouthMappings).size, 7);

// Strong grey is visually suppressed in young players without changing FaceDNA.
let youngGrey = createProfile({ seed: hashSeed("young-grey"), age: 19, presentation: "masculine" });
youngGrey = setFeature(youngGrey, "hairColor", 7);
const youngGreyCode = formatFaceCode(youngGrey);
const youngGreyMapping = describeRender(youngGrey, TOON_RENDER_STYLE);
assert.equal(youngGreyMapping.prematureGreySuppressed, true);
assert.equal(youngGreyMapping.greyLevel, 0);
assert.equal(formatFaceCode(youngGrey), youngGreyCode);

let olderGrey = createProfile({ seed: hashSeed("older-grey"), age: 55, presentation: "masculine" });
olderGrey = setFeature(olderGrey, "hairColor", 7);
const olderGreyMapping = describeRender(olderGrey, TOON_RENDER_STYLE);
assert.equal(olderGreyMapping.prematureGreySuppressed, false);
assert.ok(olderGreyMapping.greyLevel >= 0.7);

// Dense beards are visually capped for young players while the saved appearance bits remain intact.
let youngBeard = createProfile({ seed: hashSeed("young-beard"), age: 19, presentation: "masculine" });
youngBeard = setFeature(youngBeard, "beard", 3);
const youngBeardCode = formatFaceCode(youngBeard);
assert.equal(describeRender(youngBeard, TOON_RENDER_STYLE).beardRequested, "full");
assert.equal(describeRender(youngBeard, TOON_RENDER_STYLE).beardRendered, "stubble");
assert.equal(formatFaceCode(youngBeard), youngBeardCode);

let adultBeard = createProfile({ seed: hashSeed("adult-beard"), age: 27, presentation: "masculine" });
adultBeard = setFeature(adultBeard, "beard", 3);
assert.equal(describeRender(adultBeard, TOON_RENDER_STYLE).beardRendered, "full");

for (let index = 0; index < 1000; index += 1) {
  const profile = createProfile({
    seed: hashSeed(`toon-polish-test:${index}`),
    age: 16 + (index % 45),
    presentation: ["masculine", "feminine", "neutral"][index % 3],
  });
  const code = formatFaceCode(profile);
  const svg = buildToonSvg(profile, { showAge: index % 2 === 0 });
  const mapping = describeRender(profile, TOON_RENDER_STYLE);
  assert.equal(formatFaceCode(profile), code);
  assert.match(svg, /viewBox="0 0 768 768"/);
  assert.ok(svg.length > 4500);
  assert.ok(neutralEyes.has(mapping.eyes));
  assert.ok(neutralBrows.has(mapping.eyebrows));
  assert.ok(neutralMouths.has(mapping.mouth));
}

console.log("Toon polish tests passed: 100 frozen identities + neutral mapping, age plausibility and 1,000 generated profiles.");
