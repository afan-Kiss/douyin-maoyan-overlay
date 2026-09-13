/**
 * 模块加载不得出现 logger ↔ sigManager 循环依赖
 * node deploy/test-module-load.js
 */
const assert = require("assert");

async function main() {
  const loggerMod = await import("../server/lib/logger.js");
  assert.ok(loggerMod.log);
  assert.ok(loggerMod.buildDiagnostics);
  const sigMod = await import("../server/lib/sigManager.js");
  assert.ok(sigMod.manager);

  const loggerSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "server", "lib", "logger.js"),
    "utf-8",
  );
  assert.ok(!loggerSource.includes('from "./sigManager.js"'), "logger must not import sigManager");

  console.log("PASS module load without logger↔sigManager cycle");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
