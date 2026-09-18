/**
 * 真实 Google 海报搜索 E2E（外网依赖，不进 test:core）。
 * 禁止用本地图片冒充成功；CAPTCHA/403 时明确 SKIP/FAIL。
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveMissingPosters } = require("../lib/poster-resolver");
const { searchOfficialPoster, findChrome } = require("../lib/poster-search");

const MOVIE_NAME = process.env.POSTER_E2E_MOVIE || "蒸死比尔：血色全传";
const MOVIE_ID = process.env.POSTER_E2E_ID || "e2e-kill-bill";

async function main() {
  if (!findChrome()) {
    console.log("SKIP poster-google-e2e: Chrome not found");
    process.exit(2);
  }

  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "poster-google-e2e-"));
  console.log("E2E movie:", MOVIE_NAME);
  console.log("cacheDir:", cacheDir);

  let direct;
  try {
    direct = await searchOfficialPoster(MOVIE_NAME);
  } catch (error) {
    const code = error?.code || "NETWORK";
    if (code === "CAPTCHA" || code === "FORBIDDEN") {
      console.log(`SKIP poster-google-e2e: Google blocked (${code})`);
      console.log(error.message);
      process.exit(2);
    }
    console.error("FAIL poster-google-e2e: search threw", code, error.message);
    process.exit(1);
  }

  if (!direct || !direct.buffer) {
    // 无候选但非验证码：按外网不稳定处理，禁止冒充成功
    if (direct?.reason === "no-candidate" || direct?.reason === "quality") {
      console.log(`SKIP poster-google-e2e: Google returned no acceptable poster (${direct.reason})`);
      console.log(direct);
      process.exit(2);
    }
    console.log("FAIL poster-google-e2e: no acceptable poster", direct);
    process.exit(1);
  }

  console.log("direct search:", {
    query: direct.query,
    sourceUrl: direct.sourceUrl,
    width: direct.width,
    height: direct.height,
    type: direct.type,
  });
  assert.ok(String(direct.query || "").includes(MOVIE_NAME), "query must include full movie name");

  let searchCalls = 0;
  const wrappedSearch = async (name, opts) => {
    searchCalls += 1;
    return searchOfficialPoster(name, opts);
  };

  const first = await resolveMissingPosters(
    [{ movieId: MOVIE_ID, movieName: MOVIE_NAME }],
    { cacheDir, searchImpl: wrappedSearch },
  );
  const row = first[0];
  if (!row || row.status !== "ok") {
    console.log("FAIL poster-google-e2e resolve:", row);
    process.exit(1);
  }
  assert.ok(fs.existsSync(row.localPath));
  assert.ok(row.fileUrl.startsWith("file:"));
  assert.ok(searchCalls >= 1);

  searchCalls = 0;
  const second = await resolveMissingPosters(
    [{ movieId: MOVIE_ID, movieName: MOVIE_NAME }],
    { cacheDir, searchImpl: wrappedSearch },
  );
  assert.strictEqual(searchCalls, 0, "cache hit must not re-search Google");
  assert.strictEqual(second[0].fromCache, true);
  assert.strictEqual(second[0].fileUrl, row.fileUrl);

  console.log("PASS poster-google-e2e");
  console.log({
    movieName: MOVIE_NAME,
    movieId: MOVIE_ID,
    query: direct.query,
    sourceUrl: row.sourceUrl || direct.sourceUrl,
    width: row.width,
    height: row.height,
    type: direct.type,
    localPath: row.localPath,
    fileUrl: row.fileUrl,
    cacheHit: second[0].fromCache,
  });
}

main().catch((error) => {
  const code = error?.code || "";
  if (code === "CAPTCHA" || code === "FORBIDDEN") {
    console.log(`SKIP poster-google-e2e: ${code}`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
