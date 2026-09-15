/**
 * Box Pipeline V2 端到端（轻量 DOM 模拟，无 Playwright）
 *
 * 轮次：
 * 1) TOP1~5 全部有票房
 * 2) TOP3 decode fail → DOM 仍完整显示上一轮 5 部；无 --；排名不变
 * 3) 全部成功且上涨 → 新票房一次性出现；上涨影片 +数字 ↑；2s 后消失
 *
 * 运行: node deploy/test-box-pipeline-v2-e2e.js
 */
const path = require("path");
const { pathToFileURL } = require("url");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nearly(a, b) {
  return Math.abs(Number(a) - Number(b)) < 1e-6;
}

async function main() {
  const root = path.join(__dirname, "..", "ui");
  const [{ createBoxStore }, { createRiseEngine, formatRiseTextWithArrow }, { simulateBoxRounds }, { formatWanForDisplay }] =
    await Promise.all([
      import(pathToFileURL(path.join(root, "box-store.js")).href),
      import(pathToFileURL(path.join(root, "rise-engine.js")).href),
      import(pathToFileURL(path.join(root, "box-pipeline.js")).href),
      import(pathToFileURL(path.join(root, "box-display.js")).href),
    ]);

  const dom = {
    cards: [],
    champBox: "--",
    champUnit: "万",
    nationBox: "--",
    bubbles: {},
  };

  const rises = [];
  const engine = createRiseEngine({ onRise: (e) => rises.push(e) });
  const store = createBoxStore({ riseEngine: engine });
  const bubbleTimers = new Map();

  function paint() {
    const snap = store.getSnapshot();
    dom.cards = (snap.movies || []).map((m) => {
      const amount = Number(m.displayBoxWan) || 0;
      const { valueText, unit } = formatWanForDisplay(amount);
      return {
        movieId: m.movieId,
        rank: m.rank,
        text: amount > 0 ? `${valueText}${unit}` : "--",
        amount,
      };
    });
    const champ = snap.champion;
    const champAmt = Number(champ?.displayBoxWan) || 0;
    const champFmt = formatWanForDisplay(champAmt);
    dom.champBox = champAmt > 0 ? champFmt.valueText : "--";
    dom.champUnit = champFmt.unit;
    const nationAmt = Number(snap.nation?.displayBoxWan) || 0;
    const nationFmt = formatWanForDisplay(nationAmt);
    dom.nationBox = nationAmt > 0 ? `${nationFmt.valueText}${nationFmt.unit}` : "--";
  }

  function playBubbles(events) {
    for (const evt of events || []) {
      const id = String(evt.movieId || evt.id || "");
      if (!id || id === "__nation__") continue;
      dom.bubbles[id] = formatRiseTextWithArrow(evt.deltaWan);
      if (bubbleTimers.has(id)) clearTimeout(bubbleTimers.get(id));
      bubbleTimers.set(
        id,
        setTimeout(() => {
          delete dom.bubbles[id];
        }, 2000),
      );
    }
  }

  // --- 基础单片回归 ---
  simulateBoxRounds(
    [{ businessDate: "2026-09-15", movies: [{ movieId: "solo", rank: 1, box: 100 }] }],
    store,
  );
  paint();
  assert(!String(dom.champBox).includes("--"), "solo champ visible");

  simulateBoxRounds(
    [{ businessDate: "2026-09-15", movies: [{ movieId: "solo", rank: 1, box: 101 }] }],
    store,
  );
  paint();
  playBubbles(rises.slice(-1));
  assert(dom.champBox.includes("101"), "solo champ 101");
  await sleep(2100);
  assert(!dom.bubbles.solo, "solo bubble cleared");

  // 重置到 TOP5 场景
  store.clear();
  rises.length = 0;
  dom.bubbles = {};

  // 第一轮：TOP1~TOP5 全部有票房
  const round1 = simulateBoxRounds(
    [
      {
        businessDate: "2026-09-15",
        movies: [
          { movieId: "1", rank: 1, box: 500 },
          { movieId: "2", rank: 2, box: 400 },
          { movieId: "3", rank: 3, box: 300 },
          { movieId: "4", rank: 4, box: 200 },
          { movieId: "5", rank: 5, box: 100 },
        ],
        nation: { box: 9000 },
      },
    ],
    store,
  );
  assert(round1[0].committed.ok, "round1 publish");
  paint();
  assert(dom.cards.length === 5, "round1 five cards");
  assert(dom.cards.every((c) => c.amount > 0 && !c.text.includes("--")), "round1 no --");
  assert(dom.champBox.includes("500"), `round1 champ ${dom.champBox}`);
  assert(!dom.nationBox.includes("--"), `round1 nation ${dom.nationBox}`);
  const ranks1 = dom.cards.map((c) => `${c.movieId}:${c.rank}`).join(",");

  // 第二轮：TOP3 decode fail
  const round2 = simulateBoxRounds(
    [
      {
        businessDate: "2026-09-15",
        movies: [
          { movieId: "1", rank: 1, box: 510 },
          { movieId: "2", rank: 2, box: 410 },
          { movieId: "3", rank: 3, decodeFail: true },
          { movieId: "4", rank: 4, box: 210 },
          { movieId: "5", rank: 5, box: 110 },
        ],
        nation: { box: 9100 },
      },
    ],
    store,
  );
  assert(round2[0].committed.ok === false, "round2 reject");
  assert(round2[0].committed.reason === "partial_box_decode", "round2 partial");
  paint();
  assert(dom.cards.length === 5, "round2 still 5 cards");
  assert(dom.cards.every((c) => !c.text.includes("--")), "round2 no --");
  assert(nearly(dom.cards.find((c) => c.movieId === "3").amount, 300), "round2 top3 kept 300");
  const ranks2 = dom.cards.map((c) => `${c.movieId}:${c.rank}`).join(",");
  assert(ranks1 === ranks2, `round2 ranks unchanged ${ranks1} vs ${ranks2}`);
  assert(dom.champBox.includes("500"), "round2 champ unchanged");
  assert(dom.nationBox.includes("9000") || nearly(store.getSnapshot().nation.displayBoxWan, 9000), "round2 nation kept");

  // 第三轮：全部成功且票房上涨
  rises.length = 0;
  const round3 = simulateBoxRounds(
    [
      {
        businessDate: "2026-09-15",
        movies: [
          { movieId: "1", rank: 1, box: 520 },
          { movieId: "2", rank: 2, box: 420 },
          { movieId: "3", rank: 3, box: 320 },
          { movieId: "4", rank: 4, box: 220 },
          { movieId: "5", rank: 5, box: 120 },
        ],
        nation: { box: 9200 },
      },
    ],
    store,
  );
  assert(round3[0].committed.ok, "round3 publish");
  paint();
  assert(nearly(dom.cards.find((c) => c.movieId === "3").amount, 320), "round3 top3=320");
  assert(dom.cards.every((c) => !c.text.includes("--")), "round3 no --");
  assert(dom.champBox.includes("520"), `round3 champ ${dom.champBox}`);
  const movieRises = (round3[0].rises || []).filter((e) => e.movieId !== "__nation__" && e.id !== "__nation__");
  assert(movieRises.length >= 1, "round3 has rises");
  playBubbles(round3[0].rises);
  const bubbled = Object.values(dom.bubbles);
  assert(
    bubbled.some((t) => String(t).includes("+") && String(t).includes("↑")),
    `round3 bubble got ${JSON.stringify(dom.bubbles)}`,
  );

  await sleep(2100);
  assert(Object.keys(dom.bubbles).length === 0, "round3 bubbles cleared after 2s");
  paint();
  assert(dom.cards.every((c) => !c.text.includes("--")), "after bubble still no --");
  assert(dom.champBox.includes("520"), "champ still 520");

  console.log("[OK] box-pipeline-v2 e2e DOM checks passed", {
    cards: dom.cards,
    champBox: dom.champBox,
    nationBox: dom.nationBox,
  });
}

main().catch((err) => {
  console.error("[FAIL]", err);
  process.exit(1);
});
