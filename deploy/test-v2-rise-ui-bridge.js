/**
 * V2 RiseEvent → UI 气泡桥：真实 Store 生产链 E2E
 * 40.10 → 40.13 → 界面 40.13 → +300元 ↑ → 2 秒消失
 *
 * 禁止手工调用 pulseInlineDelta / playBubblePulse / applyV2RiseEvent
 * node deploy/test-v2-rise-ui-bridge.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

function toCandidate(boxWan, day = "2026-09-16") {
  return {
    businessDate: day,
    movies: [
      {
        movieId: "1001",
        name: "功夫女足",
        rank: 1,
        originalRank: 1,
        box: { ok: true, valueWan: boxWan },
        boxRate: "11%",
        showCountRate: "21%",
        avgShowView: "101",
        sumBoxDesc: "1亿",
        raw: {
          movieId: "1001",
          name: "功夫女足",
          todayBox: boxWan,
          todayBoxText: String(boxWan),
          todayUnit: "万",
          displayBoxWan: boxWan,
        },
      },
      ...[2, 3, 4, 5].map((rank) => ({
        movieId: String(1000 + rank),
        name: `影片${1000 + rank}`,
        rank,
        originalRank: rank,
        box: { ok: true, valueWan: 30 + rank },
        boxRate: `${10 + rank}%`,
        showCountRate: `${20 + rank}%`,
        avgShowView: `${100 + rank}`,
        sumBoxDesc: `${rank}亿`,
        raw: {},
      })),
    ],
    nation: {
      box: { ok: true, valueWan: 9000 },
      showCount: "12.3万场",
      views: "45.6万人",
      seatLabel: "场均人次",
      seatValue: "78",
    },
  };
}

async function main() {
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

    const logs = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("[BOX_RISE]") || text.includes("[BUBBLE_QUEUE]") || text.includes("[BUBBLE_UI]")) {
        logs.push(text);
      }
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
    await page.goto(`http://127.0.0.1:${server.address().port}/?preview=1&uiTrace=1`);
    await page.waitForFunction(() => window.__racePreview);

    const commit = (boxWan) =>
      page.evaluate(
        ({ candidate }) => {
          const result = window.__racePreview.commitAndPaint(candidate);
          return {
            ok: result.ok,
            reason: result.reason,
            rises: (result.rises || []).map((r) => ({
              movieId: r.movieId,
              name: r.name,
              deltaWan: r.deltaWan,
              deltaYuan: r.deltaYuan,
              oldWan: r.oldWan,
              newWan: r.newWan,
            })),
            displayBoxWan: window.__racePreview.boxStore.getMovie("1001")?.displayBoxWan,
            pending: window.__racePreview.getPendingRiseCount(),
          };
        },
        { candidate: toCandidate(boxWan) },
      );

    const readUi = () =>
      page.evaluate(() => {
        const card = document.querySelector('.race-card[data-movie-id="1001"]');
        const bubble = card?.querySelector(".race-card__delta-bubble");
        const daily =
          card?.querySelector('[data-metric="dailyBox"] .metric__value')?.textContent?.trim() || "";
        return {
          daily,
          bubbleText: bubble?.textContent?.trim() || "",
          visible: bubble?.classList.contains("is-visible") || false,
          animating: bubble?.classList.contains("is-animating") || false,
          timer: window.__racePreview.isBubbleVisible("movie-1001"),
          connected: bubble?.isConnected === true,
        };
      });

    // 第一次：40.10 — 无气泡
    const c1 = await commit(40.1);
    assert.equal(c1.ok, true);
    assert.equal(c1.displayBoxWan, 40.1);
    assert.equal(c1.rises.length, 0);
    assert.equal(c1.pending, 0, "pending should be flushed after paint");
    const ui1 = await readUi();
    assert.ok(ui1.daily.includes("40.1"), `daily=${ui1.daily}`);
    assert.equal(ui1.bubbleText, "");
    assert.equal(ui1.visible, false);

    // 第二次：40.13 — 必须经 Store→Rise→queue→paint→bubble
    logs.length = 0;
    const c2 = await commit(40.13);
    assert.equal(c2.ok, true);
    assert.equal(c2.displayBoxWan, 40.13);
    assert.equal(c2.rises.length, 1);
    assert.equal(c2.rises[0].deltaWan, 0.03);
    assert.equal(c2.rises[0].deltaYuan, 300);
    assert.equal(c2.pending, 0, "queue flushed after paint");

    const ui2 = await readUi();
    assert.ok(ui2.daily.includes("40.13"), `daily after rise=${ui2.daily}`);
    assert.equal(ui2.bubbleText, "+300元 ↑");
    assert.equal(ui2.visible, true);
    assert.equal(ui2.animating, true);
    assert.equal(ui2.timer, true);

    // 诊断日志顺序：BOX_RISE → BUBBLE_QUEUE → BUBBLE_UI
    const joined = logs.join("\n");
    assert.ok(joined.includes("[BOX_RISE]"), "must log BOX_RISE");
    assert.ok(joined.includes("[BUBBLE_QUEUE]"), "must log BUBBLE_QUEUE");
    assert.ok(joined.includes("[BUBBLE_UI]"), "must log BUBBLE_UI");
    const iRise = logs.findIndex((l) => l.includes("[BOX_RISE]"));
    const iQueue = logs.findIndex((l) => l.includes("[BUBBLE_QUEUE]"));
    const iUi = logs.findIndex((l) => l.includes("[BUBBLE_UI]"));
    assert.ok(iRise >= 0 && iQueue > iRise && iUi > iQueue, `log order rise=${iRise} queue=${iQueue} ui=${iUi}`);

    // 生命周期内普通 repaint（同票房，无新 rise）
    await page.evaluate(() => {
      window.__bridgeBubble = document.querySelector(
        '.race-card[data-movie-id="1001"] .race-card__delta-bubble',
      );
    });
    const c3 = await commit(40.13);
    assert.equal(c3.rises.length, 0);
    const mid = await page.evaluate(() => ({
      same: window.__bridgeBubble?.isConnected === true,
      text: window.__bridgeBubble?.textContent?.trim() || "",
      timer: window.__racePreview.isBubbleVisible("movie-1001"),
    }));
    assert.equal(mid.same, true, "bubble DOM survives repaint");
    assert.equal(mid.text, "+300元 ↑");
    assert.equal(mid.timer, true);

    await page.waitForTimeout(2200);
    const ui3 = await readUi();
    assert.equal(ui3.bubbleText, "");
    assert.equal(ui3.visible, false);
    assert.equal(ui3.animating, false);
    assert.equal(ui3.timer, false);

    console.log("PASS v2 rise ui bridge (40.10→40.13→+300元 ↑→hide)");
  } finally {
    await browser?.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
