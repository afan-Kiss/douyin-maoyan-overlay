/**
 * 气泡增量分级显示（元 / 万，不再使用千元）
 * node deploy/test-bubble-unit-display.js
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

async function main() {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "ui", "rise-engine.js")).href);
  const { formatRiseText, formatRiseTextWithArrow, formatRiseDelta } = mod;

  // 内部单位是「万」
  assert.strictEqual(formatRiseText(0.03), "+300元");
  assert.strictEqual(formatRiseText(0.05), "+500元");
  assert.strictEqual(formatRiseText(0.1), "+1000元");
  assert.strictEqual(formatRiseText(0.12), "+1200元");
  assert.strictEqual(formatRiseText(1), "+1万");
  assert.strictEqual(formatRiseText(1.25), "+1.25万");
  assert.strictEqual(formatRiseText(5.6), "+5.6万");

  assert.strictEqual(formatRiseTextWithArrow(0.03), "+300元 ↑");
  assert.strictEqual(formatRiseTextWithArrow(1), "+1万 ↑");

  assert.strictEqual(formatRiseDelta(300), "+300元");
  assert.strictEqual(formatRiseDelta(999), "+999元");
  assert.strictEqual(formatRiseDelta(1000), "+1000元");
  assert.strictEqual(formatRiseDelta(9999), "+9999元");
  assert.strictEqual(formatRiseDelta(10000), "+1万");
  assert.strictEqual(formatRiseDelta(12500), "+1.25万");
  assert.strictEqual(formatRiseDelta(560000), "+56万");

  console.log("PASS bubble unit display (yuan/wan, no qian)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
