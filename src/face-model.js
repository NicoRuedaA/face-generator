/*
 * Sports Face MVP — Phase 1 / FaceDNA v2
 * SPDX-License-Identifier: GPL-2.0-only
 *
 * Temporary prototype informed by OpenTTD's company-manager face system:
 * labelled styles, compact variables, active-variable masks, palette bindings,
 * canonical face codes, legacy migration and range validation.
 *
 * This file is a new JavaScript implementation with different data layout,
 * identifiers and behaviour. It is not intended to be incorporated into the
 * final proprietary implementation.
 */

export const CURRENT_PROFILE_VERSION = 2;
export const DEFAULT_STYLE_LABEL = "sports/default-v2";

export const FaceVarType = Object.freeze({
  SPRITE: "sprite",
  PALETTE: "palette",
  TOGGLE: "toggle",
  MORPH: "morph",
});

export const FaceDomain = Object.freeze({
  IDENTITY: "identity",
  APPEARANCE: "appearance",
});

/**
 * Permanent identity. Offsets are local to identityBits and intentionally do
 * not match the temporary v1 layout or OpenTTD.
 */
export const IDENTITY_VARS = Object.freeze([
  { key: "head", label: "Forma de cabeza", type: FaceVarType.SPRITE, domain: FaceDomain.IDENTITY, offset: 0, length: 3, validValues: 6 },
  { key: "skin", label: "Tono de piel", type: FaceVarType.PALETTE, domain: FaceDomain.IDENTITY, offset: 3, length: 3, validValues: 8 },
  { key: "eyes", label: "Ojos", type: FaceVarType.SPRITE, domain: FaceDomain.IDENTITY, offset: 6, length: 3, validValues: 6 },
  { key: "brows", label: "Cejas", type: FaceVarType.SPRITE, domain: FaceDomain.IDENTITY, offset: 9, length: 3, validValues: 8 },
  { key: "nose", label: "Nariz", type: FaceVarType.SPRITE, domain: FaceDomain.IDENTITY, offset: 12, length: 3, validValues: 8 },
  { key: "mouth", label: "Boca", type: FaceVarType.SPRITE, domain: FaceDomain.IDENTITY, offset: 15, length: 3, validValues: 7 },
  { key: "freckles", label: "Pecas", type: FaceVarType.TOGGLE, domain: FaceDomain.IDENTITY, offset: 18, length: 1, validValues: 2 },
  { key: "eyeColor", label: "Color de ojos", type: FaceVarType.PALETTE, domain: FaceDomain.IDENTITY, offset: 19, length: 2, validValues: 4 },
  { key: "earShape", label: "Forma de orejas", type: FaceVarType.SPRITE, domain: FaceDomain.IDENTITY, offset: 21, length: 2, validValues: 4, status: "reserved-renderer" },
  { key: "jaw", label: "Mandíbula", type: FaceVarType.MORPH, domain: FaceDomain.IDENTITY, offset: 23, length: 3, validValues: 6, status: "reserved-renderer" },
  { key: "faceProportion", label: "Proporción facial", type: FaceVarType.MORPH, domain: FaceDomain.IDENTITY, offset: 26, length: 3, validValues: 6, status: "reserved-renderer" },
]);

/** Mutable styling and acquired marks. Offsets are local to appearanceBits. */
export const APPEARANCE_VARS = Object.freeze([
  { key: "hair", label: "Peinado", type: FaceVarType.SPRITE, domain: FaceDomain.APPEARANCE, offset: 0, length: 4, validValues: 12 },
  { key: "beard", label: "Barba", type: FaceVarType.SPRITE, domain: FaceDomain.APPEARANCE, offset: 4, length: 3, validValues: 6 },
  {
    key: "hairColor",
    label: "Color de pelo",
    type: FaceVarType.PALETTE,
    domain: FaceDomain.APPEARANCE,
    offset: 7,
    length: 3,
    validValues: 8,
    targets: ["hair", "beard", "brows"],
  },
  {
    key: "hairVisible",
    label: "Pelo visible",
    type: FaceVarType.TOGGLE,
    domain: FaceDomain.APPEARANCE,
    offset: 10,
    length: 1,
    validValues: 2,
    disablesWhenOff: ["hair"],
  },
  { key: "glasses", label: "Gafas", type: FaceVarType.TOGGLE, domain: FaceDomain.APPEARANCE, offset: 11, length: 1, validValues: 2 },
  { key: "scar", label: "Cicatriz", type: FaceVarType.TOGGLE, domain: FaceDomain.APPEARANCE, offset: 12, length: 1, validValues: 2 },
]);

