/**
 * PUA 实体识别统一逻辑回归
 * node deploy/test-pua-entity.js
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");

async function main() {
  const rankPath = pathToFileURL(path.join(ROOT, "ui", "dashboard-rank.js")).href;
  const apiPath = pathToFileURL(path.join(ROOT, "ui", "maoyan-api.js")).href;
  const {
    containsEncodedBoxMarkup,
    countEncodedBoxGlyphs,
    isPuaCodePoint,
    PUA_MIN,
    PUA_MAX,
  } = await import(rankPath);
  const { isEncodedBoxHtml, boxHtmlUsesAntiScrapeFont } = await import(apiPath);

  const puaHex = ["&#xe8ee;", "&#xea12;", "&#xebcd;", "&#xf123;", "&#xf8ff;"];
  for (const entity of puaHex) {
    assert.ok(containsEncodedBoxMarkup(entity), `${entity} should be PUA encoded`);
    assert.strictEqual(countEncodedBoxGlyphs(entity), 1, entity);
    assert.ok(isEncodedBoxHtml(entity), `${entity} isEncodedBoxHtml`);
    assert.ok(boxHtmlUsesAntiScrapeFont(entity), `${entity} boxHtmlUsesAntiScrapeFont`);
  }

  const puaDec = `&#${0xe8ee};`;
  assert.ok(containsEncodedBoxMarkup(puaDec), "decimal PUA entity");
  assert.ok(isEncodedBoxHtml(puaDec));

  const plainNum = "&#48;&#46;&#53;&#48;";
  assert.ok(!containsEncodedBoxMarkup(plainNum), "digit entities are not PUA");
  assert.ok(!isEncodedBoxHtml(plainNum));

  const plainHtml = "<span>101.60</span>";
  assert.ok(!containsEncodedBoxMarkup(plainHtml));
  assert.ok(!isEncodedBoxHtml(plainHtml));

  const mixed = "&#xe8ee;&#48;&#xea12;";
  assert.strictEqual(countEncodedBoxGlyphs(mixed), 2);

  assert.ok(isPuaCodePoint(PUA_MIN));
  assert.ok(isPuaCodePoint(PUA_MAX));
  assert.ok(!isPuaCodePoint(0x0041));
  assert.ok(!isPuaCodePoint(0xf900));

  const literalPua = String.fromCodePoint(0xe8ee);
  assert.ok(containsEncodedBoxMarkup(literalPua));

  console.log("PASS PUA entity detection");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
