/**
 * 万亿显示 + enrich 调度 + 气泡 duration 回归
 * node deploy/test-round5-fixes.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");

async function testWanDisplay() {
  const boxDisplayPath = pathToFileURL(path.join(ROOT, "ui", "box-display.js")).href;
  const { formatWanForDisplay, formatWanDisplayText } = await import(boxDisplayPath);

  const cases = [
    [9999, "9999", "万"],
    [10000, "1.00", "亿"],
    [12300, "1.23", "亿"],
    [215300, "21.53", "亿"],
  ];

  for (const [amount, valueText, unit] of cases) {
    const result = formatWanForDisplay(amount);
    assert.strictEqual(result.valueText, valueText, `${amount} valueText`);
    assert.strictEqual(result.unit, unit, `${amount} unit`);
    assert.strictEqual(formatWanDisplayText(amount), `${valueText}${unit}`);
  }

  assert.strictEqual(formatWanDisplayText(12300), "1.23亿");
  assert.notStrictEqual(formatWanDisplayText(12300), "12300亿");

  console.log("PASS wan display formatting");
  console.log("  9999 -> 9999万");
  console.log("  12300 -> 1.23亿");
  console.log("  215300 -> 21.53亿");
}

async function testEnrichIntervalWithScheduler() {
  const schedulerPath = pathToFileURL(path.join(ROOT, "ui", "enrich-scheduler.js")).href;
  const {
    createEnrichScheduleSimulator,
  } = await import(schedulerPath);

  const POLL_INTERVAL_MS = 5000;
  const FULL_INTERVAL_MS = 60000;
  const POLL_COUNT = 12;

  const sim = createEnrichScheduleSimulator({
    fullIntervalMs: FULL_INTERVAL_MS,
    runEnrich: async () => ({ failed: false }),
  });

  for (let i = 0; i < POLL_COUNT; i++) {
    await sim.onPoll(i * POLL_INTERVAL_MS);
  }
  await sim.waitSettled();

  const stats = sim.getStats();
  assert.strictEqual(stats.fullEnrichCount, 1, "60s 内应仅 1 次完整 enrich");
  assert.strictEqual(stats.maxConcurrentFullEnrich, 1);

  const failSim = createEnrichScheduleSimulator({
    fullIntervalMs: FULL_INTERVAL_MS,
    runEnrich: async () => ({ failed: true }),
  });

  await failSim.onPoll(0);
  await failSim.waitSettled();
  assert.strictEqual(failSim.getStats().fullEnrichCount, 1, "首次 enrich 应执行");

  for (let i = 1; i <= 5; i++) {
    await failSim.onPoll(i * POLL_INTERVAL_MS);
  }
  await failSim.waitSettled();
  assert.strictEqual(
    failSim.getStats().fullEnrichCount,
    1,
    "失败后 30 秒内不得再次 full enrich",
  );

  console.log("PASS enrich interval via real scheduler");
  console.log(`  fullEnrichCount=${stats.fullEnrichCount}`);
  console.log(`  failure retry blocked for 30s`);
}

async function testEnrichTimeoutSingleflight() {
  const schedulerPath = pathToFileURL(path.join(ROOT, "ui", "enrich-scheduler.js")).href;
  const { createEnrichScheduleSimulator, FULL_ENRICH_GLOBAL_TIMEOUT_MS } = await import(schedulerPath);

  let abortSeen = false;
  const sim = createEnrichScheduleSimulator({
    fullIntervalMs: 60000,
    globalTimeoutMs: 80,
    runEnrich: async ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          abortSeen = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      }),
  });

  const firstTask = sim.onPoll(0);
  assert.ok(sim.state.enrichingBackground, "第一轮 enrich 进行中");

  await sim.onPoll(5000);
  assert.strictEqual(sim.getStats().fullEnrichCount, 1, "并发 enrich 不得大于 1");
  assert.strictEqual(sim.getStats().maxConcurrentFullEnrich, 1);

  await firstTask;
  await sim.waitSettled();
  assert.ok(abortSeen, "global timeout 应 abort 旧任务");
  assert.strictEqual(sim.state.enrichingBackground, false, "旧任务 settle 后 enrichingBackground 应为 false");

  sim.state.enrichFailureCount = 0;
  sim.state.lastFullEnrichAttempt = 0;

  await sim.onPoll(60000);
  await sim.waitSettled();
  assert.strictEqual(sim.getStats().fullEnrichCount, 2, "旧任务结束后才可启动下一轮");
  assert.strictEqual(sim.getStats().maxConcurrentFullEnrich, 1);

  console.log("PASS enrich timeout singleflight");
  console.log(`  maxConcurrentFullEnrich=${sim.getStats().maxConcurrentFullEnrich}`);
  console.log(`  globalTimeoutMs=${FULL_ENRICH_GLOBAL_TIMEOUT_MS}`);
}

function testBubbleDurationCss() {
  const css = fs.readFileSync(path.join(ROOT, "ui", "styles.css"), "utf-8");
  const appJs = fs.readFileSync(path.join(ROOT, "ui", "app.js"), "utf-8");

  assert.match(css, /animation:\s*inlineDeltaFloat\s+var\(--bubble-duration/);
  assert.doesNotMatch(css, /animation:\s*inlineDeltaFloat\s+3s/);
  assert.match(appJs, /getBubbleDurationMs\(\)/);
  assert.doesNotMatch(appJs, /DELTA_ANIM_MS/);

  console.log("PASS bubble duration uses --bubble-duration + settings timer");
}

async function main() {
  await testWanDisplay();
  await testEnrichIntervalWithScheduler();
  await testEnrichTimeoutSingleflight();
  testBubbleDurationCss();
  console.log("\nALL PASSED (round5 fixes)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
