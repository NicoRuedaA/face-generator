import assert from "node:assert/strict";
import {
  APPEARANCE_VARS,
  ASSET_CATALOGS,
  CURRENT_PROFILE_VERSION,
  DEFAULT_STYLE_LABEL,
  FACE_VARS,
  IDENTITY_VARS,
  ageProfile,
  canonicalizeProfile,
  changeFeature,
  createProfile,
  formatFaceCode,
  getActiveFaceVars,
  getBits,
  getFaceAssetIds,
  getFaceValues,
  hashSeed,
  parseFaceCode,
  setBits,
  setFeature,
  setPresentation,
  validateProfile,
} from "../src/face-model.js";

function checksum(text) {
  return hashSeed(text).toString(36).padStart(7, "0").slice(-7);
}

function makeLegacySf1Code({ faceBits, seed, age, presentation, primary, secondary }) {
  const p = presentation === "masculine" ? "m" : presentation === "feminine" ? "f" : "n";
  const payload = [
    "SF1",
    (faceBits >>> 0).toString(36),
    (seed >>> 0).toString(36),
    age.toString(36),
    p,
    primary.replace("#", ""),
    secondary.replace("#", ""),
  ].join("-");
  return `${payload}-${checksum(payload)}`;
}

for (const variable of FACE_VARS) {
  for (let value = 0; value < variable.validValues; value += 1) {
    const bits = setBits(0, variable, value);
    assert.equal(getBits(bits, variable), value, `${variable.key} should round-trip`);
  }
  assert.equal(
    ASSET_CATALOGS[variable.key].length,
    variable.validValues,
    `${variable.key} asset IDs must match validValues`,
  );
}

const first = createProfile({ seed: 12345, age: 24, presentation: "masculine" });
const second = createProfile({ seed: 12345, age: 24, presentation: "masculine" });
assert.deepEqual(first, second, "same inputs should produce identical FaceDNA v2");
assert.equal(first.version, CURRENT_PROFILE_VERSION);
assert.equal(first.style, DEFAULT_STYLE_LABEL);

const differentAge = createProfile({ seed: 12345, age: 41, presentation: "masculine" });
const differentPresentation = createProfile({ seed: 12345, age: 24, presentation: "feminine" });
assert.equal(first.identityBits, differentAge.identityBits, "age must not change permanent identity");
assert.equal(first.identityBits, differentPresentation.identityBits, "presentation must not change permanent identity");

const aged = ageProfile(first, 5);
assert.equal(aged.identityBits, first.identityBits, "ageing must preserve identity bits");
assert.equal(aged.appearanceBits, first.appearanceBits, "ageing must preserve selected styling");
assert.equal(aged.age, first.age + 5);

const presentationChanged = setPresentation(first, "feminine", { rerollAppearance: true });
assert.equal(presentationChanged.identityBits, first.identityBits, "changing presentation must preserve identity");
assert.equal(presentationChanged.presentation, "feminine");

const code = formatFaceCode(first);
const parsed = parseFaceCode(code);
assert.deepEqual(parsed, canonicalizeProfile(first), "FaceDNA v2 code should round-trip");
assert.throws(() => parseFaceCode(`${code.slice(0, -1)}x`), /dañado|incompleto/);

