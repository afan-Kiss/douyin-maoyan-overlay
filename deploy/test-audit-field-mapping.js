/**

 * 基于 audit-data/maoyan-fields 真实脱敏样本的字段映射回归

 * node deploy/test-audit-field-mapping.js

 */

const assert = require("assert");

const fs = require("fs");

const path = require("path");

const { pathToFileURL } = require("url");



const ROOT = path.join(__dirname, "..");

const AUDIT = path.join(ROOT, "audit-data", "maoyan-fields");

const BUSINESS_DATE = "2026-09-15";

const MOVIE_ID = 1500469;



function loadJson(name) {

  return JSON.parse(fs.readFileSync(path.join(AUDIT, name), "utf8"));

}



function findBoxShowRow(raw, showDate) {

  const rows = raw?.boxDatas?.[0] || [];

  return rows.find((r) => String(r.showDate) === String(showDate));

}



async function main() {

  const apiPath = pathToFileURL(path.join(ROOT, "ui", "maoyan-api.js")).href;

  const rankPath = pathToFileURL(path.join(ROOT, "ui", "dashboard-rank.js")).href;

  const {

    parseDashboard,

    parsePredictionMetrics,

    parseBoxShowMetrics,

    parseGlobalMetrics,

    mergeMovieDetail,

    refreshMovieBoxFields,

    isUntrustedBoxDecode,

    DECODE_STATUS,

  } = await import(apiPath);

  const { containsEncodedBoxMarkup, resolveDecodeStatus } = await import(rankPath);



  const dashRawDoc = loadJson("01-dashboard-raw.json");

  const boxShowRawDoc = loadJson("03-box-show-raw.json");

  const predictionRawDoc = loadJson("02-prediction-raw.json");

  const globalRawDoc = loadJson("04-global-box-raw.json");



  assert.ok(containsEncodedBoxMarkup("&#xf85e;&#xf726;&#xf85e;.&#xe8d7;&#xe8ee;"));

  assert.ok(containsEncodedBoxMarkup("&#xea12;"));

  assert.ok(isUntrustedBoxDecode("&#xf85e;&#xf726;&#xf85e;.&#xe8d7;&#xe8ee;"));



  const dashboardRaw = {

    calendar: dashRawDoc.nation?.calendar || { today: BUSINESS_DATE },

    fontStyle: dashRawDoc.nation?.fontStyle || "",

    movieList: {

      list: (dashRawDoc.movies || [])

        .map((m) => m.listItem)

        .filter(Boolean),

      nationBoxInfo: dashRawDoc.nation?.nationBoxInfo,

      updateInfo: dashRawDoc.nation?.updateInfo,

    },

    movieInfo: { boxTrends: dashRawDoc.nation?.globalBoxTrends },

  };



  if (!dashboardRaw.movieList.list.length) {

    console.log("SKIP audit dashboard listItem missing — run npm run audit:maoyan-fields after login");

    process.exit(2);

  }



  const parsed = parseDashboard(dashboardRaw, 5);

  const movie = parsed.movies.find((m) => String(m.movieId) === String(MOVIE_ID));

  assert.ok(movie, "功夫女足应在 TOP5");

  assert.notStrictEqual(movie.decodeStatus, DECODE_STATUS.OK, "Node 环境编码票房不得标记 ok");

  assert.strictEqual(movie.decodeStatus, DECODE_STATUS.ENCODED, "编码 HTML 应为 encoded 状态");

  assert.strictEqual(movie.todayBox, 0, "不可信解码不得输出 todayBox 明文");

  assert.strictEqual(parsed.nation.todayBox, 0, "全国大盘 Node 环境不得输出明文");

  assert.notStrictEqual(parsed.nation.decodeStatus, DECODE_STATUS.OK, "全国 0/0 不得算通过");



  const zeroZeroStatus = resolveDecodeStatus("", "", false, { nationBoxWan: 0, sumBoxNumWan: 0 });

  assert.notStrictEqual(zeroZeroStatus, DECODE_STATUS.OK, "0/0 不得 decode ok");



  const badRefresh = refreshMovieBoxFields(

    {

      ...movie,

      todayBoxHtml: "8572685.878",

      todayBox: 8572685.878,

      todayBoxText: "8572685.878",

      decodeStatus: DECODE_STATUS.OK,

    },

    { nationBoxWan: 120.4, sumBoxNumWan: movie.sumBoxNum, todayUnit: movie.todayUnit },

  );

  assert.strictEqual(badRefresh.decodeStatus, DECODE_STATUS.DECODE_ERROR);

  assert.strictEqual(badRefresh.todayBox, 0);



  const boxShowSample = boxShowRawDoc.samples.find((s) => s.movieId === MOVIE_ID);

  const predictionSample = predictionRawDoc.samples.find((s) => s.movieId === MOVIE_ID);

  const globalSample = globalRawDoc.samples.find((s) => s.movieId === MOVIE_ID);



  const todayRow = findBoxShowRow(boxShowSample.raw, 20260915);

  assert.ok(todayRow, "应有今日 getBoxShow 行");

  assert.notStrictEqual(todayRow.boxDesc, todayRow.splitBoxDesc, "boxDesc 与 splitBoxDesc 应不同");

  assert.strictEqual(todayRow.boxDesc, "101.60");

  assert.strictEqual(todayRow.splitBoxDesc, "101.33");



  const boxShow = parseBoxShowMetrics({ data: { data: boxShowSample.raw } }, BUSINESS_DATE);

  const prediction = parsePredictionMetrics({ data: { data: predictionSample.raw } }, BUSINESS_DATE);

  const global = parseGlobalMetrics({ data: { data: globalSample.raw } });



  assert.ok(boxShow.dailyRows.length >= 3);

  assert.strictEqual(boxShow.totalViews, null);

  assert.strictEqual(boxShow.dailyRows[0].box, "¥101.60万", "今日票房应绑定 boxDesc");

  assert.ok(!boxShow.dailyRows[0].box.includes("101.33"), "不得误用 splitBoxDesc");

  assert.ok(boxShow.dailyRows[1].box.includes("万"));

  assert.ok(boxShow.dailyRows[2].box.includes("万"));



  assert.ok(prediction.dynamicForecast.includes("万"), "动态预测应为今日 showDate 匹配值");

  assert.ok(prediction.dailyForecast[1].forecast.includes("万"));

  assert.ok(prediction.dailyForecast[2].forecast.includes("万"));



  assert.strictEqual(global.mainland, "¥3.39亿");

  assert.notStrictEqual(global.mainland, movie.sumBoxDesc);

  assert.strictEqual(global.globalTotalBox, "¥3.44亿");

  assert.ok(parseFloat(global.overseas.replace(/[^\d.]/g, "")) > 0, "海外应聚合非内地/港澳台地区");



  const globalNoMainland = parseGlobalMetrics({

    data: {

      data: {

        nationData: {

          globalBoxRankList: [

            { regionName: "北美", sumBoxInfo: "1.2亿" },

            { regionName: "欧洲", sumBoxInfo: "0.5亿" },

          ],

        },

      },

    },

  });

  assert.strictEqual(globalNoMainland.mainland, "--", "缺中国内地应显示 --");



  const merged = mergeMovieDetail(movie, { boxShow, prediction, global, tech: {} });

  assert.strictEqual(merged.mainlandBox, "¥3.39亿");

  assert.notStrictEqual(merged.mainlandBox, merged.sumBoxDesc);

  assert.ok(!merged.mainlandBox || merged.mainlandBox !== merged.sumBoxDesc);



  const table = merged.dailyTable || [];

  assert.strictEqual(table[0].box, boxShow.dailyRows[0].box);

  assert.strictEqual(table[0].forecast, prediction.dailyForecast[0].forecast);

  assert.strictEqual(table[1].box, boxShow.dailyRows[1].box);

  assert.strictEqual(table[1].forecast, prediction.dailyForecast[1].forecast);

  assert.strictEqual(table[2].box, boxShow.dailyRows[2].box);

  assert.strictEqual(table[2].forecast, prediction.dailyForecast[2].forecast);

  assert.notStrictEqual(table[1].box, table[1].forecast, "明日票房与预测不得混用同一来源");



  console.log("PASS audit field mapping fixtures");

}



main().catch((error) => {

  console.error(error);

  process.exit(1);

});


