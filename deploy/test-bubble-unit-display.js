/**
 * 气泡增量统一显示「万」
 * node deploy/test-bubble-unit-display.js
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

async function main() {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "ui", "rise-engine.js")).href);
  const { formatRiseText, formatRiseTextWithArrow } = mod;

  // 内部单位是「万」；下列对应 500/1000/10000/50000 元
  assert.strictEqual(formatRiseText(0.05), "+0.05万");
  assert.strictEqual(formatRiseText(0.1), "+0.10万");
  assert.strictEqual(formatRiseText(1), "+1.00万");
  assert.strictEqual(formatRiseText(5), "+5.00万");

  assert.strictEqual(formatRiseTextWithArrow(0.05), "+0.05万 ↑");
  assert.strictEqual(formatRiseTextWithArrow(0.1), "+0.10万 ↑");
  assert.strictEqual(formatRiseTextWithArrow(1), "+1.00万 ↑");
  assert.strictEqual(formatRiseTextWithArrow(5), "+5.00万 ↑");

  // 禁止再显示「元」
  assert.ok(!formatRiseText(0.05).includes("元"));
  assert.ok(!formatRiseText(0.5).includes("元"));

  console.log("PASS bubble unit display");
  console.log("  500元 → +0.05万");
  console.log("  1000元 → +0.10万");
  console.log("  10000元 → +1.00万");
  console.log("  50000元 → +5.00万");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
