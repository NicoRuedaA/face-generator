
import fs from "node:fs";
import crypto from "node:crypto";
import {
  createProfile,
  describeProfile,
  formatFaceCode,
  getBits,
  hashSeed,
  parseFaceCode,
  setBits,
  validateProfile,
} from "../src/face-model.js";

const outputPath = new URL("./visual-baseline.json", import.meta.url);
const csvPath = new URL("./visual-baseline.csv", import.meta.url);
const seedsPath = new URL("./seed-list.txt", import.meta.url);
const legacyPath = new URL("./legacy-migration-fixtures.json", import.meta.url);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

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

const presentations = ["masculine", "feminine", "neutral"];
const entries = [];

for (let index = 0; index < 100; index += 1) {
  const id = `B${String(index + 1).padStart(3, "0")}`;
  const seedLabel = `sports-face/v0.2.1/baseline/${id}`;
  const seed = hashSeed(seedLabel);
  const age = 16 + ((index * 17 + 7) % 45);
  const presentation = presentations[index % presentations.length];
  const profile = createProfile({ seed, age, presentation });
  const validation = validateProfile(profile);
  if (!validation.valid) throw new Error(`${id}: ${validation.errors.join(", ")}`);
  const code = formatFaceCode(profile);
  const parsed = parseFaceCode(code);
  const description = describeProfile(profile);
  const contract = { input: { seedLabel, seed, age, presentation }, profile, code, description };
  entries.push({
    id,
    ...contract,
    dataSha256: sha256(stableStringify(contract)),
  });
}

const baseline = {
  schema: "sports-face-visual-baseline/v1",
  release: "0.2.1",
  freezeId: "sports-face-v0.2.1-2026-08-05",
  generatedAt: "2026-08-05T10:42:00+02:00",
  generator: {
    seedNamespace: "sports-face/v0.2.1/baseline/",
    count: entries.length,
    ageRange: [16, 60],
    presentations,
  },
  notes: [
    "Los datos FaceDNA y códigos SF2 son el contrato reproducible.",
    "Las capturas PNG son referencias visuales y pueden variar levemente por antialiasing entre navegadores.",
  ],
  entries,
};
baseline.baselineSha256 = sha256(stableStringify(entries));
fs.writeFileSync(outputPath, `${JSON.stringify(baseline, null, 2)}\n`);

const headers = [
  "id", "seedLabel", "seed", "age", "presentation", "identityBits",
  "appearanceBits", "style", "sf2Code", "dataSha256",
];
const rows = entries.map((entry) => [
  entry.id,
  entry.input.seedLabel,
  entry.input.seed,
  entry.input.age,
  entry.input.presentation,
  entry.profile.identityBits,
  entry.profile.appearanceBits,
  entry.profile.style,
  entry.code,
  entry.dataSha256,
]);
fs.writeFileSync(
  csvPath,
  `${headers.map(csvCell).join(",")}\n${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`,
);
fs.writeFileSync(
  seedsPath,
  `${entries.map((entry) => `${entry.id}\t${entry.input.seed}\t${entry.input.age}\t${entry.input.presentation}\t${entry.code}`).join("\n")}\n`,
);

const legacyFixtures = [];
for (let index = 0; index < 12; index += 1) {
  let faceBits = 0;
  const defs = {
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
  };
  for (const [key, variable] of Object.entries(defs)) {
    const value = hashSeed(`legacy:${index}:${key}`) % variable.validValues;
    faceBits = setBits(faceBits, variable, value);
  }

  const seed = hashSeed(`sports-face/v0.1/migration/${index + 1}`);
  const age = 18 + ((index * 7) % 39);
  const presentation = presentations[index % presentations.length];
  const palettes = [
    ["#166534", "#f8fafc"],
    ["#1d4ed8", "#facc15"],
    ["#991b1b", "#f1f5f9"],
    ["#111827", "#f97316"],
  ];
  const [primary, secondary] = palettes[index % palettes.length];
  const sf1 = makeLegacySf1Code({ faceBits, seed, age, presentation, primary, secondary });
  const migrated = parseFaceCode(sf1);
  legacyFixtures.push({
    id: `L${String(index + 1).padStart(2, "0")}`,
    sf1,
    expectedSf2: formatFaceCode(migrated),
    expectedProfile: migrated,
  });
}

const migrationDocument = {
  schema: "sports-face-sf1-migration-fixtures/v1",
  release: "0.2.1",
  generatedAt: "2026-08-05T10:42:00+02:00",
  fixtures: legacyFixtures,
};
migrationDocument.fixturesSha256 = sha256(stableStringify(legacyFixtures));
fs.writeFileSync(legacyPath, `${JSON.stringify(migrationDocument, null, 2)}\n`);

console.log(`Generated ${entries.length} visual fixtures and ${legacyFixtures.length} SF1 migration fixtures.`);
