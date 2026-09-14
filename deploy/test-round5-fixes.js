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

async function testEnrich403Backoff() {
  const schedulerPath = pathToFileURL(path.join(ROOT, "ui", "enrich-scheduler.js")).href;
  const {
    createEnrichScheduleSimulator,
    createEnrichScheduleState,
    shouldScheduleFullEnrich,
    shouldMarkFullEnrichFailure,
    getFullEnrichRetryDelayMs,
    markFullEnrichSuccess,
    FULL_ENRICH_FAILURE_BACKOFF_MS,
  } = await import(schedulerPath);

  const errors403 = [
    { movieId: "1001", label: "日期票房", code: "upstream_403", detail: "403 forbidden" },
  ];
  assert.ok(shouldMarkFullEnrichFailure(errors403), "403 应归类为 full enrich 失败");

  const partialErrors = [
    { movieId: "1001", label: "全球票房", code: "api_error", detail: "timeout" },
  ];
  assert.ok(!shouldMarkFullEnrichFailure(partialErrors), "个别非关键字段失败不应记 full failure");

  const POLL_INTERVAL_MS = 5000;
  const FULL_INTERVAL_MS = 60000;

  const failSim = createEnrichScheduleSimulator({
    fullIntervalMs: FULL_INTERVAL_MS,
    runEnrich: async () => ({ errors: errors403 }),
  });

  await failSim.onPoll(0);
  await failSim.waitSettled();
  assert.strictEqual(failSim.state.enrichFailureCount, 1, "403 后 failureCount=1");
  assert.strictEqual(getFullEnrichRetryDelayMs(1), 30000);
  assert.strictEqual(failSim.getStats().fullEnrichCount, 1, "首次 enrich 应执行");

  for (let i = 1; i <= 5; i++) {
    await failSim.onPoll(i * POLL_INTERVAL_MS);
  }
  await failSim.waitSettled();
  assert.strictEqual(
    failSim.getStats().fullEnrichCount,
    1,
    "403 失败后 30 秒内不得再次 full enrich",
  );

  const backoffState = createEnrichScheduleState();
  backoffState.enrichFailureCount = 0;
  backoffState.lastFullEnrichFailureAt = 0;
  for (let i = 0; i < FULL_ENRICH_FAILURE_BACKOFF_MS.length; i++) {
    backoffState.enrichFailureCount = i + 1;
    backoffState.lastFullEnrichFailureAt = 1000;
    const delay = getFullEnrichRetryDelayMs(backoffState.enrichFailureCount);
    assert.strictEqual(delay, FULL_ENRICH_FAILURE_BACKOFF_MS[i]);
    assert.ok(!shouldScheduleFullEnrich(1000 + delay - 1, backoffState, FULL_INTERVAL_MS));
    assert.ok(shouldScheduleFullEnrich(1000 + delay, backoffState, FULL_INTERVAL_MS));
  }

  markFullEnrichSuccess(backoffState, Date.now());
  assert.strictEqual(backoffState.enrichFailureCount, 0, "成功一次后 failureCount=0");

  console.log("PASS enrich 403 backoff + real error classification");
  console.log(`  failureCount=${failSim.state.enrichFailureCount}`);
  console.log(`  retry delays=${FULL_ENRICH_FAILURE_BACKOFF_MS.join(",")}ms`);
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

  console.log("PASS enrich interval via real scheduler");
  console.log(`  fullEnrichCount=${stats.fullEnrichCount}`);
}

