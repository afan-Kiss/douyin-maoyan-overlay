/**
 * schema v2 迁移验收：node deploy/test-settings-migration.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

function loadViaSubprocess(settingsPath) {
  const script = `
    delete require.cache[require.resolve("./lib/settings")];
    process.env.MAOYAN_SETTINGS_PATH = ${JSON.stringify(settingsPath)};
    const { loadSettings } = require("./lib/settings");
    process.stdout.write(JSON.stringify(loadSettings()));
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "subprocess failed");
  }
  return JSON.parse(result.stdout);
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function testLegacyDefaultsMigrate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-migrate-"));
  const file = path.join(dir, "overlay-settings.json");
  writeJson(file, {
    schemaVersion: 1,
    fonts: {
      heroTitle: 32,
      movieRank: 14,
      table: 12,
    },
  });
  const loaded = loadViaSubprocess(file);
  assert.strictEqual(loaded.schemaVersion, 2);
  assert.strictEqual(loaded.fonts.heroTitle, 64);
  assert.strictEqual(loaded.fonts.movieRank, 28);
  assert.strictEqual(loaded.fonts.table, 30);
  const reloaded = loadViaSubprocess(file);
  assert.strictEqual(reloaded.fonts.heroTitle, 64);
  console.log("OK: legacy defaults migrate to v2");
}

function testCustomValuesPreserved() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-migrate-"));
  const file = path.join(dir, "overlay-settings.json");
  writeJson(file, {
    schemaVersion: 1,
    fonts: {
      heroTitle: 50,
      movieRank: 40,
      table: 22,
    },
    colors: {
      accent: "#123456",
    },
    window: {
      alwaysOnTop: true,
    },
  });
  const loaded = loadViaSubprocess(file);
  assert.strictEqual(loaded.fonts.heroTitle, 50);
  assert.strictEqual(loaded.fonts.movieRank, 40);
  assert.strictEqual(loaded.fonts.table, 22);
  assert.strictEqual(loaded.colors.accent, "#123456");
  assert.strictEqual(loaded.window.alwaysOnTop, true);
  console.log("OK: custom values preserved");
}

function testPartialFieldsFilled() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-migrate-"));
  const file = path.join(dir, "overlay-settings.json");
  writeJson(file, {
    schemaVersion: 1,
    fonts: {
      heroTitle: 50,
    },
  });
  const loaded = loadViaSubprocess(file);
  assert.strictEqual(loaded.fonts.heroTitle, 50);
  assert.strictEqual(loaded.fonts.movieRank, 28);
  assert.strictEqual(loaded.colors.accent, "#ff5a5a");
  console.log("OK: missing fields filled with v2 defaults");
}

function testSchemaV2NoRemigration() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-migrate-"));
  const file = path.join(dir, "overlay-settings.json");
  writeJson(file, {
    schemaVersion: 2,
    revision: 3,
    fonts: {
      heroTitle: 50,
      movieRank: 14,
    },
  });
  const loaded = loadViaSubprocess(file);
  assert.strictEqual(loaded.fonts.heroTitle, 50);
  assert.strictEqual(loaded.fonts.movieRank, 14);
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.strictEqual(raw.fonts.movieRank, 14);
  console.log("OK: schemaVersion=2 does not remigrate");
}

function main() {
  testLegacyDefaultsMigrate();
  testCustomValuesPreserved();
  testPartialFieldsFilled();
  testSchemaV2NoRemigration();
  console.log("\nALL PASSED (settings migration)");
}

main();
