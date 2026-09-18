/**
 * PosterResolver 单元测试（mock searchImpl）：缓存 / 质量 / 冷却 / 串行。
 * 不访问 Google；真实外网见 test:poster-google-e2e。
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  resolveMissingPosters,
  clearPosterFailureCooldown,
  isAcceptablePoster,
  isBannedCandidateUrl,
  readImageSize,
  FAIL_COOLDOWN_MS,
  requireCacheDir,
} = require("../lib/poster-resolver");

function makePng(width, height) {
  const buf = Buffer.alloc(24);
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

async function main() {
  assert.throws(() => requireCacheDir({}), /cacheDir/);
  assert.throws(
    () => requireCacheDir({ cacheDir: path.join("C:\\Users\\x\\AppData\\Local\\Programs\\app.asar", "poster-cache") }),
    /app\.asar/,
  );

  assert.strictEqual(isAcceptablePoster({ width: 300, height: 450, type: "jpeg" }), true);
  assert.strictEqual(isAcceptablePoster({ width: 200, height: 450, type: "jpeg" }), false);
  assert.strictEqual(isAcceptablePoster({ width: 400, height: 400, type: "jpeg" }), false);
  assert.strictEqual(isAcceptablePoster({ gif: true, width: 300, height: 450 }), false);
  assert.strictEqual(isBannedCandidateUrl("https://cdn.example.com/logo.png"), true);
  assert.strictEqual(isBannedCandidateUrl("https://cdn.example.com/poster.jpg"), false);
  assert.deepStrictEqual(readImageSize(makePng(320, 480)), { width: 320, height: 480, type: "png" });

  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "poster-resolver-"));
  const movies = [
    { movieId: "101", movieName: "缺海报电影A" },
    { movieId: "102", movieName: "缺海报电影B" },
  ];

  let searchCalls = 0;
  const good = {
    buffer: makePng(320, 480),
    width: 320,
    height: 480,
    type: "png",
    sourceUrl: "https://example.com/a.png",
    query: "缺海报电影A 电影 官方海报",
  };

  const first = await resolveMissingPosters(movies, {
    cacheDir,
    searchImpl: async (name) => {
      searchCalls += 1;
      return { ...good, query: `${name} 电影 官方海报` };
    },
  });
  assert.strictEqual(searchCalls, 2, "应搜索两部缺海报电影");
  assert.strictEqual(first.filter((r) => r.status === "ok").length, 2);
  assert.ok(first[0].fileUrl.startsWith("file:"));
  assert.ok(fs.existsSync(first[0].localPath));
  assert.ok(!/app\.asar/i.test(first[0].localPath));

  searchCalls = 0;
  const second = await resolveMissingPosters(movies, {
    cacheDir,
    searchImpl: async () => {
      searchCalls += 1;
      return good;
    },
  });
  assert.strictEqual(searchCalls, 0, "命中缓存后不得再搜");
  assert.ok(second.every((r) => r.fromCache && r.status === "ok" && r.fileUrl.startsWith("file:")));

  const failDir = fs.mkdtempSync(path.join(os.tmpdir(), "poster-fail-"));
  let failCalls = 0;
  const failed = await resolveMissingPosters([{ movieId: "9", movieName: "验证码片" }], {
    cacheDir: failDir,
    searchImpl: async () => {
      failCalls += 1;
      const err = new Error("captcha");
      err.code = "CAPTCHA";
      throw err;
    },
  });
  assert.strictEqual(failed[0].status, "fail");
  assert.strictEqual(failCalls, 1);

  failCalls = 0;
  const cooled = await resolveMissingPosters([{ movieId: "9", movieName: "验证码片" }], {
    cacheDir: failDir,
    searchImpl: async () => {
      failCalls += 1;
      return good;
    },
  });
  assert.strictEqual(cooled[0].status, "cooldown");
  assert.strictEqual(failCalls, 0, "失败冷却期内不重试");
  assert.ok(FAIL_COOLDOWN_MS >= 30 * 60 * 1000);

  const cleared = clearPosterFailureCooldown("9", { cacheDir: failDir });
  assert.ok(cleared.cleared >= 1, "应清除 fail 冷却");
  failCalls = 0;
  const afterClear = await resolveMissingPosters([{ movieId: "9", movieName: "验证码片" }], {
    cacheDir: failDir,
    searchImpl: async (name) => {
      failCalls += 1;
      return { ...good, query: `${name} 电影 官方海报` };
    },
  });
  assert.strictEqual(failCalls, 1, "清除 fail 冷却后应重新搜索");
  assert.strictEqual(afterClear[0].status, "ok");
  assert.strictEqual(afterClear[0].posterSource, "google-new");

  // 成功缓存不能被 clearPosterFailureCooldown 删掉
  const clearedOk = clearPosterFailureCooldown("9", { cacheDir: failDir });
  assert.strictEqual(clearedOk.cleared, 0);
  const stillCached = await resolveMissingPosters([{ movieId: "9", movieName: "验证码片" }], {
    cacheDir: failDir,
    searchImpl: async () => {
      throw new Error("should not search");
    },
  });
  assert.strictEqual(stillCached[0].fromCache, true);

  // chrome_missing：Chrome 可用时应绕过冷却
  const chromeDir = fs.mkdtempSync(path.join(os.tmpdir(), "poster-chrome-miss-"));
  await resolveMissingPosters([{ movieId: "77", movieName: "缺Chrome片" }], {
    cacheDir: chromeDir,
    searchImpl: async () => {
      const err = new Error("chrome missing");
      err.code = "CHROME_MISSING";
      throw err;
    },
  });
  let chromeRetry = 0;
  const bypassed = await resolveMissingPosters([{ movieId: "77", movieName: "缺Chrome片" }], {
    cacheDir: chromeDir,
    searchImpl: async (name) => {
      chromeRetry += 1;
      return { ...good, query: `${name} 电影 官方海报` };
    },
  });
  // 本机若无 Chrome，仍会 cooldown；有 Chrome 则应立即重试
  const { findChrome } = require("../lib/poster-search");
  if (findChrome()) {
    assert.strictEqual(chromeRetry, 1, "chrome_missing + Chrome已找到 → 立即重试");
    assert.strictEqual(bypassed[0].status, "ok");
  } else {
    assert.strictEqual(bypassed[0].status, "cooldown");
  }

  // posterRetry 只清 fail
  const retryDir = fs.mkdtempSync(path.join(os.tmpdir(), "poster-retry-"));
  await resolveMissingPosters([{ movieId: "88", movieName: "冷却片" }], {
    cacheDir: retryDir,
    searchImpl: async () => {
      const err = new Error("net");
      err.code = "NETWORK";
      throw err;
    },
  });
  let retryCalls = 0;
  const retried = await resolveMissingPosters([{ movieId: "88", movieName: "冷却片" }], {
    cacheDir: retryDir,
    posterRetry: true,
    searchImpl: async (name) => {
      retryCalls += 1;
      return { ...good, query: `${name} 电影 官方海报` };
    },
  });
  assert.strictEqual(retryCalls, 1);
  assert.strictEqual(retried[0].status, "ok");

  console.log("PASS poster-resolver (unit/mock only)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
