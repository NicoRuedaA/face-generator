import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0").filter((file) => /^(src\/|scripts\/|tests\/|tools\/gnm\/[^/]+\.py$)/.test(file) && fs.existsSync(path.join(root, file)));
files.push("index.html", "index.module.html", "styles.css", "package.json", "README.md", "THIRD_PARTY_NOTICES.md",
  ...["gnm-official-head-render.glb", "gnm-player-generator.bin", "gnm-player-generator.json", "LICENSE-GNM.txt"].map((file) => `tools/gnm/work/${file}`));
const manifest = {
  schema: "sports-face-release-manifest/v1",
  version: "0.4.0",
  releaseId: "sports-face-gnm-3d-player-only",
  renderers: ["sports/gnm-3d-player-v1"],
  defaultRenderer: "sports/gnm-3d-player-v1",
  requires: ["HTTP", "WebGL2"],
  fallbackRenderer: null,
  operationalFiles: Object.fromEntries([...new Set(files)].sort().map((file) => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")])),
};
fs.writeFileSync(path.join(root, "docs/release-manifest-v040.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Updated 3D player release manifest (${files.length} operational files).`);