export const FACE_VARS = Object.freeze([...IDENTITY_VARS, ...APPEARANCE_VARS]);

const VAR_BY_KEY = new Map(FACE_VARS.map((item) => [item.key, item]));
const VARS_BY_DOMAIN = Object.freeze({
  [FaceDomain.IDENTITY]: IDENTITY_VARS,
  [FaceDomain.APPEARANCE]: APPEARANCE_VARS,
});
const PRESENTATIONS = new Set(["masculine", "feminine", "neutral"]);

/**
 * Stable logical asset IDs. Art can be replaced while retaining the same ID,
 * so saved FaceDNA does not depend on filenames or atlas coordinates.
 */
export const ASSET_CATALOGS = Object.freeze({
  head: Object.freeze(["head/oval", "head/broad", "head/long", "head/square", "head/round", "head/tapered"]),
  skin: Object.freeze(["skin/01", "skin/02", "skin/03", "skin/04", "skin/05", "skin/06", "skin/07", "skin/08"]),
  eyes: Object.freeze(["eyes/almond", "eyes/round", "eyes/deep", "eyes/narrow", "eyes/upturned", "eyes/downturned"]),
  brows: Object.freeze(["brows/soft", "brows/flat", "brows/arched", "brows/thick", "brows/short", "brows/angular", "brows/low", "brows/high"]),
  nose: Object.freeze(["nose/straight", "nose/wide", "nose/narrow", "nose/short", "nose/long", "nose/aquiline", "nose/rounded", "nose/flat-bridge"]),
  mouth: Object.freeze(["mouth/neutral", "mouth/wide", "mouth/narrow", "mouth/full", "mouth/thin", "mouth/upturned", "mouth/downturned"]),
  freckles: Object.freeze(["freckles/off", "freckles/on"]),
  eyeColor: Object.freeze(["eye/brown", "eye/hazel", "eye/blue", "eye/green"]),
  earShape: Object.freeze(["ears/average", "ears/small", "ears/large", "ears/projecting"]),
  jaw: Object.freeze(["jaw/very-narrow", "jaw/narrow", "jaw/average", "jaw/broad", "jaw/very-broad", "jaw/angular"]),
  faceProportion: Object.freeze(["ratio/compact", "ratio/short", "ratio/average", "ratio/long", "ratio/very-long", "ratio/high-forehead"]),
  hair: Object.freeze(["hair/short-01", "hair/short-02", "hair/short-03", "hair/short-04", "hair/medium-01", "hair/medium-02", "hair/curly-01", "hair/long-01", "hair/long-02", "hair/fade-01", "hair/braids-01", "hair/bun-01"]),
  beard: Object.freeze(["beard/none", "beard/stubble", "beard/short", "beard/full", "beard/goatee", "beard/moustache"]),
  hairColor: Object.freeze(["hair/black", "hair/dark-brown", "hair/brown", "hair/light-brown", "hair/blond", "hair/golden", "hair/auburn", "hair/grey"]),
  hairVisible: Object.freeze(["hair/hidden", "hair/visible"]),
  glasses: Object.freeze(["glasses/off", "glasses/on"]),
  scar: Object.freeze(["scar/off", "scar/on"]),
});

export const FACE_STYLE_SPECS = Object.freeze({
  [DEFAULT_STYLE_LABEL]: Object.freeze({
    label: DEFAULT_STYLE_LABEL,
    identityVariables: IDENTITY_VARS,
    appearanceVariables: APPEARANCE_VARS,
    layerOrder: Object.freeze([
      "background", "kit", "neck", "hairBack", "ears", "head", "eyes", "brows",
      "nose", "freckles", "scar", "mouth", "beard", "ageDetails", "hairFront", "glasses",
    ]),
    paletteBindings: Object.freeze({
      skin: Object.freeze(["neck", "ears", "head", "nose", "mouth"]),
      hairColor: Object.freeze(["hairBack", "hairFront", "beard", "brows"]),
      eyeColor: Object.freeze(["eyes"]),
    }),
  }),
});

