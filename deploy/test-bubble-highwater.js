/**
 * 高水位：回落不更新；再上涨相对 lastValidBox。
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const mod = await import(
    pathToFileURL(path.resolve(__dirname, "../ui/bubble-tracker.js")).href
  );
  const { ingestBoxSample, clearBoxStates } = mod;
  clearBoxStates();
  const key = "hw";

  assert.equal(ingestBoxSample(key, 100).action, "first");
  assert.equal(ingestBoxSample(key, 101).action, "rise");
  assert.equal(ingestBoxSample(key, 99).action, "drop");
  assert.equal(ingestBoxSample(key, 99).displayBox, 101);
  const rise = ingestBoxSample(key, 102);
  assert.equal(rise.action, "rise");
  assert.ok(Math.abs(rise.delta - 1) < 1e-9);

  // 不合理过大仍按简单规则上涨（用户要求去掉复杂 unreasonable）
  const jump = ingestBoxSample(key, 500);
  assert.equal(jump.action, "rise");

  console.log("PASS: bubble high-water reject + unreasonable rebase");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
