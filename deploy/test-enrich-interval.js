/**
 * 详细 enrich 频率：真实 scheduler，60 秒内仅首次完整 enrich
 * node deploy/test-enrich-interval.js
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const POLL_INTERVAL_MS = 5000;
const FULL_INTERVAL_MS = 60000;
const POLL_COUNT = 12;

async function main() {
  const schedulerPath = pathToFileURL(path.join(__dirname, "..", "ui", "enrich-scheduler.js")).href;
  const { createEnrichScheduleSimulator } = await import(schedulerPath);

  const sim = createEnrichScheduleSimulator({
    fullIntervalMs: FULL_INTERVAL_MS,
    runEnrich: async () => ({ failed: false }),
  });

  for (let i = 0; i < POLL_COUNT; i++) {
    await sim.onPoll(i * POLL_INTERVAL_MS);
  }
  await sim.waitSettled();

  const result = {
    dashboardRefreshCount: POLL_COUNT,
    fullEnrichCount: sim.getStats().fullEnrichCount,
    maxConcurrentEnrich: sim.getStats().maxConcurrentFullEnrich,
    detailApiCalls: sim.getStats().fullEnrichCount,
  };

  assert.strictEqual(result.dashboardRefreshCount, POLL_COUNT);
  assert.strictEqual(result.fullEnrichCount, 1, "60s 内应仅 1 次完整 enrich");
  assert.strictEqual(result.detailApiCalls, 1, "dashboard 刷新不得每次调用详细接口");
  assert.strictEqual(result.maxConcurrentEnrich, 1);

  console.log("PASS enrich interval via real scheduler");
  console.log(`  dashboardRefreshCount=${result.dashboardRefreshCount}`);
  console.log(`  fullEnrichCount=${result.fullEnrichCount}`);
  console.log(`  maxConcurrentEnrich=${result.maxConcurrentEnrich}`);
  console.log("\nALL PASSED (enrich interval)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
