/**
 * Box Pipeline V2 端到端（轻量 DOM 模拟，无 Playwright）
 * 100万 → 101万 → 气泡 → 2s 消失 → decode fail 仍 101
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
    champBox: "--",
    champUnit: "万",
    dailyBox: "--",
    bubble: "",
  };

  const rises = [];
  const engine = createRiseEngine({ onRise: (e) => rises.push(e) });
  const store = createBoxStore({ riseEngine: engine });
  let bubbleTimer = null;

  function paint() {
    const m = store.getChampion() || store.getMovie("1");
    const amount = Number(m?.displayBoxWan) || 0;
    const { valueText, unit } = formatWanForDisplay(amount);
    dom.dailyBox = amount > 0 ? `${valueText}${unit}` : "--";
    dom.champBox = amount > 0 ? valueText : "--";
    dom.champUnit = unit;
  }

  function playBubble(deltaWan) {
    dom.bubble = formatRiseTextWithArrow(deltaWan);
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      dom.bubble = "";
    }, 2000);
  }

  // 1) 100万
  simulateBoxRounds(
    [{ businessDate: "2026-09-15", movies: [{ movieId: "1", rank: 1, box: 100 }] }],
    store,
  );
  paint();
  assert(dom.dailyBox.includes("100"), `daily 100 got ${dom.dailyBox}`);
  assert(dom.champBox.includes("100"), `champ 100 got ${dom.champBox}`);
  assert(!dom.bubble, "no bubble on first");

  // 2) 101万 + 气泡
  simulateBoxRounds(
    [{ businessDate: "2026-09-15", movies: [{ movieId: "1", rank: 1, box: 101 }] }],
    store,
  );
  paint();
  const rise = rises[rises.length - 1];
  assert(rise && rise.deltaWan === 1, "rise delta 1");
  playBubble(rise.deltaWan);
  assert(dom.dailyBox.includes("101"), `daily 101 got ${dom.dailyBox}`);
  assert(dom.champBox.includes("101"), `champ 101 got ${dom.champBox}`);
  assert(dom.bubble.includes("+") && dom.bubble.includes("↑"), `bubble got ${dom.bubble}`);
  assert(!dom.dailyBox.includes("--"), "no flash --");

  // 3) 2 秒后气泡清空
  await sleep(2100);
  assert(!dom.bubble, `bubble cleared got '${dom.bubble}'`);
  assert(dom.dailyBox.includes("101"), "daily still 101 after bubble");

  // 4) decode fail → 仍 101，不能 --
  simulateBoxRounds(
    [{ businessDate: "2026-09-15", movies: [{ movieId: "1", rank: 1, decodeFail: true }] }],
    store,
  );
  paint();
  assert(dom.dailyBox.includes("101"), `fail keep daily ${dom.dailyBox}`);
  assert(!dom.dailyBox.includes("--"), "must not become --");
  assert(dom.champBox.includes("101"), `fail keep champ ${dom.champBox}`);

  console.log("[OK] box-pipeline-v2 e2e DOM checks passed", dom);
}

main().catch((err) => {
  console.error("[FAIL]", err);
  process.exit(1);
});
