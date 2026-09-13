/**
 * 核心回归（不依赖真人登录）；SKIP 视为失败
 * node deploy/test-core.js
 */
const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const TESTS = [
  { name: "repo-integrity", script: "deploy/test-repo-integrity.js", needsChrome: false },
  { name: "box-units", script: "deploy/test-box-units.js", needsChrome: false },
  { name: "round5-fixes", script: "deploy/test-round5-fixes.js", needsChrome: false },
  { name: "enrich-interval", script: "deploy/test-enrich-interval.js", needsChrome: false },
  { name: "module-load", script: "deploy/test-module-load.js", needsChrome: false },
  { name: "browser-state", script: "deploy/test-browser-state-immutable.js", needsChrome: false },
  { name: "stability", script: "deploy/test-stability-round4.js", needsChrome: false },
  { name: "session-capability", script: "deploy/test-session-capability.js", needsChrome: false },
  { name: "layout-top5", script: "deploy/test-layout-top5.js", needsChrome: true },
  { name: "data-consistency", script: "deploy/test-data-consistency.js", needsChrome: false },
  { name: "extra-metrics", script: "deploy/test-extra-metrics.js", needsChrome: false },
];

function runTest(test) {
  const result = spawnSync(process.execPath, [path.join(ROOT, test.script)], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status === 2 || (/SKIP/i.test(output) && result.status === 0)) {
    return { name: test.name, status: "SKIP", detail: output.trim() };
  }
  if (result.status !== 0) {
    return { name: test.name, status: "FAIL", detail: output.trim() };
  }
  return { name: test.name, status: "PASS", detail: output.trim() };
}

function main() {
  const results = TESTS.map(runTest);
  let failed = false;

  for (const item of results) {
    console.log(`\n=== ${item.name}: ${item.status} ===`);
    if (item.detail) console.log(item.detail);
    if (item.status !== "PASS") failed = true;
  }

  if (failed) {
    console.error("\nCORE TESTS FAILED (SKIP counts as failure)");
    process.exit(1);
  }
  console.log("\nALL CORE TESTS PASSED");
}

main();
