/**
 * 短时 soak：反复 Store 上涨，核对 BOX_RISE / BUBBLE_QUEUE / BUBBLE_UI 一一对应。
 * node deploy/soak-v2-bubble-bridge.js
 *
 * SOAK_ROUNDS 默认 30（约模拟 30 次上涨，远快于真实 5s 轮询）。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

const ROUNDS = Number(process.env.SOAK_ROUNDS || 30);

function candidate(boxWan) {
  return {
    businessDate: "2026-09-16",
    movies: [1, 2, 3, 4, 5].map((rank) => {
      const id = String(1000 + rank);
      const wan = rank === 1 ? boxWan : 20 + rank;
      return {
        movieId: id,
        name: rank === 1 ? "功夫女足" : `影片${id}`,
        rank,
        originalRank: rank,
        box: { ok: true, valueWan: wan },
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
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  let browser;
  try {
    const executablePath = [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "C:/Users/Administrator/AppData/Local/Google/Chrome/Bin/chrome.exe",
    ].find((p) => fs.existsSync(p));
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });

    let boxRise = 0;
    let bubbleQueue = 0;
    let bubbleUiPlayed = 0;
    let bubbleUiFail = 0;

    page.on("console", (msg) => {
      const t = msg.text();
      if (t.includes("[BOX_RISE]")) boxRise += 1;
      if (t.includes("[BUBBLE_QUEUE]") && t.includes("queued")) bubbleQueue += 1;
      if (t.includes("[BUBBLE_UI]") && t.includes("played")) {
        // Playwright console text for objects is often "JSHandle@object"; count via evaluate instead
      }
    });

    await page.addInitScript(() => {
      window.__soak = { boxRise: 0, bubbleQueue: 0, bubbleUiPlayed: 0, bubbleUiFail: 0 };
      const orig = console.log;
      console.log = (...args) => {
        const tag = String(args[0] || "");
        if (tag === "[BOX_RISE]") window.__soak.boxRise += 1;
        if (tag === "[BUBBLE_QUEUE]" && args[1]?.queued) window.__soak.bubbleQueue += 1;
        if (tag === "[BUBBLE_UI]") {
          if (args[1]?.played) window.__soak.bubbleUiPlayed += 1;
          else window.__soak.bubbleUiFail += 1;
        }
        return orig.apply(console, args);
      };
      window.testSettings = { bubble: { enabled: true, durationMs: 2000 } };
      window.overlay = {
        getConfig: async () => ({}),
        getOverlaySettings: async () => window.testSettings,
        getSessionStatus: async () => ({}),
        onSettingsChanged: () => {},
      };
    });

    await page.goto(`http://127.0.0.1:${server.address().port}/?preview=1&uiTrace=1`);
    await page.waitForFunction(() => window.__racePreview);

    let box = 40.1;
    await page.evaluate((c) => window.__racePreview.commitAndPaint(c), candidate(box));

    for (let i = 0; i < ROUNDS; i += 1) {
      box = Number((box + 0.03).toFixed(2));
      const result = await page.evaluate((c) => window.__racePreview.commitAndPaint(c), candidate(box));
      assert.equal(result.ok, true);
      assert.equal(result.rises?.length, 1, `round ${i} must rise`);
      const ui = await page.evaluate(() => {
        const bubble = document.querySelector(
          '.race-card[data-movie-id="1001"] .race-card__delta-bubble',
        );
        return {
          text: bubble?.textContent?.trim() || "",
          visible: bubble?.classList.contains("is-visible") || false,
        };
      });
      assert.equal(ui.text, "+300元 ↑", `round ${i} bubble=${ui.text}`);
      assert.equal(ui.visible, true);
    }

    const soak = await page.evaluate(() => window.__soak);
    console.log("[SOAK]", soak);
    assert.equal(soak.boxRise, ROUNDS, `BOX_RISE=${soak.boxRise}`);
    assert.equal(soak.bubbleQueue, ROUNDS, `BUBBLE_QUEUE=${soak.bubbleQueue}`);
    assert.equal(soak.bubbleUiPlayed, ROUNDS, `BUBBLE_UI played=${soak.bubbleUiPlayed}`);
    assert.equal(soak.bubbleUiFail, 0);

    console.log(
      `PASS soak v2 bubble bridge: BOX_RISE=${soak.boxRise} BUBBLE_QUEUE=${soak.bubbleQueue} BUBBLE_UI.played=${soak.bubbleUiPlayed}`,
    );
  } finally {
    await browser?.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