const KIT_PALETTES = Object.freeze([
  ["#b91c1c", "#f8fafc"],
  ["#1d4ed8", "#facc15"],
  ["#166534", "#f8fafc"],
  ["#7e22ce", "#f8fafc"],
  ["#111827", "#f97316"],
  ["#f8fafc", "#111827"],
  ["#0f766e", "#facc15"],
  ["#be123c", "#0f172a"],
]);

function maskForLength(length) {
  return length === 32 ? 0xffffffff : (2 ** length - 1) >>> 0;
}

function getVariable(variableOrKey) {
  const variable = typeof variableOrKey === "string" ? VAR_BY_KEY.get(variableOrKey) : variableOrKey;
  if (!variable) throw new Error(`Variable facial desconocida: ${String(variableOrKey)}`);
  return variable;
}

export function getBits(bits, variableOrKey) {
  const variable = getVariable(variableOrKey);
  return (bits >>> variable.offset) & maskForLength(variable.length);
}

export function setBits(bits, variableOrKey, value) {
  const variable = getVariable(variableOrKey);
  const maxValue = variable.validValues - 1;
  const safeValue = Math.max(0, Math.min(maxValue, Math.trunc(Number(value) || 0)));
  const localMask = maskForLength(variable.length);
  const shiftedMask = (localMask << variable.offset) >>> 0;
  return ((bits & (~shiftedMask >>> 0)) | ((safeValue & localMask) << variable.offset)) >>> 0;
}

export function scaleBits(rawValue, variableOrKey) {
  const variable = getVariable(variableOrKey);
  return Math.floor((rawValue * variable.validValues) / (2 ** variable.length));
}

export function scaleWordBits(bits, variables) {
  let result = bits >>> 0;
  for (const variable of variables) {
    result = setBits(result, variable, scaleBits(getBits(result, variable), variable));
  }
  return result >>> 0;
}

export function normalizeWordBits(bits, variables) {
  let result = bits >>> 0;
  for (const variable of variables) {
    const raw = getBits(result, variable);
    if (raw >= variable.validValues) {
      result = setBits(result, variable, scaleBits(raw, variable));
    }
  }
  return result >>> 0;
}

export class Randomizer {
  constructor(seed) {
    const normalized = Number(seed) >>> 0;
    this.state = normalized || 0x6d2b79f5;
  }

  nextU32() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  nextFloat() {
    return this.nextU32() / 0x100000000;
  }

  int(maxExclusive) {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new Error("maxExclusive debe ser positivo");
    return Math.floor(this.nextFloat() * maxExclusive);
  }

  chance(probability) {
    return this.nextFloat() < Math.max(0, Math.min(1, probability));
  }
}

