/**
 * Google → Bing 备用：成功不调 Bing、验证码/403 调 Bing、双失败 fallback、缓存不重搜。
 * 不访问外网。
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveMissingPosters, cachePaths } = require("../lib/poster-resolver");

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

function good(name, provider) {
  return {
    provider,
    buffer: makePng(320, 480),
    width: 320,
    height: 480,
    type: "png",
    sourceUrl: "https://cdn.example.com/official-poster.jpg",
    query: `${name} 电影 官方海报`,
    candidateCount: 2,
  };
}

function throwCode(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

async function main() {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "poster-provider-"));
  const movie = { movieId: "p1", movieName: "密档" };

  let googleCalls = 0;
  let bingCalls = 0;
  const phase = [];
  const googleOk = await resolveMissingPosters([movie], {
    cacheDir,
    searchImpl: async (name) => {
      phase.push("google-start");
      googleCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      phase.push("google-end");
      return good(name, "google");
    },
    bingSearchImpl: async () => {
      phase.push("bing");
      bingCalls += 1;
      throw new Error("bing must not run");
    },
  });
  assert.strictEqual(googleCalls, 1);
  assert.strictEqual(bingCalls, 0, "Google 成功不得调用 Bing");
  assert.deepStrictEqual(phase, ["google-start", "google-end"]);
  assert.strictEqual(googleOk[0].status, "ok");
  assert.strictEqual(googleOk[0].posterSource, "google-new");
  assert.strictEqual(googleOk[0].provider, "google");
  assert.strictEqual(googleOk[0].finalProvider, "google");
  assert.strictEqual(googleOk[0].bingResult, "not_called");

  googleCalls = 0;
  bingCalls = 0;
  const cached = await resolveMissingPosters([movie], {
    cacheDir,
    searchImpl: async () => {
      googleCalls += 1;
      throw new Error("cache hit must not search");
    },
    bingSearchImpl: async () => {
      bingCalls += 1;
      throw new Error("cache hit must not search");
    },
  });
  assert.strictEqual(googleCalls, 0, "缓存命中不得搜索");
  assert.strictEqual(bingCalls, 0);
  assert.strictEqual(cached[0].fromCache, true);
  assert.strictEqual(cached[0].cacheHit, true);
  assert.strictEqual(cached[0].posterSource, "google-cache");

  const captchaDir = fs.mkdtempSync(path.join(os.tmpdir(), "poster-captcha-"));
  googleCalls = 0;
  bingCalls = 0;
  const order = [];
  const captchaRow = await resolveMissingPosters([{ movieId: "p2", movieName: "死亡禁区实录" }], {
    cacheDir: captchaDir,
    searchImpl: async () => {
      order.push("google");
      googleCalls += 1;
      throw throwCode("CAPTCHA", "captcha");
    },
    bingSearchImpl: async (name) => {
      order.push("bing");
      assert.deepStrictEqual(order, ["google", "bing"], "必须先结束 Google 再进入 Bing");
      bingCalls += 1;
      return good(name, "bing");
    },
  });
  assert.strictEqual(googleCalls, 1);
  assert.strictEqual(bingCalls, 1, "Google captcha 必须调用 Bing");
  assert.strictEqual(captchaRow[0].status, "ok");
  assert.strictEqual(captchaRow[0].googleResult, "captcha");
  assert.strictEqual(captchaRow[0].bingResult, "success");
  assert.strictEqual(captchaRow[0].posterSource, "bing-new");
  assert.strictEqual(captchaRow[0].provider, "bing");
  assert.strictEqual(captchaRow[0].finalProvider, "bing");
  const index = JSON.parse(fs.readFileSync(cachePaths(captchaDir).indexPath, "utf8"));
  const saved = Object.values(index.entries)[0];
  assert.strictEqual(saved.provider, "bing");
  assert.ok(saved.createdAt);
  assert.ok(saved.localPath);
  assert.ok(saved.sourceUrl);
  assert.ok(Number(saved.googleFailUntil) > Date.now());

  const forbiddenDir = fs.mkdtempSync(path.join(os.tmpdir(), "poster-403-"));
  bingCalls = 0;
  const forbiddenRow = await resolveMissingPosters([{ movieId: "p3", movieName: "我想留在你身边" }], {
    cacheDir: forbiddenDir,
    searchImpl: async () => {
      throw throwCode("FORBIDDEN", "403");
    },
    bingSearchImpl: async (name) => {
      bingCalls += 1;
      return good(name, "bing");
    },
  });
  assert.strictEqual(bingCalls, 1, "Google 403 必须调用 Bing");
  assert.strictEqual(forbiddenRow[0].googleResult, "403");
  assert.strictEqual(forbiddenRow[0].provider, "bing");
  assert.strictEqual(forbiddenRow[0].posterSource, "bing-new");

  const bothDir = fs.mkdtempSync(path.join(os.tmpdir(), "poster-both-fail-"));
  googleCalls = 0;
  bingCalls = 0;
  const both = await resolveMissingPosters([{ movieId: "p4", movieName: "双失败片" }], {
    cacheDir: bothDir,
    searchImpl: async () => {
      googleCalls += 1;
      throw throwCode("CAPTCHA", "captcha");
    },
    bingSearchImpl: async () => {
      bingCalls += 1;
      return { provider: "bing", reason: "no_candidate", query: "双失败片 电影 官方海报", candidateCount: 0 };
    },
  });
  assert.strictEqual(googleCalls, 1);
  assert.strictEqual(bingCalls, 1);
  assert.notStrictEqual(both[0].status, "ok");
  assert.strictEqual(both[0].posterSource, "fallback");
  assert.strictEqual(both[0].googleResult, "captcha");
  assert.strictEqual(both[0].bingResult, "no_candidate");

  googleCalls = 0;
  bingCalls = 0;
  const cooled = await resolveMissingPosters([{ movieId: "p4", movieName: "双失败片" }], {
    cacheDir: bothDir,
    searchImpl: async () => {
      googleCalls += 1;
      return good("双失败片", "google");
    },
    bingSearchImpl: async () => {
      bingCalls += 1;
      return good("双失败片", "bing");
    },
  });
  assert.strictEqual(googleCalls, 0, "两边都失败后冷却期内不再搜索");
  assert.strictEqual(bingCalls, 0);
  assert.strictEqual(cooled[0].status, "cooldown");
  assert.strictEqual(cooled[0].posterSource, "fallback");

  console.log("PASS poster-provider-fallback");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
