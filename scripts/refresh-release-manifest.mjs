import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const manifestPath = path.join(root, "docs", "release-manifest-v040.json");
const operationalFiles = [
  "tools/gnm/build_runtime_pack.py",
  "tools/gnm/test_build_runtime_pack.py",
  "tools/gnm/README.md",
  "README.md",
  "docs/PHASE3_MORPHOLOGY_GNM.md",
  "docs/ACCEPTANCE_V040.md",
  "CHANGELOG.md",
  "package.json",
  "scripts/refresh-release-manifest.mjs",
];

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(root, filePath))).digest("hex");
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.keyHashes = Object.fromEntries(
  Object.keys(manifest.keyHashes).map((filePath) => [filePath, sha256(filePath)]),
);
manifest.operationalFiles = Object.fromEntries(
  operationalFiles.map((filePath) => [filePath, sha256(filePath)]),
);
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Updated ${manifestPath} with ${operationalFiles.length} operational file hashes.`);
