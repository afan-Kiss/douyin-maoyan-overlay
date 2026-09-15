/**
 * refreshMovieBoxFields / refreshNationBoxFields 二次解码校验回归
 * node deploy/test-decode-refresh.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");

async function main() {
  const apiPath = pathToFileURL(path.join(ROOT, "ui", "maoyan-api.js")).href;
  const rankPath = pathToFileURL(path.join(ROOT, "ui", "dashboard-rank.js")).href;
  const {
    refreshMovieBoxFields,
    refreshNationBoxFields,
    DECODE_STATUS,
    resolveMaoyanSumBoxWan,
  } = await import(apiPath);
  const { resolveDecodeStatus } = await import(rankPath);

  const baseMovie = {
    movieId: 1,
    todayUnit: "万",
    sumBoxNum: 233700,
    todayBoxHtml: "",
    decodeStatus: DECODE_STATUS.FAILED,
    todayBox: 0,
    todayBoxText: "--",
  };

  // 0/0 不得算通过
  const zeroZero = refreshMovieBoxFields(
    { ...baseMovie, todayBoxHtml: "0", decodeStatus: DECODE_STATUS.FAILED },
    { nationBoxWan: 0, sumBoxNumWan: 233700 },
  );
  assert.notStrictEqual(zeroZero.decodeStatus, DECODE_STATUS.OK);
  assert.strictEqual(zeroZero.todayBox, 0);

  // encoded 状态（Node 无字体）
  const encoded = refreshMovieBoxFields(
    {
      ...baseMovie,
      todayBoxHtml: "&#xe8ee;&#xea12;&#xebcd;.&#xf123;&#xf8ff;",
      decodeStatus: DECODE_STATUS.ENCODED,
    },
    { nationBoxWan: 1200, sumBoxNumWan: 233700 },
  );
  assert.strictEqual(encoded.decodeStatus, DECODE_STATUS.ENCODED);
  assert.strictEqual(encoded.todayBox, 0);
  assert.ok(encoded.todayBoxHtml.includes("&#x"));

  // failed 明文
  const failed = refreshMovieBoxFields(
    { ...baseMovie, todayBoxHtml: "--", decodeStatus: DECODE_STATUS.FAILED },
    { nationBoxWan: 1200, sumBoxNumWan: 233700 },
  );
  assert.strictEqual(failed.decodeStatus, DECODE_STATUS.FAILED);
  assert.strictEqual(failed.todayBox, 0);

  // 模拟错误解码 8572685.878 — 二次刷新必须拒绝，不得写回
  const badHtml = "8572685.878";
  const badStatus = resolveDecodeStatus(badHtml, badHtml, false, {
    todayUnit: "万",
    nationBoxWan: 120.4,
    sumBoxNumWan: 233700,
  });
  assert.strictEqual(badStatus, DECODE_STATUS.DECODE_ERROR);

  const badRefresh = refreshMovieBoxFields(
    {
      ...baseMovie,
      todayBoxHtml: badHtml,
      todayBox: 8572685.878,
      todayBoxText: badHtml,
      decodeStatus: DECODE_STATUS.OK,
    },
    { nationBoxWan: 120.4, sumBoxNumWan: 233700, todayUnit: "万" },
  );
  assert.strictEqual(badRefresh.decodeStatus, DECODE_STATUS.DECODE_ERROR);
  assert.strictEqual(badRefresh.todayBox, 0);
  assert.strictEqual(badRefresh.todayBoxText, "--");

  // 合法明文解码 — 二次刷新接受
  const goodRefresh = refreshMovieBoxFields(
    { ...baseMovie, todayBoxHtml: "101.60", decodeStatus: DECODE_STATUS.FAILED },
    { nationBoxWan: 120.4, sumBoxNumWan: 233700, todayUnit: "万" },
  );
  assert.strictEqual(goodRefresh.decodeStatus, DECODE_STATUS.OK);
  assert.ok(goodRefresh.todayBox > 0);
  assert.ok(goodRefresh.todayBox <= 120.4 * 1.05);
  assert.ok(goodRefresh.todayBox <= 233700 * 1.01);

  // 单片 > 全国大盘
  const overNation = refreshMovieBoxFields(
    { ...baseMovie, todayBoxHtml: "500.00", decodeStatus: DECODE_STATUS.FAILED },
    { nationBoxWan: 120.4, sumBoxNumWan: 233700, todayUnit: "万" },
  );
  assert.strictEqual(overNation.decodeStatus, DECODE_STATUS.DECODE_ERROR);
  assert.strictEqual(overNation.todayBox, 0);

  // 全国大盘结构校验
  const nationBad = refreshNationBoxFields(
    {
      todayBoxHtml: "8572685.878",
      todayUnit: "万",
      todayBox: 0,
      decodeStatus: DECODE_STATUS.FAILED,
    },
    {},
  );
  assert.notStrictEqual(nationBad.decodeStatus, DECODE_STATUS.OK);
  assert.strictEqual(nationBad.todayBox, 0);

  const nationGood = refreshNationBoxFields(
    { todayBoxHtml: "120.45", todayUnit: "万", todayBox: 0, decodeStatus: DECODE_STATUS.FAILED },
    {},
  );
  assert.strictEqual(nationGood.decodeStatus, DECODE_STATUS.OK);
  assert.ok(nationGood.todayBox > 0);

  // 节假日 5亿/10亿 全国大盘不得因 absurd 上限被拒
  const holidayCases = [
    { html: "50000.00", top1: 20000, rate: 40 },
    { html: "100000.00", top1: 40000, rate: 40 },
  ];
  for (const { html, top1, rate } of holidayCases) {
    const holiday = refreshNationBoxFields(
      { todayBoxHtml: html, todayUnit: "万", todayBox: 0, decodeStatus: DECODE_STATUS.FAILED },
      {
        movies: [{ rank: 1, todayBox: top1, boxRateNum: rate, decodeStatus: DECODE_STATUS.OK }],
        crossCheck: { top1BoxWan: top1, top1BoxRate: rate, moviesSumWan: top1, absurdMaxWan: 1_500_000 },
      },
    );
    assert.strictEqual(holiday.decodeStatus, DECODE_STATUS.OK, `${html}万 must decode ok`);
    assert.ok(holiday.todayBox >= 50000);
  }

  // nation < TOP1 → decode_error
  const nationBelowTop1 = refreshNationBoxFields(
    { todayBoxHtml: "100.00", todayUnit: "万", todayBox: 0, decodeStatus: DECODE_STATUS.FAILED },
    {
      movies: [{ rank: 1, todayBox: 200, boxRateNum: 20, decodeStatus: DECODE_STATUS.OK }],
      crossCheck: { top1BoxWan: 200, top1BoxRate: 20, moviesSumWan: 180, absurdMaxWan: 1_500_000 },
    },
  );
  assert.strictEqual(nationBelowTop1.decodeStatus, DECODE_STATUS.DECODE_ERROR);
  assert.strictEqual(nationBelowTop1.todayBox, 0);
  assert.ok(String(nationBelowTop1.rejectionReason || "").includes("nation_below_top1"));

  const apiSource = fs.readFileSync(path.join(ROOT, "ui", "maoyan-api.js"), "utf8");
  const appSource = fs.readFileSync(path.join(ROOT, "ui", "app.js"), "utf8");
  assert.ok(apiSource.includes("clearPuaMapCache"), "字体版本变化应清空 PUA 映射缓存");
  assert.ok(appSource.includes("resetBubbleBaselineOnFontChange"), "字体版本变化应清空气泡基线");

  console.log("PASS decode refresh validation");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