// Migration from the MVP 0.1 / SF1 layout.
let legacyBits = 0;
const legacyDefs = {
  head: { offset: 0, length: 3, validValues: 6 }, skin: { offset: 3, length: 3, validValues: 8 },
  eyes: { offset: 6, length: 3, validValues: 6 }, brows: { offset: 9, length: 3, validValues: 8 },
  nose: { offset: 12, length: 3, validValues: 8 }, mouth: { offset: 15, length: 3, validValues: 7 },
  hair: { offset: 18, length: 4, validValues: 12 }, beard: { offset: 22, length: 3, validValues: 6 },
  hairColor: { offset: 25, length: 3, validValues: 8 }, glasses: { offset: 28, length: 1, validValues: 2 },
  freckles: { offset: 29, length: 1, validValues: 2 }, hairVisible: { offset: 30, length: 1, validValues: 2 },
  scar: { offset: 31, length: 1, validValues: 2 },
};
for (const [key, value] of Object.entries({
  head: 4, skin: 5, eyes: 2, brows: 7, nose: 6, mouth: 4,
  hair: 9, beard: 3, hairColor: 2, glasses: 1, freckles: 1, hairVisible: 1, scar: 0,
})) {
  const variable = legacyDefs[key];
  const mask = ((2 ** variable.length - 1) << variable.offset) >>> 0;
  legacyBits = ((legacyBits & (~mask >>> 0)) | ((value << variable.offset) >>> 0)) >>> 0;
}
const legacyCode = makeLegacySf1Code({
  faceBits: legacyBits,
  seed: 246813579,
  age: 27,
  presentation: "masculine",
  primary: "#166534",
  secondary: "#f8fafc",
});
const migrated = parseFaceCode(legacyCode);
const migratedValues = getFaceValues(migrated);
for (const key of ["head", "skin", "eyes", "brows", "nose", "mouth", "hair", "beard", "hairColor", "glasses", "freckles", "hairVisible", "scar"]) {
  assert.equal(migratedValues[key], getBits(legacyBits, legacyDefs[key]), `SF1 migration should preserve ${key}`);
}
assert.ok(formatFaceCode(migrated).startsWith("SF2~"), "migrated profiles must export as SF2");

// Toggle dependency and canonical masking.
let bald = setFeature(first, "hair", 7);
bald = setFeature(bald, "beard", 0);
bald = setFeature(bald, "hairColor", 5);
bald = setFeature(bald, "hairVisible", 0);
const baldValues = getFaceValues(bald);
assert.equal(baldValues.hair, 0, "hidden hair must clear the hairstyle selector");
assert.equal(baldValues.hairColor, 0, "unused hair colour must be canonicalized");
assert.ok(!getActiveFaceVars(bald).has("hair"));
assert.ok(!getActiveFaceVars(bald).has("hairColor"));

let baldWithBeard = setFeature(first, "hairColor", 6);
baldWithBeard = setFeature(baldWithBeard, "beard", 3);
baldWithBeard = setFeature(baldWithBeard, "hairVisible", 0);
assert.equal(getFaceValues(baldWithBeard).hairColor, 6, "beard must keep hair colour active on bald players");
assert.ok(getActiveFaceVars(baldWithBeard).has("hairColor"));

// Editor cycling uses wrap-around rather than clamping.
const headMax = setFeature(first, "head", IDENTITY_VARS.find((v) => v.key === "head").validValues - 1);
assert.equal(getFaceValues(changeFeature(headMax, "head", 1)).head, 0);
assert.equal(getFaceValues(changeFeature(setFeature(first, "head", 0), "head", -1)).head, 5);

// Stable logical IDs are returned independently of filenames or atlas layout.
const assetIds = getFaceAssetIds(first);
assert.match(assetIds.head, /^head\//);
assert.match(assetIds.hair, /^hair\//);

// Stress validation: enough to catch range, canonicalization and serialization issues.
for (let index = 0; index < 1000; index += 1) {
  const profile = createProfile({
    seed: hashSeed(`phase1:${index}`),
    age: 16 + (index % 45),
    presentation: ["masculine", "feminine", "neutral"][index % 3],
  });
  const validation = validateProfile(profile);
  assert.equal(validation.valid, true, `profile ${index} should validate: ${validation.errors.join(", ")}`);
  assert.deepEqual(parseFaceCode(formatFaceCode(profile)), profile, `profile ${index} should serialize`);
}

assert.ok(IDENTITY_VARS.every((variable) => variable.domain === "identity"));
assert.ok(APPEARANCE_VARS.every((variable) => variable.domain === "appearance"));
console.log("FaceDNA v2 model tests passed");
