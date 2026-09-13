/**
 * 票房内部单位统一为「万」
 * node deploy/test-box-units.js
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

async function main() {
  const { sanitizeSettings, TOP_COUNT } = require("../lib/settings");
  const migrated = sanitizeSettings({ topCount: 10, enrich: { trendLimit: 20 } });
  assert.strictEqual(migrated.topCount, TOP_COUNT);
  assert.strictEqual(migrated.enrich.trendLimit, TOP_COUNT);

  const apiPath = pathToFileURL(path.join(__dirname, "..", "ui", "maoyan-api.js")).href;
  const { parseBoxNum } = await import(apiPath);

  assert.strictEqual(parseBoxNum("1.23亿"), 12300);
  assert.strictEqual(parseBoxNum("0.99亿"), 9900);
  assert.strictEqual(parseBoxNum("9999万"), 9999);
  assert.strictEqual(parseBoxNum("1", "亿"), 10000);
  assert.strictEqual(parseBoxNum("1.00", "亿"), 10000);

  const prev = parseBoxNum("9999万");
  const next = parseBoxNum("1亿");
  const delta = next - prev;
  assert.ok(delta > 0, "9999万 -> 1亿 应为上涨");
  assert.ok(Math.abs(delta - 1) < 0.01, `delta 应约 1 万，实际 ${delta}`);

  const boxDisplayPath = pathToFileURL(path.join(__dirname, "..", "ui", "box-display.js")).href;
  const { formatWanForDisplay, formatWanDisplayText } = await import(boxDisplayPath);
  assert.deepStrictEqual(formatWanForDisplay(9999), { valueText: "9999", unit: "万" });
  assert.deepStrictEqual(formatWanForDisplay(10000), { valueText: "1.00", unit: "亿" });
  assert.deepStrictEqual(formatWanForDisplay(12300), { valueText: "1.23", unit: "亿" });
  assert.strictEqual(formatWanDisplayText(12300), "1.23亿");
  assert.notStrictEqual(formatWanDisplayText(12300), "12300亿");

  console.log("PASS box unit parsing & TOP5 settings migration");
  console.log(`  topCount=${migrated.topCount}, trendLimit=${migrated.enrich.trendLimit}`);
  console.log(`  1.23亿 internal=${parseBoxNum("1.23亿")} (万)`);
  console.log(`  9999万 -> 1亿 delta=${delta.toFixed(2)}万`);
  console.log("\nALL PASSED (box units)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
