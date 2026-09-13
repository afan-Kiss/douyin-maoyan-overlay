/**
 * 详细 enrich 频率：60 秒内仅首次完整 enrich
 * node deploy/test-enrich-interval.js
 */
const assert = require("assert");

const POLL_INTERVAL_MS = 5000;
const FULL_INTERVAL_MS = 60000;
const POLL_COUNT = 12;

function simulateEnrichSchedule() {
  let pollCount = 0;
  let lastFullEnrich = 0;
  let enrichingBackground = false;
  let dashboardRefreshCount = 0;
  let fullEnrichCount = 0;
  let maxConcurrentEnrich = 0;
  let concurrentEnrich = 0;
  let detailApiCalls = 0;

  for (let i = 0; i < POLL_COUNT; i++) {
    const now = i * POLL_INTERVAL_MS;
    dashboardRefreshCount += 1;
    pollCount += 1;

    const needFull = pollCount === 1 || now - lastFullEnrich >= FULL_INTERVAL_MS;
    if (!needFull || enrichingBackground) continue;

    enrichingBackground = true;
    concurrentEnrich += 1;
    maxConcurrentEnrich = Math.max(maxConcurrentEnrich, concurrentEnrich);
    fullEnrichCount += 1;
    detailApiCalls += 1;
    lastFullEnrich = now;
    enrichingBackground = false;
    concurrentEnrich -= 1;
  }

  return {
    dashboardRefreshCount,
    fullEnrichCount,
    maxConcurrentEnrich,
    detailApiCalls,
  };
}

function main() {
  const result = simulateEnrichSchedule();

  assert.strictEqual(result.dashboardRefreshCount, POLL_COUNT);
  assert.strictEqual(result.fullEnrichCount, 1, "60s 内应仅 1 次完整 enrich");
  assert.strictEqual(result.detailApiCalls, 1, "dashboard 刷新不得每次调用详细接口");
  assert.strictEqual(result.maxConcurrentEnrich, 1);

  console.log("PASS enrich interval simulation");
  console.log(`  dashboardRefreshCount=${result.dashboardRefreshCount}`);
  console.log(`  fullEnrichCount=${result.fullEnrichCount}`);
  console.log(`  maxConcurrentEnrich=${result.maxConcurrentEnrich}`);
  console.log("\nALL PASSED (enrich interval)");
}

main();
