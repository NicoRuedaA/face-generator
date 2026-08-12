import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const manifestPath = path.join(root, "docs", "release-manifest-v040.json");
const operationalFiles = [
  "tools/gnm/build_runtime_pack.py",
  "tools/gnm/test_build_runtime_pack.py",
  "tools/gnm/test_gnm_quality.py",
  "tools/gnm/audit_gnm_landmarks.py",
  "tools/gnm/capture_acceptance_gallery.py",
  "tools/gnm/export_gnm_glb.py",
  "tools/gnm/validate_gnm_glb.py",
  "tools/gnm/test_gnm_glb.py",
  "tools/gnm/build_gnm_morph_targets.py",
  "tools/gnm/validate_gnm_morph_targets.py",
  "tools/gnm/test_gnm_morph_targets.py",
  "tools/gnm/capture_webgl_ab.py",
  "tools/gnm/validate_webgl_ab.py",
  "src/webgl-renderer.js",
  "src/render-router.js",
  "src/app.js",
  "src/app.bundle.js",
  "scripts/build-offline-bundle.mjs",
  "index.html",
  "index.module.html",
  "styles.css",
  "tools/gnm/work/head-morph.glb",
  "tools/gnm/README.md",
  "README.md",
  "docs/PHASE3_MORPHOLOGY_GNM.md",
  "docs/ACCEPTANCE_GNM_QUALITY.md",
  "docs/ACCEPTANCE_GNM_LANDMARKS.md",
  "docs/ACCEPTANCE_GNM_GALLERY.md",
  "docs/ACCEPTANCE_GNM_GLB.md",
  "docs/ACCEPTANCE_GNM_WEBGL_AB.md",
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
