/**
 * 气泡高水位场景：正常涨、不变、短暂回落、回落后再超高水位、长期不变后上涨。
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
  const key = "movie-scenarios";
  const push = (amount) => ingestBoxSample(key, amount);

  assert.equal(push(852.22).action, "first");
  const rise = push(853.22);
  assert.equal(rise.action, "rise");
  assert.ok(Math.abs(rise.delta - 1) < 1e-6, `expected +1, got ${rise.delta}`);

  assert.equal(push(853.22).action, "same");
  assert.equal(push(850).action, "drop");
  assert.equal(push(853.22).displayBox, 853.22);

  const again = push(854.22);
  assert.equal(again.action, "rise");

  for (let i = 0; i < 20; i += 1) assert.equal(push(854.22).action, "same");
  const late = push(855.22);
  assert.equal(late.action, "rise");

  console.log("PASS bubble scenarios (simple lastValidBox)");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
