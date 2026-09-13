/**
 * 字段保真：快速轮询不得冲掉 enrich 明细
 * node deploy/test-field-preserve.js
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");

async function main() {
  const apiPath = pathToFileURL(path.join(ROOT, "ui", "maoyan-api.js")).href;
  const { mergeMovieDetail, enrichMoviesQuick } = await import(apiPath);

  const enriched = mergeMovieDetail(
    { movieId: 1, todayBox: 900, name: "测" },
    {
      boxShow: {
        hourSpeed: 88.5,
        hourSpeedText: "88.50万/h",
        yesterdaySamePeriodText: "¥820.00万",
        totalViews: "3200.5万",
      },
      prediction: {
        dynamicForecast: "1643.35万",
        totalForecast: "¥22.1亿",
        dailyForecast: [{ label: "今日", forecast: "1643.35万", box: "900万" }],
      },
      global: { mainland: "¥21.58亿", hmt: "¥1280.5万" },
      trends: { yesterdayDesc: "923.5万", yesterdayBox: 923.5 },
    },
  );

  assert.strictEqual(enriched.hourSpeedText, "88.50万/h");
  assert.strictEqual(enriched.dynamicForecast, "1643.35万");
  assert.strictEqual(enriched.totalForecast, "¥22.1亿");
  assert.strictEqual(enriched.yesterdayTotal, "923.5万");
  assert.strictEqual(enriched.yesterdaySamePeriodText, "¥820.00万");
  assert.strictEqual(enriched.totalViews, "3200.5万");
  assert.strictEqual(enriched.mainlandBox, "¥21.58亿");
  assert.ok(Array.isArray(enriched.dailyTable) && enriched.dailyTable.length >= 1);

  const quick = enrichMoviesQuick([enriched], {})[0];
  assert.strictEqual(quick.hourSpeedText, "88.50万/h", "时速");
  assert.strictEqual(quick.dynamicForecast, "1643.35万", "动态预测");
  assert.strictEqual(quick.totalForecast, "¥22.1亿", "总预测");
  assert.strictEqual(quick.yesterdayTotal, "923.5万", "昨日票房");
  assert.strictEqual(quick.yesterdaySamePeriodText, "¥820.00万", "昨日同期");
  assert.strictEqual(quick.totalViews, "3200.5万", "累计观影人次");
  assert.strictEqual(quick.mainlandBox, "¥21.58亿", "中国内地");
  assert.ok(Array.isArray(quick.dailyTable) && quick.dailyTable.length >= 1, "三日表");

  console.log("PASS field preserve");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
