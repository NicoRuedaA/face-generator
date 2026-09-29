import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/*
 * Refreshes SHA256SUMS.txt for every tracked or new non-ignored file of the current snapshot.
 * Existing lines keep their order; new files are inserted by a stable
 * case-insensitive key and removed files are dropped. A Git LFS pointer is
 * recorded with the pointer's oid (the SHA-256 of the real object), so
 * `sha256sum -c SHA256SUMS.txt` passes once `git lfs pull` materializes it.
 */
const root = path.resolve(new URL("..", import.meta.url).pathname);
const checksumsPath = path.join(root, "SHA256SUMS.txt");
const excluded = new Set(["SHA256SUMS.txt", ".gitattributes"]);
const lfsPointer = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize \d+\n$/;

function digest(filePath) {
  const data = fs.readFileSync(path.join(root, filePath));
  const pointer = data.length < 1024 ? lfsPointer.exec(data.toString("latin1")) : null;
  return pointer ? pointer[1] : crypto.createHash("sha256").update(data).digest("hex");
}

function sortKey(filePath) {
  return [filePath.toLowerCase().replace(/[^0-9a-z]/g, ""), filePath.toLowerCase(), filePath];
}

function compareKeys(left, right) {
  const a = sortKey(left);
  const b = sortKey(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((filePath) => filePath && !excluded.has(filePath) && fs.existsSync(path.join(root, filePath)));
const trackedSet = new Set(tracked);
const existing = fs.readFileSync(checksumsPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => line.slice(line.indexOf("  ") + 2))
  .filter((filePath) => trackedSet.has(filePath));
const ordered = [...existing];
for (const filePath of tracked.filter((item) => !existing.includes(item)).sort(compareKeys)) {
  const index = ordered.findIndex((item) => compareKeys(item, filePath) > 0);
  ordered.splice(index === -1 ? ordered.length : index, 0, filePath);
}
fs.writeFileSync(checksumsPath, `${ordered.map((filePath) => `${digest(filePath)}  ${filePath}`).join("\n")}\n`);
console.log(`Updated SHA256SUMS.txt with ${ordered.length} project files.`);
