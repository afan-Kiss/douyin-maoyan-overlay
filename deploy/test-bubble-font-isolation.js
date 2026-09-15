/**
 * 气泡字体隔离：新字体没有自己的 map 时，绝不能回退到旧字体 map。
 * 否则错误大数会污染 high-water，后续真实上涨会一直被当成回落。
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const registry = await import(
    pathToFileURL(path.resolve(__dirname, "../ui/font-registry.js")).href
  );

  registry.clearFontRegistry();
  registry.cacheMapForFont("font-old", {
    ok: true,
    confidence: "inferred",
    map: new Map([[0xe001, "9"]]),
  });

  assert.ok(registry.getMapForKeyLoose("font-old"), "same font should use its inferred map");
  assert.equal(
    registry.getMapForKeyLoose("font-new"),
    null,
    "new font must not borrow an unrelated old map",
  );

  registry.cacheMapForFont("font-new", {
    ok: true,
    confidence: "inferred",
    map: new Map([[0xe001, "1"]]),
  });
  const current = registry.getMapForKeyLoose("font-new");
  assert.equal(current.get(0xe001), "1", "new font should use its own map once available");

  console.log("PASS: bubble font mapping is isolated per font identity");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
