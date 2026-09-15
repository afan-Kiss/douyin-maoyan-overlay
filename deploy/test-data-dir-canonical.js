/**
 * 数据目录 canonical 选择：不合并，只选最新 browser_state 所在目录
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function loadService() {
  delete require.cache[require.resolve("../maoyan-service")];
  return require("../maoyan-service");
}

function testPickNewestBrowserState() {
  const svc = loadService();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-dir-"));
  const older = path.join(root, "older", "maoyan-data");
  const newer = path.join(root, "newer", "maoyan-data");
  fs.mkdirSync(older, { recursive: true });
  fs.mkdirSync(newer, { recursive: true });
  fs.writeFileSync(path.join(older, "browser_state.json"), '{"cookies":[]}');
  fs.writeFileSync(path.join(newer, "browser_state.json"), '{"cookies":[]}');
  const olderMtime = Date.now() - 60_000;
  const newerMtime = Date.now();
  fs.utimesSync(path.join(older, "browser_state.json"), olderMtime / 1000, olderMtime / 1000);
  fs.utimesSync(path.join(newer, "browser_state.json"), newerMtime / 1000, newerMtime / 1000);

  const picked = svc.pickCanonicalDataDir([older, newer]);
  assert.strictEqual(path.resolve(picked), path.resolve(newer));
  console.log("OK: pickCanonicalDataDir prefers newest browser_state.json");
}

function testDefaultWhenNoSession() {
  const svc = loadService();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-empty-"));
  const first = path.join(root, "first", "maoyan-data");
  const second = path.join(root, "second", "maoyan-data");
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  const picked = svc.pickCanonicalDataDir([first, second]);
  assert.strictEqual(path.resolve(picked), path.resolve(first));
  console.log("OK: pickCanonicalDataDir defaults to first candidate without session");
}

function main() {
  testPickNewestBrowserState();
  testDefaultWhenNoSession();
  console.log("\nALL PASSED (data dir canonical)");
}

main();