async function testSettingsResetSingleflight() {
  const schedulerPath = pathToFileURL(path.join(ROOT, "ui", "enrich-scheduler.js")).href;
  const {
    createEnrichScheduleState,
    shouldScheduleFullEnrich,
    markFullEnrichAttempt,
    resetEnrichScheduleState,
  } = await import(schedulerPath);

  const state = createEnrichScheduleState();
  let enrichGeneration = 0;
  let currentController = null;
  let currentPromise = null;
  let fullEnrichCount = 0;
  let concurrentFullEnrich = 0;
  let maxConcurrentFullEnrich = 0;
  let firstStillRunning = false;

  async function abortAndReset() {
    enrichGeneration += 1;
    currentController?.abort();
    if (currentPromise) {
      try {
        await currentPromise;
      } catch {
        /* aborted */
      }
    }
    currentController = null;
    currentPromise = null;
    resetEnrichScheduleState(state, { clearInflight: true });
  }

  function tryStartEnrich(now, pollCount = 1) {
    if (state.enrichingBackground) return false;
    state.pollCount = pollCount;
    if (!shouldScheduleFullEnrich(now, state, 60000)) return false;

    const gen = enrichGeneration;
    state.enrichingBackground = true;
    markFullEnrichAttempt(state, now);
    fullEnrichCount += 1;
    concurrentFullEnrich += 1;
    maxConcurrentFullEnrich = Math.max(maxConcurrentFullEnrich, concurrentFullEnrich);

    const controller = new AbortController();
    currentController = controller;

    const promise = new Promise((resolve, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
      setTimeout(() => {
        if (gen === enrichGeneration) firstStillRunning = false;
        resolve();
      }, 5000);
    }).finally(() => {
      concurrentFullEnrich -= 1;
      if (gen === enrichGeneration) state.enrichingBackground = false;
      if (currentPromise === promise) {
        currentController = null;
        currentPromise = null;
      }
    });

    currentPromise = promise;
    firstStillRunning = true;
    return true;
  }

  assert.ok(tryStartEnrich(0), "第一轮 enrich 应启动");
  assert.ok(state.enrichingBackground, "第一轮 enrich 进行中");

  await abortAndReset();
  assert.ok(!firstStillRunning || currentPromise === null, "settings reset 应等待旧任务 settle");

  assert.ok(tryStartEnrich(1000), "settings reset 后 refresh 可启动新一轮");
  assert.strictEqual(maxConcurrentFullEnrich, 1, "两轮 enrich 不得重叠");

  currentController?.abort();
  if (currentPromise) await currentPromise.catch(() => {});

  console.log("PASS settings reset singleflight");
  console.log(`  maxConcurrentFullEnrich=${maxConcurrentFullEnrich}`);
  console.log(`  fullEnrichCount=${fullEnrichCount}`);
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
  sim.state.lastFullEnrichFailureAt = 0;
  sim.state.lastFullEnrichSuccessAt = 0;

  await sim.onPoll(60000);
  await sim.waitSettled();
  assert.strictEqual(sim.getStats().fullEnrichCount, 2, "旧任务结束后才可启动下一轮");
  assert.strictEqual(sim.getStats().maxConcurrentFullEnrich, 1);

  console.log("PASS enrich timeout singleflight");
  console.log(`  maxConcurrentFullEnrich=${sim.getStats().maxConcurrentFullEnrich}`);
  console.log(`  globalTimeoutMs=${FULL_ENRICH_GLOBAL_TIMEOUT_MS}`);
}

