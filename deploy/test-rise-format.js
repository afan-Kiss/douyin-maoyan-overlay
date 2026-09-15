/**
 * 涨幅气泡格式 + Store 一致性
 * node deploy/test-rise-format.js
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

async function main() {
  const riseMod = await import(pathToFileURL(path.join(__dirname, "..", "ui", "rise-engine.js")).href);
  const storeMod = await import(pathToFileURL(path.join(__dirname, "..", "ui", "box-store.js")).href);
  const { formatRiseDelta, formatRiseText, formatRiseTextWithArrow, createRiseEngine } = riseMod;
  const { createBoxStore } = storeMod;

  // —— 格式 ——
  const cases = [
    [300, "+300元"],
    [999, "+999元"],
    [1000, "+1000元"],
    [1200, "+1200元"],
    [5600, "+5600元"],
    [9999, "+9999元"],
    [10000, "+1万"],
    [12500, "+1.25万"],
    [56000, "+5.6万"],
    [560000, "+56万"],
  ];
  for (const [yuan, expect] of cases) {
    assert.strictEqual(formatRiseDelta(yuan), expect, `yuan=${yuan}`);
  }

  // wan → yuan 入口
  assert.strictEqual(formatRiseText(0.03), "+300元");
  assert.strictEqual(formatRiseText(0.1), "+1000元");
  assert.strictEqual(formatRiseText(0.12), "+1200元");
  assert.strictEqual(formatRiseText(1), "+1万");
  assert.strictEqual(formatRiseText(1.25), "+1.25万");
  assert.strictEqual(formatRiseText(5.6), "+5.6万");
  assert.strictEqual(formatRiseText(56), "+56万");
  assert.strictEqual(formatRiseTextWithArrow(0.03), "+300元 ↑");

  // —— 数据一致性：Store commit 后 display 已是新值，RiseEvent 反映真实 delta ——
  const engine = createRiseEngine();
  /** @type {object[]} */
  const captured = [];
  engine.onRise((evt) => captured.push(evt));
  const store = createBoxStore({ riseEngine: engine });

  const c1 = store.commit({
    businessDate: "2026-09-16",
    movies: [
      {
        movieId: "1",
        name: "功夫女足",
        rank: 1,
        box: { ok: true, valueWan: 40.1 },
      },
    ],
  });
  assert.strictEqual(c1.ok, true);
  assert.strictEqual(store.getMovie("1").displayBoxWan, 40.1);
  assert.strictEqual(c1.rises.length, 0, "first accept has no rise");

  const c2 = store.commit({
    businessDate: "2026-09-16",
    movies: [
      {
        movieId: "1",
        name: "功夫女足",
        rank: 1,
        box: { ok: true, valueWan: 40.13 },
      },
    ],
  });
  assert.strictEqual(c2.ok, true);

  const movie = store.getMovie("1");
  assert.strictEqual(movie.displayBoxWan, 40.13, "display must be new value after commit");
  assert.notStrictEqual(movie.displayBoxWan, 40.1, "forbid stale display 40.10");

  assert.strictEqual(c2.rises.length, 1);
  const rise = c2.rises[0];
  assert.ok(Math.abs(rise.deltaWan - 0.03) < 1e-9, `deltaWan=${rise.deltaWan}`);
  assert.strictEqual(rise.oldWan, 40.1);
  assert.strictEqual(rise.newWan, 40.13);
  assert.strictEqual(rise.displayAfterCommit, 40.13);
  assert.strictEqual(rise.deltaYuan, 300);
  assert.strictEqual(formatRiseText(rise.deltaWan), "+300元");
  assert.strictEqual(formatRiseTextWithArrow(rise.deltaWan), "+300元 ↑");
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].displayAfterCommit, 40.13);

  console.log("PASS rise format + store consistency");
  for (const [yuan, expect] of cases) {
    console.log(`  ${yuan} → ${expect}`);
  }
  console.log("  store 40.10→40.13: display=40.13 deltaYuan=300 text=+300元 ↑");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