export function hashSeed(value) {
  const text = String(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function featureRandomizer(seed, namespace, key) {
  return new Randomizer(hashSeed(`${seed}:${namespace}:${key}`));
}

function weightedChoice(randomizer, choices) {
  const total = choices.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(total > 0)) throw new Error("La tabla de pesos debe contener algún peso positivo");
  let cursor = randomizer.nextFloat() * total;
  for (const [value, weight] of choices) {
    cursor -= weight;
    if (cursor <= 0) return value;
  }
  return choices.at(-1)[0];
}

function getWord(profile, domain) {
  return domain === FaceDomain.IDENTITY ? profile.identityBits : profile.appearanceBits;
}

function setWord(profile, domain, bits) {
  return domain === FaceDomain.IDENTITY
    ? { ...profile, identityBits: bits >>> 0 }
    : { ...profile, appearanceBits: bits >>> 0 };
}

function readValue(profile, variableOrKey) {
  const variable = getVariable(variableOrKey);
  return getBits(getWord(profile, variable.domain), variable);
}

function writeValue(profile, variableOrKey, value) {
  const variable = getVariable(variableOrKey);
  return setWord(profile, variable.domain, setBits(getWord(profile, variable.domain), variable, value));
}

export function randomizeIdentityBits(seed) {
  let bits = 0;
  for (const variable of IDENTITY_VARS) {
    const randomizer = featureRandomizer(seed, "identity", variable.key);
    let value = randomizer.int(variable.validValues);
    if (variable.key === "freckles") value = randomizer.chance(0.24) ? 1 : 0;
    bits = setBits(bits, variable, value);
  }
  return bits >>> 0;
}

export function randomizeAppearanceBits(seed, { age = 24, presentation = "neutral" } = {}) {
  const safeAge = Math.max(16, Math.min(60, Math.round(age)));
  const safePresentation = PRESENTATIONS.has(presentation) ? presentation : "neutral";
  let bits = 0;

  const hairVisibleRng = featureRandomizer(seed, "appearance", "hairVisible");
  const hairVisible = hairVisibleRng.chance(safeAge > 42 ? 0.78 : 0.96) ? 1 : 0;
  bits = setBits(bits, "hairVisible", hairVisible);

  const hairRng = featureRandomizer(seed, `appearance:${safePresentation}`, "hair");
  let hair = hairRng.int(getVariable("hair").validValues);
  if (safePresentation === "feminine") {
    hair = weightedChoice(hairRng, [[0, 0.04], [2, 0.07], [3, 0.1], [4, 0.08], [6, 0.12], [7, 0.2], [8, 0.12], [10, 0.13], [11, 0.14]]);
  }
  bits = setBits(bits, "hair", hairVisible ? hair : 0);

  const beardRng = featureRandomizer(seed, `appearance:${safePresentation}:${safeAge < 19 ? "youth" : "adult"}`, "beard");
  const beardWeights = safePresentation === "feminine"
    ? [[0, 0.995], [1, 0.005]]
    : safePresentation === "masculine"
      ? (safeAge < 19 ? [[0, 0.88], [1, 0.1], [2, 0.02]] : [[0, 0.34], [1, 0.22], [2, 0.15], [3, 0.12], [4, 0.1], [5, 0.07]])
      : [[0, 0.68], [1, 0.14], [2, 0.08], [3, 0.05], [4, 0.03], [5, 0.02]];
  bits = setBits(bits, "beard", weightedChoice(beardRng, beardWeights));

  bits = setBits(bits, "hairColor", featureRandomizer(seed, "appearance", "hairColor").int(getVariable("hairColor").validValues));
  bits = setBits(bits, "glasses", featureRandomizer(seed, "appearance", "glasses").chance(0.08 + Math.max(0, safeAge - 25) * 0.006) ? 1 : 0);
  bits = setBits(bits, "scar", featureRandomizer(seed, "appearance", "scar").chance(0.07) ? 1 : 0);
  return bits >>> 0;
}

export function getActiveFaceVars(profile) {
  const active = new Set(FACE_VARS.map((variable) => variable.key));

  for (const variable of FACE_VARS) {
    if (variable.type !== FaceVarType.TOGGLE) continue;
    const enabled = readValue(profile, variable) === 1;
    const disabled = enabled ? variable.disablesWhenOn : variable.disablesWhenOff;
    for (const key of disabled ?? []) active.delete(key);
  }

  // Hair colour is still needed by a beard on a bald player.
  if (readValue(profile, "hairVisible") === 0 && readValue(profile, "beard") === 0) {
    active.delete("hairColor");
  }
  return active;
}

export function applyCompatibilityRules(profile) {
  let result = {
    ...profile,
    version: CURRENT_PROFILE_VERSION,
    style: typeof profile.style === "string" ? profile.style : DEFAULT_STYLE_LABEL,
    seed: Number(profile.seed) >>> 0,
    identityBits: Number(profile.identityBits) >>> 0,
    appearanceBits: Number(profile.appearanceBits) >>> 0,
    age: Math.max(16, Math.min(60, Math.round(Number(profile.age) || 24))),
    presentation: PRESENTATIONS.has(profile.presentation) ? profile.presentation : "neutral",
    kit: {
      primary: normalizeHex(profile.kit?.primary ?? profile.kitPrimary ?? "#b91c1c"),
      secondary: normalizeHex(profile.kit?.secondary ?? profile.kitSecondary ?? "#f8fafc"),
    },
  };
  const corrections = [];

  result.identityBits = normalizeWordBits(result.identityBits, IDENTITY_VARS);
  result.appearanceBits = normalizeWordBits(result.appearanceBits, APPEARANCE_VARS);

  if (readValue(result, "hairVisible") === 0 && readValue(result, "hair") !== 0) {
    result = writeValue(result, "hair", 0);
    corrections.push("hair-cleared-when-hidden");
  }

  if (result.age < 18 && readValue(result, "beard") > 2) {
    result = writeValue(result, "beard", 2);
    corrections.push("youth-beard-capped");
  }

  const active = getActiveFaceVars(result);
  for (const variable of FACE_VARS) {
    if (!active.has(variable.key) && readValue(result, variable) !== 0) {
      result = writeValue(result, variable, 0);
      corrections.push(`inactive-cleared:${variable.key}`);
    }
  }

  return { profile: result, corrections };
}

export function canonicalizeProfile(profile) {
  return applyCompatibilityRules(profile).profile;
}

export function createProfile({ seed = Date.now(), age = 24, presentation = "neutral", style = DEFAULT_STYLE_LABEL } = {}) {
  const numericSeed = typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
  const safeAge = Math.max(16, Math.min(60, Math.round(age)));
  const safePresentation = PRESENTATIONS.has(presentation) ? presentation : "neutral";
  if (!FACE_STYLE_SPECS[style]) throw new Error(`Estilo facial desconocido: ${style}`);
  const kitRng = featureRandomizer(numericSeed, "profile", "kit");
  const kit = KIT_PALETTES[kitRng.int(KIT_PALETTES.length)];

  return canonicalizeProfile({
    version: CURRENT_PROFILE_VERSION,
    style,
    seed: numericSeed,
    identityBits: randomizeIdentityBits(numericSeed),
    appearanceBits: randomizeAppearanceBits(numericSeed, { age: safeAge, presentation: safePresentation }),
    age: safeAge,
    presentation: safePresentation,
    kit: { primary: kit[0], secondary: kit[1] },
  });
}

export function cloneProfile(profile) {
  const canonical = canonicalizeProfile(profile);
  return { ...canonical, kit: { ...canonical.kit } };
}

export function setFeature(profile, key, value) {
  const variable = getVariable(key);
  const updated = setWord(profile, variable.domain, setBits(getWord(profile, variable.domain), variable, value));
  return canonicalizeProfile(updated);
}

export function changeFeature(profile, key, delta) {
  const variable = getVariable(key);
  const current = readValue(profile, variable);
  const amount = Math.trunc(Number(delta) || 0);
  const wrapped = ((current + amount) % variable.validValues + variable.validValues) % variable.validValues;
  return setFeature(profile, key, wrapped);
}

export function setPresentation(profile, presentation, { rerollAppearance = true } = {}) {
  const safePresentation = PRESENTATIONS.has(presentation) ? presentation : "neutral";
  const updated = {
    ...profile,
    presentation: safePresentation,
    appearanceBits: rerollAppearance
      ? randomizeAppearanceBits(profile.seed, { age: profile.age, presentation: safePresentation })
      : profile.appearanceBits,
  };
  return canonicalizeProfile(updated);
}

export function setKit(profile, primary, secondary) {
  return canonicalizeProfile({
    ...profile,
    kit: { primary: normalizeHex(primary), secondary: normalizeHex(secondary) },
  });
}

export function getFaceValues(profile) {
  const canonical = canonicalizeProfile(profile);
  const values = {};
  for (const variable of FACE_VARS) values[variable.key] = readValue(canonical, variable);
  return values;
}

export function getFaceAssetIds(profile) {
  const values = getFaceValues(profile);
  const assets = {};
  for (const variable of FACE_VARS) {
    const catalog = ASSET_CATALOGS[variable.key];
    assets[variable.key] = catalog?.[values[variable.key]] ?? null;
  }
  return assets;
}

export function ageProfile(profile, years = 1) {
  return canonicalizeProfile({ ...profile, age: profile.age + Math.trunc(Number(years) || 0) });
}

export function getCompatibilityReport(profile) {
  const { profile: canonical, corrections } = applyCompatibilityRules(profile);
  return {
    corrected: corrections.length > 0,
    corrections,
    activeVariables: [...getActiveFaceVars(canonical)],
  };
}

function normalizeHex(value) {
  const text = String(value).trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(text)) throw new Error(`Color hexadecimal inválido: ${value}`);
  return `#${text.toLowerCase()}`;
}

