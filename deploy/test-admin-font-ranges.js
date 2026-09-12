/**
 * admin 与 settings 字号范围一致性：node deploy/test-admin-font-ranges.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { FONT_RANGES } = require("../lib/font-ranges");
const adminJs = fs.readFileSync(path.join(__dirname, "..", "admin", "admin.js"), "utf-8");

const FONT_PATH_KEYS = {
  "fonts.heroTitle": "heroTitle",
  "fonts.heroSubtitle": "heroSubtitle",
  "fonts.nationBox": "nationBox",
  "fonts.nationLabel": "nationLabel",
  "fonts.movieTitle": "movieTitle",
  "fonts.movieRank": "movieRank",
  "fonts.region": "region",
  "fonts.metricLabel": "metricLabel",
  "fonts.metricValue": "metricValue",
  "fonts.table": "table",
  "fonts.footer": "footer",
};

function extractAdminRanges() {
  const found = {};
  for (const [fontPath, key] of Object.entries(FONT_PATH_KEYS)) {
    const re = new RegExp(
      `path:\\s*"${fontPath.replace(".", "\\.")}"[^\\n]*min:\\s*(\\d+)[^\\n]*max:\\s*(\\d+)`,
    );
    const match = adminJs.match(re);
    if (match) {
      found[key] = [Number(match[1]), Number(match[2])];
    }
  }
  return found;
}

function main() {
  const adminRanges = extractAdminRanges();
  for (const key of Object.keys(FONT_RANGES)) {
    const settingsRange = FONT_RANGES[key];
    const adminRange = adminRanges[key];
    assert.ok(adminRange, `admin.js missing range for ${key}`);
    assert.deepStrictEqual(adminRange, settingsRange, `range drift for ${key}`);
  }
  console.log("OK: admin fallback ranges match FONT_RANGES");
  console.log("\nALL PASSED (admin font ranges)");
}

main();
