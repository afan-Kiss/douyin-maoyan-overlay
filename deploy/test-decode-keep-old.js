/**
 * decode 失败不得用 null/0/"--" 覆盖上一轮有效票房。
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const api = await import(pathToFileURL(path.resolve(__dirname, "../ui/maoyan-api.js")).href);
  const { finalizeRefreshBoxFields, DECODE_STATUS } = api;

  const entity = {
    movieId: 1,
    name: "测试片",
    todayBox: 100,
    todayBoxText: "100.00",
    todayBoxHtml: "&#xe001;&#xe002;",
    todayUnit: "万",
    decodeStatus: DECODE_STATUS.OK,
  };

  const kept = finalizeRefreshBoxFields(
    entity,
    entity.todayBoxHtml,
    { todayUnit: "万", fontMappingVersion: "font-new" },
    DECODE_STATUS.DECODE_ERROR,
    "",
    0,
    "decode_failed",
  );

  assert.equal(kept.todayBox, 100, "failed decode must keep old todayBox");
  assert.notEqual(kept.todayBoxText, "--", "failed decode must not force --");
  assert.equal(kept.decodeKeepPrevious, true);

  // 语义对齐用户场景：旧 1000000 元口径（内部万）→ 新 null
  const wanEntity = { ...entity, todayBox: 100, todayBoxText: "100" }; // 100万
  const again = finalizeRefreshBoxFields(
    wanEntity,
    "",
    { todayUnit: "万" },
    DECODE_STATUS.FAILED,
    null,
    null,
    "null_new",
  );
  assert.equal(again.todayBox, 100);

  console.log("PASS: decode failure keeps previous box");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
