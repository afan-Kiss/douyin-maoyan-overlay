/**
 * 直播动态气泡调度器 E2E
 * node deploy/test-auto-bubble.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

function toCandidate(boxById = {}) {
  return {
    businessDate: "2026-09-16",
    movies: [1, 2, 3, 4, 5].map((rank) => {
      const id = String(1000 + rank);
      const boxWan = boxById[id] != null ? boxById[id] : 30 + rank;
      return {
        movieId: id,
        name: rank === 1 ? "功夫女足" : `影片${id}`,
        rank,
        originalRank: rank,
        box: { ok: true, valueWan: boxWan },
        boxRate: `${10 + rank}%`,
        showCountRate: `${20 + rank}%`,
        avgShowView: `${100 + rank}`,
        sumBoxDesc: `${rank}亿`,
        raw: {},
      };
    }),
    nation: {
      box: { ok: true, valueWan: 9000 },
      showCount: "12万场",
      views: "40万人",
      seatLabel: "场均人次",
      seatValue: "70",
    },
  };
}

async function unitWeightedRandom() {
  const mod = await import(
    pathToFileURL(path.join(__dirname, "..", "ui", "bubble-auto-scheduler.js")).href
  );
  assert.equal(mod.AUTO_BUBBLE_INTERVAL_MS, 5000);
  const samples = [];
  let i = 0;
  const seq = [
    0.0, 0.1, // band70 + inner
    0.8, 0.5, // band25
    0.97, 0.5, // band5
  ];
  const rng = () => seq[i++ % seq.length];
  for (let n = 0; n < 3; n++) {
    samples.push(mod.pickWeightedRandomYuan(rng));
  }
  assert.ok(samples[0] >= 100 && samples[0] <= 2000, `low=${samples[0]}`);
  assert.ok(samples[1] >= 2000 && samples[1] <= 6000, `mid=${samples[1]}`);
  assert.ok(samples[2] >= 6000 && samples[2] <= 9000, `high=${samples[2]}`);
  console.log("PASS unit: weighted random bands + interval=5000");
}

async function main() {
  await unitWeightedRandom();

  const root = path.resolve(__dirname, "../ui");
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, "http://localhost").pathname;
    const file = path.join(root, name === "/" ? "index.html" : decodeURIComponent(name));
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.setHeader(
        "Content-Type",
        file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html",
      );
      res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  let browser;
  try {
    const executablePath = [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "C:/Users/Administrator/AppData/Local/Google/Chrome/Bin/chrome.exe",
    ].find((p) => fs.existsSync(p));
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });

    const autoLogs = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("[BUBBLE_AUTO]")) autoLogs.push(text);
    });

    await page.addInitScript(() => {
      window.testSettings = { bubble: { enabled: true, durationMs: 2000, fontSize: 34 } };
      window.overlay = {
        getConfig: async () => ({}),
        getOverlaySettings: async () => window.testSettings,
        getSessionStatus: async () => ({}),
        onSettingsChanged: () => {},
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?preview=1`);
    await page.waitForFunction(() => window.__racePreview);

    const commit = (boxById) =>
      page.evaluate(
        ({ candidate }) => window.__racePreview.commitAndPaint(candidate),
        { candidate: toCandidate(boxById) },
      );

    // baseline paint — 无真实 rise
    await commit({ 1001: 40.1, 1002: 32, 1003: 33, 1004: 34, 1005: 35 });

    // 停掉自动 interval，改用显式 tick（等价于 5s 周期）
    await page.evaluate(() => {
      window.__racePreview.stopBubbleAutoScheduler();
      window.__autoNow = Date.now();
      window.__racePreview.bubbleAutoScheduler.setNowProvider(() => window.__autoNow);
    });

    const state0 = await page.evaluate(() => window.__racePreview.bubbleAutoScheduler.getState());
    assert.equal(state0.intervalMs, 5000);
    assert.equal(state0.running, false);

    // —— 1. 无真实 RiseEvent → 随机气泡 ——
    autoLogs.length = 0;
    const r1 = await page.evaluate(() => window.__racePreview.tickBubbleAutoScheduler());
    assert.equal(r1.played, true, `random tick failed: ${JSON.stringify(r1)}`);
    assert.equal(r1.type, "random");
    assert.ok(r1.amountYuan >= 100 && r1.amountYuan <= 9000, `amount=${r1.amountYuan}`);

    const ui1 = await page.evaluate(({ movieId }) => {
      const bubble = document.querySelector(
        `.race-card[data-movie-id="${movieId}"] .race-card__delta-bubble`,
      );
      const text = bubble?.textContent?.trim() || "";
      return {
        text,
        visible: bubble?.classList.contains("is-visible") || false,
        isRandom: bubble?.classList.contains("bubble-random") || false,
        isReal: bubble?.classList.contains("bubble-real") || false,
        hasSimWord: /模拟|测试|随机|demo/i.test(text),
      };
    }, { movieId: r1.movieId });
    assert.equal(ui1.visible, true);
    assert.equal(ui1.isRandom, true);
    assert.equal(ui1.isReal, false);
    assert.equal(ui1.hasSimWord, false, `UI must not show sim words: ${ui1.text}`);
    assert.ok(/^\+\d+(\.\d+)?(元|万) ↑$/.test(ui1.text), `text=${ui1.text}`);
    assert.ok(autoLogs.some((l) => l.includes("type=random") || l.includes('"type":"random"') || l.includes("type: 'random'") || /type.*random/.test(l)));
    console.log("PASS 1: random bubble without real rise", ui1.text);

    // —— 2. 注入真实 RiseEvent → bubble-real ——
    autoLogs.length = 0;
    await page.evaluate(() => {
      // 清掉随机气泡，避免干扰读数
      document.querySelectorAll(".race-card__delta-bubble").forEach((el) => {
        el.textContent = "";
        el.classList.remove("is-visible", "is-animating", "bubble-random", "bubble-real");
      });
    });
    const c2 = await commit({ 1001: 40.13, 1002: 32, 1003: 33, 1004: 34, 1005: 35 });
    assert.equal(c2.ok, true);
    assert.ok((c2.rises || []).length >= 1, "must produce real RiseEvent");

    const ui2 = await page.evaluate(() => {
      const bubble = document.querySelector(
        '.race-card[data-movie-id="1001"] .race-card__delta-bubble',
      );
      return {
        text: bubble?.textContent?.trim() || "",
        isReal: bubble?.classList.contains("bubble-real") || false,
        isRandom: bubble?.classList.contains("bubble-random") || false,
        hasSimWord: /模拟|测试|随机|demo/i.test(bubble?.textContent || ""),
      };
    });
    assert.equal(ui2.text, "+300元 ↑");
    assert.equal(ui2.isReal, true);
    assert.equal(ui2.isRandom, false);
    assert.equal(ui2.hasSimWord, false);
    assert.ok(autoLogs.some((l) => /type.*real/.test(l)), `missing real log: ${autoLogs.join(" | ")}`);
    console.log("PASS 2: real RiseEvent → bubble-real +300元 ↑");

    // —— 3. 真实存在时随机不触发 ——
    autoLogs.length = 0;
    // commit 已 markRealRise；再 tick 应 skip
    const r3 = await page.evaluate(() => window.__racePreview.tickBubbleAutoScheduler());
    // 若 flag 已被之前消费，再 mark 一次模拟「本周期有真实」
    const r3b = await page.evaluate(() => {
      window.__racePreview.markRealRiseForAutoBubble();
      return window.__racePreview.tickBubbleAutoScheduler();
    });
    assert.equal(r3b.played, false);
    assert.equal(r3b.reason, "real_rise_priority");
    assert.ok(autoLogs.some((l) => /skip_random|real_rise_priority/.test(l)));
    // r3 可能已 skip（若 flag 仍在）或偶然 random（若 flag 已清）——以 r3b 为准
    void r3;
    console.log("PASS 3: real priority blocks random");

    // —— 4. 连续 10 次随机：不会一直同一卡片 ——
    await page.evaluate(() => {
      // 清真实 flag
      window.__racePreview.bubbleAutoScheduler.consumeRealRiseFlag();
    });
    const movieIds = [];
    for (let i = 0; i < 10; i++) {
      const result = await page.evaluate(() => {
        window.__autoNow += 11000; // 超过 10s 冷却
        return window.__racePreview.tickBubbleAutoScheduler();
      });
      assert.equal(result.played, true, `tick ${i}: ${JSON.stringify(result)}`);
      movieIds.push(result.movieId);
    }
    const unique = new Set(movieIds);
    assert.ok(unique.size >= 2, `must not stick to one card: ${movieIds.join(",")}`);
    console.log("PASS 4: 10 random bubbles across cards", [...unique].join(","));

    // —— 5. stop 清理 ——
    const stopped = await page.evaluate(() => {
      window.__racePreview.startBubbleAutoScheduler();
      const before = window.__racePreview.bubbleAutoScheduler.isRunning();
      window.__racePreview.stopBubbleAutoScheduler();
      const after = window.__racePreview.bubbleAutoScheduler.isRunning();
      const state = window.__racePreview.bubbleAutoScheduler.getState();
      return { before, after, realRisePending: state.realRisePending };
    });
    assert.equal(stopped.before, true);
    assert.equal(stopped.after, false);
    assert.equal(stopped.realRisePending, false);
    console.log("PASS 5: timer cleaned on stop");

    console.log("PASS auto bubble scheduler");
  } finally {
    await browser?.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