function checksum(text) {
  return hashSeed(text).toString(36).padStart(7, "0").slice(-7);
}

export function formatFaceCode(profile) {
  const canonical = canonicalizeProfile(profile);
  const payload = [
    "SF2",
    canonical.style,
    canonical.identityBits.toString(36),
    canonical.appearanceBits.toString(36),
    canonical.seed.toString(36),
    canonical.age.toString(36),
    canonical.presentation === "masculine" ? "m" : canonical.presentation === "feminine" ? "f" : "n",
    canonical.kit.primary.slice(1),
    canonical.kit.secondary.slice(1),
  ].join("~");
  return `${payload}~${checksum(payload)}`;
}

function parseBase36Integer(value, label) {
  if (!/^[0-9a-z]+$/i.test(value)) throw new Error(`${label} inválido`);
  const parsed = Number.parseInt(value, 36);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffffffff) throw new Error(`${label} fuera de rango`);
  return parsed >>> 0;
}

function parseFaceCodeV2(code) {
  const parts = String(code).trim().split("~");
  if (parts.length !== 10 || parts[0] !== "SF2") throw new Error("Código FaceDNA v2 no reconocido");
  const payload = parts.slice(0, 9).join("~");
  if (checksum(payload) !== parts[9]) throw new Error("El código facial está dañado o incompleto");
  if (!FACE_STYLE_SPECS[parts[1]]) throw new Error(`Estilo facial desconocido: ${parts[1]}`);
  const presentation = parts[6] === "m" ? "masculine" : parts[6] === "f" ? "feminine" : parts[6] === "n" ? "neutral" : null;
  if (!presentation) throw new Error("Presentación facial inválida");
  if (!/^[0-9a-z]+$/i.test(parts[5])) throw new Error("Edad inválida");
  const age = Number.parseInt(parts[5], 36);
  if (!Number.isInteger(age) || age < 16 || age > 60) throw new Error("Edad fuera del rango 16–60");

  const profile = canonicalizeProfile({
    version: CURRENT_PROFILE_VERSION,
    style: parts[1],
    identityBits: parseBase36Integer(parts[2], "Identidad"),
    appearanceBits: parseBase36Integer(parts[3], "Apariencia"),
    seed: parseBase36Integer(parts[4], "Semilla"),
    age,
    presentation,
    kit: { primary: normalizeHex(parts[7]), secondary: normalizeHex(parts[8]) },
  });
  const validation = validateProfile(profile);
  if (!validation.valid) throw new Error(validation.errors[0]);
  return profile;
}