async function testLongFailureBackoff() {
  const schedulerPath = pathToFileURL(path.join(ROOT, "ui", "enrich-scheduler.js")).href;
  const {
    createEnrichScheduleSimulator,
    shouldScheduleFullEnrich,
    FULL_ENRICH_GLOBAL_TIMEOUT_MS,
  } = await import(schedulerPath);

  let currentTime = 0;
  let releaseEnrich;
  const FULL_INTERVAL_MS = 60000;

  const sim = createEnrichScheduleSimulator({
    fullIntervalMs: FULL_INTERVAL_MS,
    nowFn: () => currentTime,
    runEnrich: async () => {
      await new Promise((resolve) => {
        releaseEnrich = resolve;
      });
      return { failed: true };
    },
  });

  currentTime = 0;
  const firstTask = sim.onPoll(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(sim.getStats().fullEnrichCount, 1, "0s 应启动首次 full enrich");

  currentTime = 120000;
  releaseEnrich();
  await firstTask;
  await sim.waitSettled();

  assert.strictEqual(sim.state.enrichFailureCount, 1, "120s 失败后 failureCount=1");
  sim.state.pollCount = 5;
  assert.ok(
    !shouldScheduleFullEnrich(125000, sim.state, FULL_INTERVAL_MS),
    "125s 不得重新执行（失败于120s + 退避30s = 150s）",
  );
  assert.ok(
    !shouldScheduleFullEnrich(149999, sim.state, FULL_INTERVAL_MS),
    "149.999s 不得重新执行",
  );
  assert.ok(
    shouldScheduleFullEnrich(150000, sim.state, FULL_INTERVAL_MS),
    "150s 才允许第二次 full enrich",
  );

  console.log("PASS long failure backoff from settled time");
  console.log(`  failureAt=120s retryAt=150s failureCount=${sim.state.enrichFailureCount}`);
}

async function testLongSuccessInterval() {
  const schedulerPath = pathToFileURL(path.join(ROOT, "ui", "enrich-scheduler.js")).href;
  const {
    createEnrichScheduleSimulator,
    shouldScheduleFullEnrich,
  } = await import(schedulerPath);

  let currentTime = 0;
  let releaseEnrich;
  const FULL_INTERVAL_MS = 60000;

  const sim = createEnrichScheduleSimulator({
    fullIntervalMs: FULL_INTERVAL_MS,
    nowFn: () => currentTime,
    runEnrich: async () => {
      await new Promise((resolve) => {
        releaseEnrich = resolve;
      });
      return { failed: false };
    },
  });

  currentTime = 0;
  const firstTask = sim.onPoll(0);
  await new Promise((resolve) => setImmediate(resolve));

  currentTime = 40000;
  releaseEnrich();
  await firstTask;
  await sim.waitSettled();

  sim.state.pollCount = 5;
  assert.ok(
    !shouldScheduleFullEnrich(99999, sim.state, FULL_INTERVAL_MS),
    "99.999s 不得重新执行（成功于40s + 间隔60s = 100s）",
  );
  assert.ok(
    shouldScheduleFullEnrich(100000, sim.state, FULL_INTERVAL_MS),
    "100s 才允许下一轮",
  );

  console.log("PASS long success interval from settled time");
  console.log(`  successAt=40s nextAt=100s`);
}

async function testGlobalTimeout120sBackoff() {
  const schedulerPath = pathToFileURL(path.join(ROOT, "ui", "enrich-scheduler.js")).href;
  const {
    createEnrichScheduleSimulator,
    shouldScheduleFullEnrich,
    FULL_ENRICH_GLOBAL_TIMEOUT_MS,
  } = await import(schedulerPath);

  let currentTime = 0;
  const POLL_INTERVAL_MS = 5000;
  const FULL_INTERVAL_MS = 60000;

  const sim = createEnrichScheduleSimulator({
    fullIntervalMs: FULL_INTERVAL_MS,
    globalTimeoutMs: 50,
    nowFn: () => currentTime,
    runEnrich: async ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          currentTime = FULL_ENRICH_GLOBAL_TIMEOUT_MS;
          reject(new DOMException("Aborted", "AbortError"));
        });
      }),
  });

  currentTime = 0;
  const firstTask = sim.onPoll(0);
  assert.ok(sim.state.enrichingBackground, "0s 启动 full enrich");

  await firstTask;
  await sim.waitSettled();

  assert.strictEqual(sim.state.enrichFailureCount, 1, "120s global timeout 应记失败");
  assert.strictEqual(sim.getStats().fullEnrichCount, 1, "timeout 前仅 1 次 full enrich");

  currentTime = 125000;
  await sim.onPoll(125000);
  await sim.waitSettled();
  assert.strictEqual(
    sim.getStats().fullEnrichCount,
    1,
    "失败后 5s dashboard poll 不得立即再次 full enrich",
  );
  sim.state.pollCount = 5;
  assert.ok(
    !shouldScheduleFullEnrich(125000, sim.state, FULL_INTERVAL_MS),
    "125s 仍须等待失败退避 30s（至 150s）",
  );

  currentTime = 150000;
  await sim.onPoll(150000);
  await sim.waitSettled();
  assert.strictEqual(sim.getStats().fullEnrichCount, 2, "150s 才允许第二次 full enrich");

  console.log("PASS global timeout 120s backoff from failure settled time");
  console.log(`  globalTimeoutMs=${FULL_ENRICH_GLOBAL_TIMEOUT_MS}`);
  console.log(`  failureAt=120s retryAt=150s fullEnrichCount=${sim.getStats().fullEnrichCount}`);
}

function testBubbleDurationCss() {
  const css = fs.readFileSync(path.join(ROOT, "ui", "styles.css"), "utf-8");
  const appJs = fs.readFileSync(path.join(ROOT, "ui", "app.js"), "utf-8");
  const { DEFAULT_SETTINGS, sanitizeSettings } = require(path.join(ROOT, "lib", "settings.js"));

  assert.strictEqual(DEFAULT_SETTINGS.bubble.durationMs, 2000);
  assert.strictEqual(sanitizeSettings({}).bubble.durationMs, 2000);
  assert.strictEqual(sanitizeSettings({ bubble: { durationMs: 1800 } }).bubble.durationMs, 1800);
  assert.strictEqual(sanitizeSettings({ bubble: { durationMs: 3000 } }).bubble.durationMs, 2000);
  assert.strictEqual(sanitizeSettings({ pollIntervalMs: 3000 }).pollIntervalMs, 2000);

  assert.match(css, /--bubble-duration:\s*2000ms/);
  assert.match(css, /animation:\s*inlineDeltaFloat\s+var\(--bubble-duration/);
  assert.doesNotMatch(css, /animation:\s*inlineDeltaFloat\s+3s/);
  assert.match(appJs, /getBubbleDurationMs\(\)/);
  assert.doesNotMatch(appJs, /DELTA_ANIM_MS/);

  console.log("PASS bubble duration default 2000ms + settings timer");
}

async function main() {
  await testWanDisplay();
  await testEnrich403Backoff();
  await testEnrichIntervalWithScheduler();
  await testSettingsResetSingleflight();
  await testEnrichTimeoutSingleflight();
  await testLongFailureBackoff();
  await testLongSuccessInterval();
  await testGlobalTimeout120sBackoff();
  testBubbleDurationCss();
  console.log("\nALL PASSED (round5 fixes)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
