/**
 * PosterResolver 单元测试：缓存 / 质量过滤 / 限流 / 冷却 / 不阻塞。
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  resolveMissingPosters,
  isAcceptablePoster,
  readImageSize,
  FAIL_COOLDOWN_MS,
} = require("../lib/poster-resolver");

function makePng(width, height) {
  // Minimal invalid-but-sized PNG header for readImageSize
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
  assert.strictEqual(isAcceptablePoster({ width: 300, height: 450, type: "jpeg" }), true);
  assert.strictEqual(isAcceptablePoster({ width: 200, height: 450, type: "jpeg" }), false);
  assert.strictEqual(isAcceptablePoster({ width: 400, height: 400, type: "jpeg" }), false);
  assert.strictEqual(isAcceptablePoster({ gif: true, width: 300, height: 450 }), false);
  assert.deepStrictEqual(readImageSize(makePng(320, 480)), { width: 320, height: 480, type: "png" });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "poster-resolver-"));
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
  };

  const first = await resolveMissingPosters(movies, {
    root,
    searchImpl: async () => {
      searchCalls += 1;
      return good;
    },
  });
  assert.strictEqual(searchCalls, 2, "应搜索两部缺海报电影");
  assert.strictEqual(first.filter((r) => r.status === "ok").length, 2);
  assert.ok(fs.existsSync(first[0].localPath));

  searchCalls = 0;
  const second = await resolveMissingPosters(movies, {
    root,
    searchImpl: async () => {
      searchCalls += 1;
      return good;
    },
  });
  assert.strictEqual(searchCalls, 0, "命中缓存后不得再搜");
  assert.ok(second.every((r) => r.fromCache && r.status === "ok"));

  const failRoot = fs.mkdtempSync(path.join(os.tmpdir(), "poster-fail-"));
  let failCalls = 0;
  const failed = await resolveMissingPosters([{ movieId: "9", movieName: "验证码片" }], {
    root: failRoot,
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
    root: failRoot,
    searchImpl: async () => {
      failCalls += 1;
      return good;
    },
  });
  assert.strictEqual(cooled[0].status, "cooldown");
  assert.strictEqual(failCalls, 0, "失败冷却期内不重试");
  assert.ok(FAIL_COOLDOWN_MS >= 30 * 60 * 1000);

  console.log("PASS poster-resolver");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
