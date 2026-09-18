/**
 * 上涨气泡节奏回归（V2 Store → RiseEvent → UI）
 * node deploy/test-bubble-cadence.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

function toCandidate(boxWan, nationWan, day = "2026-09-16") {
  return {
    businessDate: day,
    movies: [
      {
        movieId: "1001",
        name: "气泡测试",
        rank: 1,
        originalRank: 1,
        box: { ok: true, valueWan: boxWan },
        boxRate: "11%",
        showCountRate: "21%",
        avgShowView: "101",
        sumBoxDesc: "1亿",
        raw: {
          movieId: "1001",
          name: "气泡测试",
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
      box: { ok: true, valueWan: nationWan },
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
        file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html",
      );
      res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    const executablePath = [
      "C:/Users/Administrator/AppData/Local/Google/Chrome/Bin/chrome.exe",
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    ].find((p) => fs.existsSync(p));
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await page.addInitScript(() => {
      window.testSettings = { bubble: { enabled: true, minDelta: 0.001, durationMs: 2000 } };
      window.overlay = {
        getConfig: async () => ({}),
        getOverlaySettings: async () => window.testSettings,
        getSessionStatus: async () => ({}),
        onSettingsChanged: (callback) => {
          window.changeSettings = callback;
        },
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?preview=1`);
    await page.waitForFunction(() => window.__racePreview);
    await page.clock.install();

    const commit = (boxWan, nationWan) =>
      page.evaluate(
        ({ candidate }) => window.__racePreview.commitAndPaint(candidate),
        { candidate: toCandidate(boxWan, nationWan) },
      );

    const texts = () =>
      page.evaluate(() => [
        document.querySelector(".race-card__delta-bubble")?.textContent || "",
        document.getElementById("nation-delta")?.textContent || "",
      ]);

    await commit(852.22, 9000);
    assert.deepEqual(await texts(), ["", ""], "baseline hidden");
    await page.clock.runFor(3000);
    assert.deepEqual(await texts(), ["", ""], "no rise → no idle bubble");

    await commit(853.22, 9001);
    const riseTexts = await texts();
    assert.ok(riseTexts[0].includes("↑"), `movie bubble=${riseTexts[0]}`);
    assert.ok(riseTexts[1].includes("↑"), `nation bubble=${riseTexts[1]}`);
    const color = await page.evaluate(
      () => getComputedStyle(document.querySelector(".race-card__delta-bubble")).color,
    );
    // V2 真实上涨：绿色
    assert.equal(color, "rgb(34, 197, 94)");

    await page.clock.runFor(2100);
    assert.deepEqual(await texts(), ["", ""], "rise bubble auto-hides after duration");

    await page.clock.runFor(3000);
    assert.deepEqual(await texts(), ["", ""], "tick without delta stays empty");

    await commit(854.22, 9002);
    const rise2 = await texts();
    assert.ok(rise2[0].includes("↑") && rise2[1].includes("↑"), "another rise");

    await page.clock.runFor(2100);
    assert.deepEqual(await texts(), ["", ""], "hide again");
    await commit(850.0, 9002);
    assert.deepEqual(await texts(), ["", ""], "lower reading discarded → no bubble");
    await page.clock.runFor(3000);
    assert.deepEqual(await texts(), ["", ""], "still no idle bubble after reject");

    await commit(855.22, 9003);
    const rise3 = await texts();
    assert.ok(rise3[0].includes("↑") && rise3[1].includes("↑"), "rise above high-water");

    console.log("PASS: rise-only cadence, auto-hide, high-water reject");
  } finally {
    await browser?.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
