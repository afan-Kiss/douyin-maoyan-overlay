/**
 * update-push single-flight 验收：node deploy/test-update-push-singleflight.js
 */
const assert = require("assert");

let pollInFlight = 0;
let maxConcurrent = 0;

const originalFetch = global.fetch;

global.fetch = async (url, options) => {
  const href = String(url);
  if (href.includes("/api/update/command")) {
    pollInFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, pollInFlight);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    pollInFlight -= 1;
    return {
      ok: true,
      json: async () => ({ command: null }),
    };
  }
  if (originalFetch) return originalFetch(url, options);
  throw new Error(`unexpected fetch: ${href}`);
};

delete require.cache[require.resolve("../lib/update-push")];
const { startUpdatePush } = require("../lib/update-push");

async function testSingleFlight() {
  const fakeManager = {
    isBusy: () => false,
    checkAndApplyIfAvailable: async () => false,
  };

  const stop = startUpdatePush("http://127.0.0.1:19999", fakeManager, {
    intervalMs: 2000,
  });

  await new Promise((resolve) => setTimeout(resolve, 6500));
  stop();

  assert.ok(maxConcurrent <= 1, `max concurrent polls must be <=1, got ${maxConcurrent}`);
  console.log("OK: update push poll single-flight");
}

async function main() {
  await testSingleFlight();
  global.fetch = originalFetch;
  console.log("\nALL PASSED (update push singleflight)");
}

main().catch((error) => {
  global.fetch = originalFetch;
  console.error(error);
  process.exit(1);
});
