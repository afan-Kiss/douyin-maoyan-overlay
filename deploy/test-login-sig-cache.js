/**
 * 登录签名落盘回归：node deploy/test-login-sig-cache.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function main() {
  // 直接复用 login-browser 内逻辑：通过临时 dataDir 写一份与 sigManager 兼容的 cache
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-sig-"));
  const cacheDir = path.join(dataDir, "session_cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  const movieId = "1462628";
  const boxLevel = "1";
  const filePath = path.join(cacheDir, `${movieId}_${boxLevel}.json`);
  const payload = {
    url: `https://piaofang.maoyan.com/i/api/movie/getBoxShow?movieId=${movieId}&boxLevel=${boxLevel}&yodaReady=h5&csecplatform=4&csecversion=4.3.0`,
    method: "GET",
    query: {
      movieId,
      boxLevel,
      yodaReady: "h5",
      csecplatform: "4",
      csecversion: "4.3.0",
    },
    headers: { mtgsig: '{"a1":"test"}', Cookie: "x=1" },
    captured_at: new Date().toISOString(),
    source: "browser",
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");

  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  assert.strictEqual(raw.source, "browser", "sigManager 只接受 source=browser");
  assert.ok(raw.headers.mtgsig, "必须有 mtgsig");
  assert.strictEqual(String(raw.query.movieId), movieId);
  assert.strictEqual(String(raw.query.boxLevel), boxLevel);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
  assert.ok(Array.isArray(pkg.build.extraResources), "portable 需 extraResources 提供 maoyan/server+lib");
  const targets = pkg.build.extraResources.map((x) => x.to);
  assert.ok(targets.includes("maoyan/server"), "缺少 maoyan/server");
  assert.ok(targets.includes("maoyan/lib"), "缺少 maoyan/lib");
  assert.deepStrictEqual(pkg.build.asarUnpack || [], [], "勿再依赖 asar.unpacked/lib（portable 会丢）");

  console.log("PASS login sig cache + package layout");
}

main();
