/**
 * 三日票房表解析回归：node deploy/test-daily-table-parse.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const CACHE_DIR = path.join(
  process.env.LOCALAPPDATA || "",
  "MaoyanOverlay",
  "maoyan-data",
  "session_cache",
);

async function fetchCached(fileName) {
  const cache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, fileName), "utf8"));
  const resp = await fetch(cache.url, { headers: cache.headers });
  assert.strictEqual(resp.status, 200, `${fileName} status=${resp.status}`);
  return resp.json();
}

async function main() {
  const apiPath = pathToFileURL(path.join(ROOT, "ui", "maoyan-api.js")).href;
  const { mergeMovieDetail, parsePredictionMetrics, parseBoxShowMetrics } = await import(apiPath);

  if (!fs.existsSync(path.join(CACHE_DIR, "wukong_1462628_getPredictionBox.json"))) {
    console.log("SKIP: no cached prediction payload");
    process.exit(0);
  }

  const [predictionRaw, boxShowRaw] = await Promise.all([
    fetchCached("wukong_1462628_getPredictionBox.json"),
    fetchCached("1462628_1.json"),
  ]);

  const base = {
    movieId: 1462628,
    rank: 1,
    name: "欢迎来龙餐馆",
    todayBox: 1370.62,
    todayBoxText: "1370.62",
    todayUnit: "万",
    boxRate: "26.3%",
    showCountRate: "26.0%",
    avgSeatView: "2.6%",
  };

  const todayStr = "2026-09-13";
  const prediction = parsePredictionMetrics(predictionRaw, todayStr);
  const boxShow = parseBoxShowMetrics(boxShowRaw, todayStr);

  assert.ok(prediction?.dailyForecast?.length >= 3, "prediction dailyForecast");
  assert.ok(boxShow?.dailyRows?.length >= 3, "boxShow dailyRows");
  assert.notStrictEqual(prediction.dailyForecast[1].forecast, "--", "明日预测");
  assert.notStrictEqual(prediction.dailyForecast[2].forecast, "--", "后天预测");
  assert.notStrictEqual(boxShow.dailyRows[1].box, "--", "明日票房");

  const merged = mergeMovieDetail(base, { prediction, boxShow });
  assert.notStrictEqual(merged.dailyTable[1].forecast, "--", "merged 明日预测");
  assert.notStrictEqual(merged.dailyTable[2].forecast, "--", "merged 后天预测");
  assert.strictEqual(merged.dailyTable[0].box, "1370.62万");

  console.log("PASS daily table parse");
  console.log(
    "  rows:",
    merged.dailyTable.map((row) => `${row.label}: box=${row.box} forecast=${row.forecast}`).join(" | "),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
