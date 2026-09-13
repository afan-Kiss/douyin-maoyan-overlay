/**
 * 签名错误传播回归：node deploy/test-sig-errors.js
 */
const assert = require("assert");

async function main() {
  const { isNonRetryableSigError } = await import("../server/lib/logger.js");

  assert.strictEqual(isNonRetryableSigError(new Error("chrome_not_found")), true);
  assert.strictEqual(isNonRetryableSigError(new Error("login_in_progress")), true);
  assert.strictEqual(isNonRetryableSigError(new Error("sig_capture_failed")), false);
  console.log("ALL PASSED (sig errors)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
