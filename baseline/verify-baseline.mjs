
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  canonicalizeProfile,
  createProfile,
  formatFaceCode,
  parseFaceCode,
  validateProfile,
} from "../src/face-model.js";

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

const baseline = JSON.parse(fs.readFileSync(new URL("./visual-baseline.json", import.meta.url), "utf8"));
assert.equal(baseline.schema, "sports-face-visual-baseline/v1");
assert.equal(baseline.release, "0.2.1");
assert.equal(baseline.entries.length, 100);
assert.equal(sha256(stableStringify(baseline.entries)), baseline.baselineSha256);

const ids = new Set();
const codes = new Set();
for (const entry of baseline.entries) {
  assert.ok(!ids.has(entry.id), `duplicate fixture ID ${entry.id}`);
  assert.ok(!codes.has(entry.code), `duplicate SF2 code ${entry.id}`);
  ids.add(entry.id);
  codes.add(entry.code);

  const regenerated = createProfile(entry.input);
  assert.deepEqual(regenerated, entry.profile, `${entry.id}: createProfile changed`);
  assert.deepEqual(parseFaceCode(entry.code), canonicalizeProfile(entry.profile), `${entry.id}: SF2 parsing changed`);
  assert.equal(formatFaceCode(entry.profile), entry.code, `${entry.id}: SF2 formatting changed`);
  assert.equal(validateProfile(entry.profile).valid, true, `${entry.id}: profile invalid`);

  const contract = {
    input: entry.input,
    profile: entry.profile,
    code: entry.code,
    description: entry.description,
  };
  assert.equal(sha256(stableStringify(contract)), entry.dataSha256, `${entry.id}: contract hash changed`);
}

const migrations = JSON.parse(fs.readFileSync(new URL("./legacy-migration-fixtures.json", import.meta.url), "utf8"));
assert.equal(migrations.fixtures.length, 12);
assert.equal(sha256(stableStringify(migrations.fixtures)), migrations.fixturesSha256);
for (const fixture of migrations.fixtures) {
  const migrated = parseFaceCode(fixture.sf1);
  assert.deepEqual(migrated, fixture.expectedProfile, `${fixture.id}: SF1 migration changed`);
  assert.equal(formatFaceCode(migrated), fixture.expectedSf2, `${fixture.id}: migrated SF2 changed`);
}

console.log("Frozen baseline v0.2.1 verified: 100 SF2 + 12 SF1 migration fixtures.");
