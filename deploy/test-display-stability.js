/**
 * 冠军/大盘显示稳定性回归（V2 Store）
 * node deploy/test-display-stability.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

function toCandidate({ movieId, name, boxWan, nationWan, day }) {
  const okBox = Number(boxWan) > 0;
  const okNation = Number(nationWan) > 0;
  return {
    businessDate: day,
    movies: [
      {
        movieId: String(movieId),
        name,
        rank: 1,
        originalRank: 1,
        box: okBox ? { ok: true, valueWan: boxWan } : { ok: false, valueWan: 0 },
        boxRate: "11%",
        showCountRate: "21%",
        avgShowView: "101",
        sumBoxDesc: "1亿",
        raw: {
          movieId: String(movieId),
          name,
          todayBox: okBox ? boxWan : 0,
          todayBoxText: okBox ? String(boxWan) : "--",
          todayUnit: "万",
          displayBoxWan: okBox ? boxWan : 0,
        },
      },
      ...[2, 3, 4, 5].map((rank) => ({
        movieId: String(9000 + rank),
        name: `影片${rank}`,
        rank,
        originalRank: rank,
        box: { ok: true, valueWan: 10 + rank },
        boxRate: "1%",
        showCountRate: "1%",
        avgShowView: "1",
        sumBoxDesc: "1亿",
        raw: {},
      })),
    ],
    nation: {
      box: okNation ? { ok: true, valueWan: nationWan } : { ok: false, valueWan: 0 },
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
      "C:/Users/Administrator/AppData/Local/Google/Chrome/Bin/chrome.exe",
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    ].find((p) => fs.existsSync(p));
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await page.addInitScript(() => {
      window.testSettings = { bubble: { enabled: true, durationMs: 2000 } };
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

    const commit = (opts) =>
      page.evaluate(({ candidate }) => window.__racePreview.commitAndPaint(candidate), {
        candidate: toCandidate(opts),
      });

    const champText = () =>
      page.evaluate(() => ({
        value: document.getElementById("champ-box")?.textContent?.trim() || "",
        unit: document.getElementById("champ-box-unit")?.textContent?.trim() || "",
      }));
    const nationText = () =>
      page.evaluate(() => ({
        value: document.getElementById("nation-box")?.textContent?.trim() || "",
        unit: document.querySelector(".js-nation-unit")?.textContent?.trim() || "",
      }));
    const movieBox = () =>
      page.evaluate(
        () =>
          document.querySelector('[data-metric="dailyBox"] .metric__value')?.textContent?.trim() ||
          "",
      );

    await commit({ movieId: 1001, name: "A", boxWan: 120.5, nationWan: 500, day: "2026-09-15" });
    assert.strictEqual((await champText()).unit, "万");
    assert.ok((await champText()).value.includes("120.5"), "champion shows decoded amount");

    await commit({ movieId: 1001, name: "A", boxWan: 0, nationWan: 0, day: "2026-09-15" });
    assert.ok(
      (await champText()).value.includes("120.5"),
      "temporary decode gap keeps champion amount",
    );

    await commit({ movieId: 2002, name: "B", boxWan: 88.8, nationWan: 300, day: "2026-09-15" });
    assert.ok(
      (await champText()).value.includes("88.8"),
      "new champion must not inherit old champion amount",
    );

    await commit({ movieId: 2002, name: "B", boxWan: 88.8, nationWan: 300, day: "2026-09-14" });
    assert.ok((await champText()).value.includes("88.8"));
    await commit({ movieId: 2002, name: "B", boxWan: 12.3, nationWan: 40, day: "2026-09-15" });
    assert.ok(
      (await champText()).value.includes("12.3"),
      "cross-day must not reuse yesterday champion cache",
    );

    await commit({ movieId: 3003, name: "C", boxWan: 50, nationWan: 200, day: "2026-09-15" });
    const before = await nationText();
    await commit({ movieId: 3003, name: "C", boxWan: 50, nationWan: 0, day: "2026-09-15" });
    const afterGap = await nationText();
    assert.strictEqual(afterGap.value, before.value, "same-day temporary nation gap keeps last amount");
    assert.notStrictEqual(afterGap.value, "0", "decode failure must not become business zero");

    await commit({ movieId: 4004, name: "D", boxWan: 66.6, nationWan: 180, day: "2026-09-15" });
    const movieBoxBefore = await movieBox();
    assert.ok(movieBoxBefore.includes("66.6"), "movie daily box renders");
    await commit({ movieId: 4004, name: "D", boxWan: 0, nationWan: 180, day: "2026-09-15" });
    const movieBoxAfterGap = await movieBox();
    assert.ok(
      movieBoxAfterGap.includes("66.6"),
      "movie daily box stays visible during decode gap",
    );

    console.log("PASS display stability: champion cache, cross-day reset, nation gap retention");
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
