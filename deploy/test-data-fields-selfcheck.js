/**
 * 时速/字段自检：node deploy/test-data-fields-selfcheck.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const SAMPLE = path.join("e:", "我的源码目录", "猫眼票房助手", "boxshow_result.json");

async function main() {
  const apiPath = pathToFileURL(path.join(ROOT, "ui", "maoyan-api.js")).href;
  const {
    parseBoxShowMetrics,
    mergeMovieDetail,
    estimateSpeedMetrics,
    enrichMoviesQuick,
    parseBoxNum,
  } = await import(apiPath);

  // 1) 短窗口估算不得冒充时速
  const est = estimateSpeedMetrics(1, 100, { box: 99, forecast: 0 }, 5000);
  assert.strictEqual(est.estimatedHourSpeed, 0, "estimate must not invent hour speed");
  const quick = mergeMovieDetail({ movieId: 1, todayBox: 100 }, { boxShow: {}, speed: est });
  assert.ok(!(quick.hourSpeed > 0), `quick enrich must not set hourSpeed, got ${quick.hourSpeed}`);
  assert.ok(isEmptyish(quick.hourSpeedText), `hourSpeedText should be empty/-- got ${quick.hourSpeedText}`);
  assert.strictEqual(Boolean(quick.hourSpeedFromApi), false);

  const quickList = enrichMoviesQuick([{ movieId: 1, todayBox: 100, name: "测" }], {
    1: est,
  });
  assert.ok(!(quickList[0].hourSpeed > 0), "enrichMoviesQuick must not fill fake hourSpeed");

  const withApiHourSpeed = mergeMovieDetail(
    { movieId: 1, todayBox: 100, name: "测" },
    { boxShow: { hourSpeed: 88.5, hourSpeedText: "88.50万/h" } },
  );
  assert.strictEqual(withApiHourSpeed.hourSpeedFromApi, true);
  const quickAgain = enrichMoviesQuick([withApiHourSpeed], { 1: est })[0];
  assert.strictEqual(quickAgain.hourSpeedText, "88.50万/h", "quick enrich must not wipe API hourSpeedText");
  assert.strictEqual(quickAgain.hourSpeedFromApi, true);
  assert.ok(Math.abs(quickAgain.hourSpeed - 88.5) < 0.01);

  // 2) 有样本时核对 getBoxShow 时速量级（应接近「本小时票房」，不是上亿夸张值）
  if (fs.existsSync(SAMPLE)) {
    const raw = JSON.parse(fs.readFileSync(SAMPLE, "utf8"));
    const box = parseBoxShowMetrics(raw, "2026-09-13");
    assert.ok(box?.hourSpeed > 0, "sample hourSpeed");
    assert.ok(box.hourSpeed < 5000, `sample hourSpeed too large: ${box.hourSpeed}万/h`);
    assert.ok(String(box.hourSpeedText).includes("/h"), box.hourSpeedText);

    const merged = mergeMovieDetail(
      { movieId: 1, todayBox: 100, sumBoxDesc: "1.00亿" },
      { boxShow: box, speed: est, global: { mainland: "¥1.23亿" } },
    );
    assert.ok(Math.abs(merged.hourSpeed - box.hourSpeed) < 0.01);
    assert.strictEqual(merged.hourSpeedFromApi, true);
    assert.ok(String(merged.mainlandBox).includes("亿") || String(merged.mainlandBox).includes("万"));

    // yValue 元 → 万
    const yOnly = structuredClone(raw);
    delete yOnly.data.data.timeFilterChartData;
    for (const s of yOnly.data.data.timeChartData.series) {
      for (const p of s.data || []) delete p.tooltip;
    }
    const yBox = parseBoxShowMetrics(yOnly, "2026-09-13");
    assert.ok(yBox?.hourSpeed > 0 && yBox.hourSpeed < 5000, `yValue hourSpeed=${yBox?.hourSpeed}`);
    console.log(`  sample hourSpeed=${box.hourSpeedText} yOnly=${yBox.hourSpeedText}`);
  } else {
    console.log("  (no boxshow sample, skipped live parse)");
  }

  // 3) 单位基础
  assert.strictEqual(parseBoxNum("186.1", "万"), 186.1);
  assert.strictEqual(parseBoxNum("1.23亿"), 12300);

  console.log("PASS data fields selfcheck");
}

function isEmptyish(val) {
  if (val == null) return true;
  const t = String(val).trim();
  return !t || t === "--" || t === "-";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
