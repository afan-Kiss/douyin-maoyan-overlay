/**
 * 气泡高水位：低于上次读数抛弃；不合理大跳静默抬基线；无涨仍可 tick 出暂无变化。
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
    tickBubbleSamples,
    clearBubbleSamples,
    getBubbleSample,
    BUBBLE_SKIP,
  } = mod;

  clearBubbleSamples();
  const el = { isConnected: true, classList: { remove() {} }, textContent: "" };
  const reasonable = (prev, next, delta) =>
    Number.isFinite(delta) && delta > 0 && delta <= Math.max(prev * 3, 200);

  const key = "movie-hw-1";
  let r = submitBubbleSample({
    key,
    el,
    amount: 100,
    decodeVerified: true,
    bubbleEnabled: true,
    isReasonableDelta: reasonable,
  });
  assert.equal(r.action, "baseline");
  assert.equal(getBubbleSample(key).baseline, 100);

  r = submitBubbleSample({
    key,
    el,
    amount: 101,
    decodeVerified: true,
    bubbleEnabled: true,
    isReasonableDelta: reasonable,
  });
  assert.equal(r.action, "pulse");
  assert.equal(r.delta, 1);
  assert.equal(getBubbleSample(key).baseline, 101);
  assert.equal(getBubbleSample(key).amount, 101);

  r = submitBubbleSample({
    key,
    el,
    amount: 99,
    decodeVerified: true,
    bubbleEnabled: true,
    isReasonableDelta: reasonable,
  });
  assert.equal(r.action, "skip");
  assert.equal(r.reason, BUBBLE_SKIP.REJECTED_LOWER);
  assert.equal(getBubbleSample(key).amount, 101, "lower reading must not pull amount down");
  assert.equal(getBubbleSample(key).baseline, 101, "lower reading must not pull baseline down");

  const pulses = [];
  const noChanges = [];
  tickBubbleSamples({
    isReasonableDelta: reasonable,
    bubbleEnabled: true,
    isVisible: () => false,
    onPulse: (_el, delta, k) => pulses.push({ delta, k }),
    onNoChange: (_el, k) => noChanges.push(k),
  });
  assert.equal(pulses.length, 0);
  assert.deepEqual(noChanges, [], "no-change tick must not emit idle bubble");

  r = submitBubbleSample({
    key,
    el,
    amount: 102,
    decodeVerified: true,
    bubbleEnabled: true,
    isReasonableDelta: reasonable,
  });
  assert.equal(r.action, "pulse");
  assert.equal(r.delta, 1);

  // 不合理过大：抬齐基线，不 pulse
  r = submitBubbleSample({
    key,
    el,
    amount: 900,
    decodeVerified: true,
    bubbleEnabled: true,
    isReasonableDelta: reasonable,
  });
  assert.equal(r.action, "baseline");
  assert.equal(r.reason, BUBBLE_SKIP.UNREASONABLE_DELTA);
  assert.equal(getBubbleSample(key).amount, 900);
  assert.equal(getBubbleSample(key).baseline, 900);

  console.log("PASS: bubble high-water reject + unreasonable rebase");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
