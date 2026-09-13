/**
 * API 错误协议回归：node deploy/test-api-errors.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

async function main() {
  const loginSource = fs.readFileSync(path.join(__dirname, "..", "server", "login.js"), "utf-8");
  assert.ok(
    loginSource.includes('require("../lib/login-browser.js")'),
    "server/login.js 应引用 ../lib/login-browser.js",
  );
  assert.ok(fs.existsSync(path.join(__dirname, "..", "login.bat")), "login.bat 应存在");

  const indexSource = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf-8");
  assert.ok(indexSource.includes("buildApiErrorPayload"), "server/index.js 应统一错误协议");
  assert.ok(indexSource.includes("/api/diagnostics"), "应提供 diagnostics 接口");

  const { UpstreamError } = await import("../server/lib/sigManager.js");
  assert.strictEqual(new UpstreamError(403, "upstream_failed").status, 403);

  const { parseDashboard, resetApiSigWarm } = await import("../ui/maoyan-api.js");
  const raw = {
    movieList: {
      list: Array.from({ length: 12 }, (_, i) => ({
        movieInfo: { movieId: i + 1, movieName: `电影${i + 1}` },
        boxSplitUnit: { num: "1", unit: "万" },
      })),
      nationBoxInfo: {},
      updateInfo: { updateTimestamp: Date.now() },
    },
    calendar: { today: "2026-09-13" },
  };
  assert.strictEqual(parseDashboard(raw, 10).movies.length, 10);
  resetApiSigWarm();

  const sigSource = fs.readFileSync(
    path.join(__dirname, "..", "server", "lib", "sigManager.js"),
    "utf-8",
  );
  assert.ok(sigSource.includes("isNonRetryableSigError"), "sigManager 应保留确定性错误");

  console.log("ALL PASSED (api errors)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
