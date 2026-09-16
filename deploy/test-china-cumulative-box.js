/**
 * 卡片「中国内地」累计票房必须用 sumBoxDesc，禁止用 global mainlandBox。
 * node deploy/test-china-cumulative-box.js
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const mod = await import(
    pathToFileURL(path.join(__dirname, "..", "ui", "box-display.js")).href
  );
  const { resolveChinaCumulativeBox, boxTextToWanApprox } = mod;

  // 猫眼原始对照（功夫女足审计样本）：
  // sumBoxDesc=23.37亿（正确累计）
  // mainlandBox=¥3.39亿（全球分区 getBoxShowna，错误字段）
  const movie = {
    name: "功夫女足",
    movieId: 1500469,
    sumBoxDesc: "23.39亿",
    sumBoxNum: 233900,
    mainlandBox: "¥3.39亿",
    todayBox: 120.4,
    boxDesc: "120.4万",
    boxSplitUnit: { num: "120.4", unit: "万" },
    totalBox: null,
    historyBox: null,
    sumBox: "234384.8",
  };

  console.log("[TRACE] movie.name=", movie.name);
  console.log("[TRACE] box fields=", {
    sumBox: movie.sumBox,
    sumBoxDesc: movie.sumBoxDesc,
    boxDesc: movie.boxDesc,
    boxSplitUnit: movie.boxSplitUnit,
    totalBox: movie.totalBox,
    historyBox: movie.historyBox,
    todayBox: movie.todayBox,
    mainlandBox: movie.mainlandBox,
    sumBoxNum: movie.sumBoxNum,
  });

  const resolved = resolveChinaCumulativeBox(movie);
  assert.equal(resolved.sourceField, "sumBoxDesc");
  assert.equal(resolved.text, "23.39亿");
  assert.ok(resolved.valueWan >= 233800 && resolved.valueWan <= 234000);

  // UI 展示：formatMainlandDisplay 风格加 ¥
  const uiText = resolved.text.startsWith("¥") ? resolved.text : `¥${resolved.text}`;
  assert.equal(uiText, "¥23.39亿");
  assert.notEqual(uiText, "¥3.39亿", "must not show wrong global mainlandBox");

  // 禁止回落到 wrong mainlandBox
  const noSum = resolveChinaCumulativeBox({
    name: "x",
    mainlandBox: "¥3.39亿",
    todayBox: 100,
    boxDesc: "100万",
  });
  assert.equal(noSum.text, "");
  assert.equal(noSum.sourceField, "");

  // 仅有 sumBoxNum 时回退
  const byNum = resolveChinaCumulativeBox({ sumBoxNum: 233900 });
  assert.equal(byNum.sourceField, "sumBoxNum");
  assert.ok(byNum.text.includes("亿"));

  assert.equal(Math.round(boxTextToWanApprox("3.39亿")), 33900);
  assert.equal(Math.round(boxTextToWanApprox("23.39亿")), 233900);

  console.log("PASS china cumulative box uses sumBoxDesc → 23.39亿");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
