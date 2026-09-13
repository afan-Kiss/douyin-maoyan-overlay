/**
 * 时速解析回归：node deploy/test-hour-speed-parse.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const SAMPLE = path.join("e:", "我的源码目录", "猫眼票房助手", "boxshow_result.json");

async function main() {
  const apiPath = pathToFileURL(path.join(ROOT, "ui", "maoyan-api.js")).href;
  const { parseBoxShowMetrics, mergeMovieDetail } = await import(apiPath);

  if (!fs.existsSync(SAMPLE)) {
    console.log("SKIP: no sample boxshow_result.json");
    process.exit(0);
  }

  const raw = JSON.parse(fs.readFileSync(SAMPLE, "utf8"));
  const box = parseBoxShowMetrics(raw, "2026-09-13");
  assert.ok(box, "parseBoxShowMetrics");
  assert.ok(box.hourSpeed > 0, `hourSpeed>0 got ${box.hourSpeed}`);
  assert.ok(String(box.hourSpeedText).includes("/h"), box.hourSpeedText);
  assert.notStrictEqual(box.hourSpeedText, "--");

  const onlyFilter = structuredClone(raw);
  delete onlyFilter.data.data.timeChartData;
  const filterBox = parseBoxShowMetrics(onlyFilter, "2026-09-13");
  assert.ok(filterBox?.hourSpeed > 0, "filter-only hourSpeed");

  const onlyCum = structuredClone(raw);
  delete onlyCum.data.data.timeFilterChartData;
  const cumBox = parseBoxShowMetrics(onlyCum, "2026-09-13");
  assert.ok(cumBox?.hourSpeed > 0, "cumulative-only hourSpeed");

  const yOnly = structuredClone(raw);
  delete yOnly.data.data.timeFilterChartData;
  for (const s of yOnly.data.data.timeChartData.series) {
    for (const p of s.data || []) delete p.tooltip;
  }
  const yBox = parseBoxShowMetrics(yOnly, "2026-09-13");
  assert.ok(yBox?.hourSpeed > 0, "yValue-only hourSpeed");

  const estimated = mergeMovieDetail(
    { movieId: 1, todayBox: 100 },
    { boxShow: {}, speed: { estimatedHourSpeed: 12.5 } },
  );
  assert.ok(!(estimated.hourSpeed > 0), "estimate must not become hourSpeed");
  assert.ok(!String(estimated.hourSpeedText || "").includes("12.50"), estimated.hourSpeedText);

  const apiWins = mergeMovieDetail(
    { movieId: 1, todayBox: 100 },
    { boxShow: box, speed: { estimatedHourSpeed: 9999 } },
  );
  assert.ok(Math.abs(apiWins.hourSpeed - box.hourSpeed) < 0.01);
  assert.strictEqual(apiWins.hourSpeedFromApi, true);

  console.log("PASS hour speed parse");
  console.log(`  sample=${box.hourSpeedText} filter=${filterBox.hourSpeedText} cum=${cumBox.hourSpeedText}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
