/**
 * 下映日期解析与展示回归
 * node deploy/test-end-date.js
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

async function main() {
  const api = await import(pathToFileURL(path.join(__dirname, "..", "ui", "maoyan-api.js")).href);
  const { parseTechMetrics, mergeMovieDetail, getExtraMetrics } = api;

  const ymd = parseTechMetrics({ success: true, data: { endDate: 20261012 } });
  assert.strictEqual(ymd.endDate, "2026-10-12", "数字 YYYYMMDD 应格式化");
  assert.ok(ymd.remainingDays !== "--", "应由日期推算剩余天数");

  const ymdStr = parseTechMetrics({ data: { endDate: "20261110", remainingDays: 58 } });
  assert.strictEqual(ymdStr.endDate, "2026-11-10");
  assert.strictEqual(ymdStr.remainingDays, "58", "API remainingDays 优先");

  const iso = parseTechMetrics({ data: { endDate: "2026-12-01T00:00:00" } });
  assert.strictEqual(iso.endDate, "2026-12-01");

  const daysOnly = parseTechMetrics({ data: { remainingDays: 7, endDateDesc: "12-20" } });
  assert.strictEqual(daysOnly.endDate, "12-20");
  assert.strictEqual(daysOnly.remainingDays, "7");

  const merged = mergeMovieDetail(
    { movieId: 1, endDate: "2026-09-01", remainingDays: "1" },
    { tech: parseTechMetrics({ data: { endDate: "2026-11-10", remainingDays: "58" } }) },
  );
  assert.strictEqual(merged.endDate, "2026-11-10");
  assert.strictEqual(merged.remainingDays, "58");

  const preserved = mergeMovieDetail(
    { movieId: 1, endDate: "2026-09-01", remainingDays: "1" },
    { tech: {} },
  );
  assert.strictEqual(preserved.endDate, "2026-09-01", "tech 空时保留旧下映日期");
  assert.strictEqual(preserved.remainingDays, "1");

  const extras = getExtraMetrics(
    {
      rank: 2,
      dynamicForecast: "--",
      showCountDesc: "--",
      sumBoxDesc: "--",
      yesterdayTotal: "--",
      avgShowView: "--",
      yesterdaySamePeriodText: "--",
      totalViews: "--",
      totalForecast: "--",
      endDate: "2026-11-10",
      remainingDays: "58",
    },
    { maxCount: 4 },
  );
  const endItem = extras.find((x) => x.key === "endDate");
  assert.ok(endItem, "补充指标应含下映日期");
  assert.ok(!extras.some((x) => x.key === "remainingDays"), "有下映日期时不重复占剩余天数");
  assert.ok(String(endItem.value).includes("剩58天"), `展示应含剩余天数: ${endItem.value}`);
  assert.ok(String(endItem.value).includes("11-10"), `展示应含月日: ${endItem.value}`);

  console.log("test-end-date: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
