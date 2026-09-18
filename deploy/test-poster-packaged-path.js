/**
 * 打包后可写缓存路径验收（不依赖 Google）。
 * 验证 cacheDir 不在 app.asar、可写、fileUrl 可用、重启命中缓存。
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  resolveMissingPosters,
  requireCacheDir,
  toFileUrl,
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
  const fakeAsarLib = path.join(os.tmpdir(), "fake-pack", "resources", "app.asar", "lib");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "fake-pack-userdata-"));
  const cacheDir = path.join(userData, "poster-cache");

  assert.throws(() => requireCacheDir({ cacheDir: path.join(fakeAsarLib, "..", "data", "poster-cache") }), /app\.asar|cacheDir/);
  // Force an asar path rejection
  assert.throws(
    () => requireCacheDir({ cacheDir: path.join(os.tmpdir(), "app.asar", "poster-cache") }),
    /app\.asar/,
  );

  const resolved = requireCacheDir({ cacheDir });
  assert.ok(!/app\.asar/i.test(resolved));
  fs.mkdirSync(resolved, { recursive: true });
  assert.ok(fs.existsSync(resolved));

  let searchCalls = 0;
  const movie = { movieId: "9001", movieName: "打包路径测试片" };
  const first = await resolveMissingPosters([movie], {
    cacheDir: resolved,
    searchImpl: async (name) => {
      searchCalls += 1;
      return {
        buffer: makePng(300, 450),
        width: 300,
        height: 450,
        type: "png",
        sourceUrl: "https://cdn.example.com/official-poster.png",
        query: `${name} 电影 官方海报`,
      };
    },
  });

  assert.strictEqual(searchCalls, 1);
  assert.strictEqual(first[0].status, "ok");
  assert.ok(fs.existsSync(first[0].localPath));
  assert.ok(first[0].localPath.startsWith(resolved));
  assert.ok(first[0].fileUrl.startsWith("file:"));
  assert.strictEqual(first[0].fileUrl, toFileUrl(first[0].localPath));
  assert.ok(fs.existsSync(path.join(resolved, "poster-cache.json")));

  // 模拟 Renderer 拿到 fileUrl
  const rendererSrc = first[0].fileUrl;
  assert.match(rendererSrc, /^file:/i);
  assert.ok(!rendererSrc.includes("app.asar"));

  searchCalls = 0;
  const second = await resolveMissingPosters([movie], {
    cacheDir: resolved,
    searchImpl: async () => {
      searchCalls += 1;
      throw new Error("should not search");
    },
  });
  assert.strictEqual(searchCalls, 0, "重启后应命中缓存");
  assert.strictEqual(second[0].fromCache, true);
  assert.strictEqual(second[0].fileUrl, rendererSrc);

  console.log("PASS poster-packaged-path");
  console.log({
    cacheDir: resolved,
    localPath: first[0].localPath,
    fileUrl: first[0].fileUrl,
    index: path.join(resolved, "poster-cache.json"),
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
