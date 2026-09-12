const fs = require("fs");
const path = require("path");

const { installDir } = require("./paths");

function compactProductVersion(v) {
  const parts = String(v)
    .trim()
    .split(".")
    .filter(Boolean);
  if (parts.length === 0) return "0.0";
  if (parts.length === 1) return `${parts[0]}.0`;
  if (parts.length >= 3 && parts.slice(2).every((p) => p === "0")) {
    return `${parts[0]}.${parts[1]}`;
  }
  return parts.join(".");
}

function normalizeVersion(v) {
  const raw = String(v || "")
    .trim()
    .replace(/^[vV]+/, "")
    .trim();
  return compactProductVersion(raw);
}

function displayVersion(v) {
  return `v${normalizeVersion(v)}`;
}

function readVersionFile() {
  try {
    const marker = path.join(installDir(), "version.txt");
    if (!fs.existsSync(marker)) return "";
    const line = fs.readFileSync(marker, "utf-8").split(/\r?\n/)[0] || "";
    return normalizeVersion(line);
  } catch {
    return "";
  }
}

function currentVersion() {
  const fromEnv = process.env.MAOYAN_VERSION || process.env.AGENT_VERSION;
  if (fromEnv) {
    const n = normalizeVersion(fromEnv);
    if (n) return n;
  }
  const fromFile = readVersionFile();
  if (fromFile) return fromFile;
  try {
    const pkg = require("../../package.json");
    return normalizeVersion(pkg.version || "1.0.0");
  } catch {
    return "1.0.0";
  }
}

function currentVersionDisplay() {
  return displayVersion(currentVersion());
}

function parseVersionParts(v) {
  return normalizeVersion(v)
    .split(".")
    .map((p) => parseInt(p, 10) || 0);
}

function isNewer(candidate, current) {
  const a = parseVersionParts(candidate);
  const b = parseVersionParts(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

function skipAutoUpdate() {
  const fromEnv = process.env.MAOYAN_SKIP_AUTO_UPDATE || process.env.AGENT_SKIP_AUTO_UPDATE;
  if (fromEnv === "1" || String(fromEnv).toLowerCase() === "true") return true;

  try {
    const configPath = path.join(installDir(), "config.env");
    if (!fs.existsSync(configPath)) return false;
    const text = fs.readFileSync(configPath, "utf-8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (key !== "MAOYAN_SKIP_AUTO_UPDATE" && key !== "AGENT_SKIP_AUTO_UPDATE") continue;
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      return val === "1" || val.toLowerCase() === "true";
    }
  } catch {
    /* ignore */
  }
  return false;
}

module.exports = {
  normalizeVersion,
  displayVersion,
  currentVersion,
  currentVersionDisplay,
  isNewer,
  skipAutoUpdate,
};