/** Temporary v1 offsets, used only to migrate codes produced by MVP 0.1. */
const LEGACY_V1_VARS = Object.freeze({
  head: { offset: 0, length: 3, validValues: 6 },
  skin: { offset: 3, length: 3, validValues: 8 },
  eyes: { offset: 6, length: 3, validValues: 6 },
  brows: { offset: 9, length: 3, validValues: 8 },
  nose: { offset: 12, length: 3, validValues: 8 },
  mouth: { offset: 15, length: 3, validValues: 7 },
  hair: { offset: 18, length: 4, validValues: 12 },
  beard: { offset: 22, length: 3, validValues: 6 },
  hairColor: { offset: 25, length: 3, validValues: 8 },
  glasses: { offset: 28, length: 1, validValues: 2 },
  freckles: { offset: 29, length: 1, validValues: 2 },
  hairVisible: { offset: 30, length: 1, validValues: 2 },
  scar: { offset: 31, length: 1, validValues: 2 },
});

function getLegacyBits(bits, variable) {
  return (bits >>> variable.offset) & maskForLength(variable.length);
}

export function migrateLegacyProfileV1(legacy) {
  const seed = Number(legacy.seed) >>> 0;
  let identityBits = randomizeIdentityBits(seed);
  let appearanceBits = randomizeAppearanceBits(seed, { age: legacy.age, presentation: legacy.presentation });
  const legacyBits = Number(legacy.faceBits) >>> 0;

  for (const key of ["head", "skin", "eyes", "brows", "nose", "mouth", "freckles"]) {
    identityBits = setBits(identityBits, key, getLegacyBits(legacyBits, LEGACY_V1_VARS[key]));
  }
  for (const key of ["hair", "beard", "hairColor", "glasses", "hairVisible", "scar"]) {
    appearanceBits = setBits(appearanceBits, key, getLegacyBits(legacyBits, LEGACY_V1_VARS[key]));
  }

  return canonicalizeProfile({
    version: CURRENT_PROFILE_VERSION,
    style: DEFAULT_STYLE_LABEL,
    seed,
    identityBits,
    appearanceBits,
    age: legacy.age,
    presentation: legacy.presentation,
    kit: {
      primary: legacy.kit?.primary ?? legacy.kitPrimary,
      secondary: legacy.kit?.secondary ?? legacy.kitSecondary,
    },
  });
}

