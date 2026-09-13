/**
 * extra metrics helper 回归
 * node deploy/test-extra-metrics.js
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");

function richMovie(rank, extra = {}) {
  return {
    rank,
    movieId: 1000 + rank,
    name: `电影${rank}`,
    todayBox: 800 + rank * 20,
    boxRate: "25.4%",
    showCountRate: "26.0%",
    avgSeatView: "2.1%",
    sumBoxDesc: "21.58亿",
    dynamicForecast: "1643.35万",
    hourSpeedText: "18.6万/h",
    showCountDesc: "8.7万场",
    avgShowView: "3.1",
    yesterdayTotal: "923.5万",
    yesterdaySamePeriodText: "900.2万",
    totalViews: "3200.5万",
    mainlandBox: "21.58亿",
    totalForecast: "1643.35万",
    releaseInfo: "上映12天",
    ...extra,
  };
}

async function main() {
  const apiPath = pathToFileURL(path.join(ROOT, "ui", "maoyan-api.js")).href;
  const {
    getExtraMetrics,
    getExtraMetricsGridClass,
    buildDailyTrendItems,
    formatReleaseTag,
  } = await import(apiPath);

  const top1All = getExtraMetrics(richMovie(1));
  assert.ok(top1All.length >= 5, `TOP1 应至少 5 个补充指标，实际 ${top1All.length}`);
  assert.ok(top1All.length <= 6, `TOP1 最多 6 个补充指标，实际 ${top1All.length}`);
  assert.strictEqual(getExtraMetricsGridClass(3), "race-card__extra-grid--3");
  assert.strictEqual(getExtraMetricsGridClass(2), "race-card__extra-grid--2");
  assert.strictEqual(getExtraMetricsGridClass(1), "race-card__extra-grid--1");

  const threeOnly = getExtraMetrics(
    richMovie(2, {
      dynamicForecast: "100万",
      hourSpeedText: "10万/h",
      showCountDesc: "1.2万场",
      sumBoxDesc: "--",
      yesterdayTotal: "--",
      yesterdaySamePeriodText: "--",
      avgShowView: "--",
      totalViews: "--",
      mainlandBox: "--",
      totalForecast: "--",
    }),
  );
  assert.strictEqual(threeOnly.length, 3, `三列场景应保留 3 项，实际 ${threeOnly.length}`);
  assert.strictEqual(getExtraMetricsGridClass(threeOnly.length), "race-card__extra-grid--3");

  const twoOnly = getExtraMetrics(
    richMovie(3, {
      dynamicForecast: "100万",
      hourSpeedText: "--",
      showCountDesc: "--",
      yesterdayTotal: "--",
      yesterdaySamePeriodText: "--",
      avgShowView: "--",
      totalViews: "--",
      sumBoxDesc: "8.2亿",
      mainlandBox: "--",
      totalForecast: "--",
    }),
  );
  assert.strictEqual(twoOnly.length, 2, `两列场景应保留 2 项，实际 ${twoOnly.length}`);
  assert.strictEqual(getExtraMetricsGridClass(twoOnly.length), "race-card__extra-grid--2");

  const sumOnly = getExtraMetrics(
    richMovie(4, {
      dynamicForecast: "--",
      hourSpeedText: "--",
      showCountDesc: "--",
      yesterdayTotal: "--",
      avgShowView: "--",
      totalViews: "--",
      yesterdaySamePeriodText: "--",
      sumSplitBoxDesc: "--",
      splitBoxRate: "--",
      mainlandBox: "--",
      totalForecast: "--",
      endDate: "--",
      remainingDays: "--",
      showCount: 0,
      sumBoxDesc: "5.1亿",
    }),
  );
  assert.strictEqual(sumOnly.length, 1, "只有累计票房时应返回 1 项");
  assert.strictEqual(sumOnly[0].key, "sumBoxDesc");
  assert.strictEqual(getExtraMetricsGridClass(sumOnly.length), "race-card__extra-grid--1");

  const sparse = getExtraMetrics(
    richMovie(5, {
      showCount: 0,
      dynamicForecast: "--",
      hourSpeedText: "--",
      showCountDesc: "--",
      sumBoxDesc: "--",
      yesterdayTotal: "--",
      yesterdaySamePeriodText: "--",
      avgShowView: "--",
      totalViews: "--",
      mainlandBox: "--",
      totalForecast: "--",
      sumSplitBoxDesc: "--",
      splitBoxRate: "--",
      yesterdayHourSpeedText: "--",
      endDate: "--",
      remainingDays: "--",
      hmtBox: "--",
      overseasBox: "--",
    }),
  );
  assert.strictEqual(sparse.length, 0, "detail 缺失时不应造假补充指标");

  const dedup = getExtraMetrics(richMovie(1, { mainlandBox: "21.58亿", sumBoxDesc: "21.58亿" }));
  const keys = dedup.map((item) => item.key);
  assert.ok(keys.includes("sumBoxDesc"), "累计票房应保留");
  assert.ok(!keys.includes("mainlandBox"), "与累计票房重复时不显示内地票房");

  const forecastDedup = getExtraMetrics(
    richMovie(1, { dynamicForecast: "1643.35万", totalForecast: "1643.35万" }),
  );
  assert.ok(
    forecastDedup.filter((item) => item.key === "dynamicForecast" || item.key === "totalForecast").length === 1,
    "动态预测与总预测重复时只保留一个",
  );

  const movieA = getExtraMetrics(richMovie(1, { movieId: 9001, name: "A", yesterdayTotal: "111.1万" }));
  const movieB = getExtraMetrics(richMovie(2, { movieId: 9002, name: "B", yesterdayTotal: "222.2万" }));
  assert.notStrictEqual(movieA.find((x) => x.key === "yesterdayTotal")?.value, movieB.find((x) => x.key === "yesterdayTotal")?.value);

  const trend = buildDailyTrendItems({
    rank: 1,
    dailyTable: [
      { label: "今日", forecast: "1643万" },
      { label: "明日", forecast: "892万" },
      { label: "后天", forecast: "610万" },
    ],
  });
  assert.strictEqual(trend.length, 3, "TOP1 dailyTable 趋势应可用");

  assert.strictEqual(formatReleaseTag("上映12天"), "上映12天");
  assert.strictEqual(formatReleaseTag("上映第15天"), "上映15天");
  assert.strictEqual(formatReleaseTag(""), "");

  console.log("PASS extra metrics");
  console.log("  TOP1 rich metrics:", top1All.map((item) => item.label).join(" | "));
  console.log("\nALL PASSED (extra metrics)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
