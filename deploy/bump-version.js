/**
 * 递增 package.json 版本号（次版本 +1，如 1.0.0 -> 1.1.0 -> 1.2.0）
 * 用法: node deploy/bump-version.js [--dry-run]
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PKG_PATH = path.join(ROOT, "package.json");

function parseParts(version) {
  const parts = String(version || "0.0.0")
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((p) => parseInt(p, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

function bumpProductVersion(version) {
  const [major, minor, patch] = parseParts(version);
  if (patch === 0) {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

function displayVersion(version) {
  const [major, minor, patch] = parseParts(version);
  if (patch === 0) return `${major}.${minor}`;
  return `${major}.${minor}.${patch}`;
}

function bumpPackageVersion({ dryRun = false } = {}) {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf-8"));
  const previous = String(pkg.version || "1.0.0");
  const next = bumpProductVersion(previous);

  if (!dryRun) {
    pkg.version = next;
    fs.writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
  }

  return { previous, next, display: displayVersion(next) };
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const result = bumpPackageVersion({ dryRun });
  const label = dryRun ? "下一版本（预览）" : "已递增版本";
  console.log(`${label}: ${result.previous} -> ${result.next} (展示 v${result.display})`);
}

if (require.main === module) {
  main();
}

module.exports = { bumpProductVersion, displayVersion, bumpPackageVersion };