function parseLegacyFaceCodeV1(code) {
  const parts = String(code).trim().split("-");
  if (parts.length !== 8 || parts[0] !== "SF1") throw new Error("Código facial no reconocido");
  const payload = parts.slice(0, 7).join("-");
  if (checksum(payload) !== parts[7]) throw new Error("El código facial está dañado o incompleto");
  const presentation = parts[4] === "m" ? "masculine" : parts[4] === "f" ? "feminine" : "neutral";
  if (!/^[0-9a-z]+$/i.test(parts[3])) throw new Error("Edad inválida");
  const age = Number.parseInt(parts[3], 36);
  if (!Number.isInteger(age) || age < 16 || age > 60) throw new Error("Edad fuera del rango 16–60");
  return migrateLegacyProfileV1({
    version: 1,
    faceBits: parseBase36Integer(parts[1], "Rostro v1"),
    seed: parseBase36Integer(parts[2], "Semilla"),
    age,
    presentation,
    kitPrimary: normalizeHex(parts[5]),
    kitSecondary: normalizeHex(parts[6]),
  });
}

export function parseFaceCode(code) {
  const text = String(code).trim();
  if (text.startsWith("SF2~")) return parseFaceCodeV2(text);
  if (text.startsWith("SF1-")) return parseLegacyFaceCodeV1(text);
  throw new Error("Código facial no reconocido");
}

export function validateProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== "object") return { valid: false, errors: ["El perfil no es un objeto"] };
  if (profile.version !== CURRENT_PROFILE_VERSION) errors.push(`Versión no soportada: ${profile.version}`);
  if (!FACE_STYLE_SPECS[profile.style]) errors.push(`Estilo facial desconocido: ${profile.style}`);
  if (!Number.isInteger(profile.identityBits) || profile.identityBits < 0) errors.push("identityBits inválido");
  if (!Number.isInteger(profile.appearanceBits) || profile.appearanceBits < 0) errors.push("appearanceBits inválido");
  if (!Number.isInteger(profile.seed) || profile.seed < 0) errors.push("Semilla inválida");
  if (!Number.isInteger(profile.age) || profile.age < 16 || profile.age > 60) errors.push("Edad fuera del rango 16–60");
  if (!PRESENTATIONS.has(profile.presentation)) errors.push("Presentación inválida");
  try {
    normalizeHex(profile.kit?.primary);
    normalizeHex(profile.kit?.secondary);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Equipación inválida");
  }

  if (Number.isInteger(profile.identityBits) && Number.isInteger(profile.appearanceBits)) {
    const active = getActiveFaceVars({ ...profile, identityBits: profile.identityBits >>> 0, appearanceBits: profile.appearanceBits >>> 0 });
    for (const variable of FACE_VARS) {
      if (!active.has(variable.key)) continue;
      const value = readValue(profile, variable);
      if (value >= variable.validValues) errors.push(`Valor fuera de rango para ${variable.label}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function describeProfile(profile) {
  const canonical = canonicalizeProfile(profile);
  return {
    code: formatFaceCode(canonical),
    version: canonical.version,
    style: canonical.style,
    seed: canonical.seed,
    age: canonical.age,
    presentation: canonical.presentation,
    kit: canonical.kit,
    identityBitsHex: `0x${canonical.identityBits.toString(16).padStart(8, "0")}`,
    appearanceBitsHex: `0x${canonical.appearanceBits.toString(16).padStart(8, "0")}`,
    values: getFaceValues(canonical),
    assetIds: getFaceAssetIds(canonical),
    compatibility: getCompatibilityReport(canonical),
    validation: validateProfile(canonical),
  };
}
