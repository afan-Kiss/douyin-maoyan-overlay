/**
 * 气泡高水位场景回归：正常涨、不变、短暂回落、回落后再超高水位、长期不变后上涨。
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const mod = await import(
    pathToFileURL(path.resolve(__dirname, "../ui/bubble-tracker.js")).href
  );
  const {
    submitBubbleSample,
    clearBubbleSamples,
    getBubbleSample,
    BUBBLE_SKIP,
  } = mod;

  clearBubbleSamples();
  const el = { isConnected: true, classList: { remove() {} }, textContent: "" };
  const reasonable = (prev, next, delta) =>
    Number.isFinite(delta) && delta > 0 && !(prev >= 1 && delta > prev * 3 && delta > 200);
  const key = "movie-scenarios";

  const push = (amount) =>
    submitBubbleSample({
      key,
      el,
      amount,
      decodeVerified: true,
      bubbleEnabled: true,
      isReasonableDelta: reasonable,
    });

  // A: 852.22 → 853.22 = +1万
  assert.equal(push(852.22).action, "baseline");
  const rise = push(853.22);
  assert.equal(rise.action, "pulse");
  assert.ok(Math.abs(rise.delta - 1) < 1e-6, `expected +1, got ${rise.delta}`);

  // B: 相同数据不产生假增长
  assert.equal(push(853.22).reason, BUBBLE_SKIP.DUPLICATE_AMOUNT);

  // C: 短暂回落不覆盖高水位
  const down = push(851.9);
  assert.equal(down.reason, BUBBLE_SKIP.REJECTED_LOWER);
  assert.equal(getBubbleSample(key).amount, 853.22);
  assert.equal(getBubbleSample(key).baseline, 853.22);

  // D: 回落后再超高水位，相对 853.22 而不是 851.9
  const recover = push(853.5);
  assert.equal(recover.action, "pulse");
  assert.ok(Math.abs(recover.delta - 0.28) < 1e-6, `expected +0.28, got ${recover.delta}`);

  // F: 长期相同后突然上涨
  for (let i = 0; i < 40; i += 1) {
    assert.equal(push(853.5).reason, BUBBLE_SKIP.DUPLICATE_AMOUNT);
  }
  const lateRise = push(854.5);
  assert.equal(lateRise.action, "pulse");
  assert.ok(Math.abs(lateRise.delta - 1) < 1e-6, `expected late +1, got ${lateRise.delta}`);

  console.log("PASS: bubble high-water scenarios A/B/C/D/F");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
