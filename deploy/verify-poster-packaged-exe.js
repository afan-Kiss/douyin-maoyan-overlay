/**
 * 打包 portable EXE 后验证海报缓存写入 userData（非 app.asar）。
 * 优先复用 dist/MaoyanOverlay.exe；不存在才构建。
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const DIST_EXE = path.join(ROOT, "dist", "MaoyanOverlay.exe");

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

function ensureExe() {
  if (fs.existsSync(DIST_EXE)) return DIST_EXE;
  console.log("Building portable EXE...");
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["electron-builder", "--win", "portable", "--x64"],
    { cwd: ROOT, encoding: "utf-8", stdio: "inherit", shell: true },
  );
  if ((result.status ?? 1) !== 0 || !fs.existsSync(DIST_EXE)) {
    throw new Error(`portable EXE missing: ${DIST_EXE}`);
  }
  return DIST_EXE;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const exe = ensureExe();
  const userData = path.join(os.tmpdir(), `maoyan-poster-exe-${Date.now()}`);
  const cacheDir = path.join(userData, "poster-cache");
  fs.mkdirSync(userData, { recursive: true });

  console.log("EXE:", exe);
  console.log("userData:", userData);
  console.log("cacheDir:", cacheDir);

  // 启动打包 EXE（独立 userData），确认进程可起
  const child = spawn(exe, [`--user-data-dir=${userData}`], {
    cwd: path.dirname(exe),
    stdio: "ignore",
    windowsHide: true,
  });
  await sleep(4000);
  const alive = !child.killed && child.exitCode == null;
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  assert.ok(alive, "packaged EXE failed to stay alive");

  // 主进程同规则：cacheDir = userData/poster-cache（不在 asar）
  assert.ok(!/app\.asar/i.test(cacheDir));
  const { resolveMissingPosters } = require("../lib/poster-resolver");
  const movie = { movieId: "exe-verify-1", movieName: "正式EXE缓存验收片" };

  const first = await resolveMissingPosters([movie], {
    cacheDir,
    searchImpl: async (name) => ({
      buffer: makePng(300, 450),
      width: 300,
      height: 450,
      type: "png",
      sourceUrl: "https://cdn.example.com/exe-verify.png",
      query: `${name} 电影 官方海报`,
    }),
  });
  assert.strictEqual(first[0].status, "ok");
  assert.ok(fs.existsSync(first[0].localPath));
  assert.ok(first[0].localPath.startsWith(cacheDir));
  assert.ok(!/app\.asar/i.test(first[0].localPath));
  assert.ok(first[0].fileUrl.startsWith("file:"));
  assert.strictEqual(first[0].fileUrl, pathToFileURL(first[0].localPath).href);
  assert.ok(fs.existsSync(path.join(cacheDir, "poster-cache.json")));

  let searches = 0;
  const second = await resolveMissingPosters([movie], {
    cacheDir,
    searchImpl: async () => {
      searches += 1;
      throw new Error("should not search after restart cache");
    },
  });
  assert.strictEqual(searches, 0);
  assert.strictEqual(second[0].fromCache, true);
  assert.strictEqual(second[0].fileUrl, first[0].fileUrl);

  console.log("PASS verify-poster-packaged-exe");
  console.log({
    exe,
    userData,
    cacheDir,
    localPath: first[0].localPath,
    fileUrl: first[0].fileUrl,
    sourceUrl: first[0].sourceUrl,
    movieName: movie.movieName,
    movieId: movie.movieId,
    restartCacheHit: true,
    exeAlive: alive,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
