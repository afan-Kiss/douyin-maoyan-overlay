/**
 * 冠军/大盘/异步响应/字体切换显示稳定性回归
 * node deploy/test-display-stability.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

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

    const render = (movies, nation, day = "2026-09-15") =>
      page.evaluate(
        ({ movies, nation, day }) => {
          window.__racePreview.resetLastGoodIfDayChanged(day);
          window.__racePreview.renderList(movies);
          window.__racePreview.updateNation(nation, { calendar: { today: day } });
        },
        { movies, nation, day },
      );

    const champText = () =>
      page.evaluate(() => ({
        value: document.getElementById("champ-box")?.textContent?.trim() || "",
        unit: document.getElementById("champ-box-unit")?.textContent?.trim() || "",
        fontVersion: document.getElementById("champ-box")?.dataset?.fontVersion || "",
      }));
    const nationText = () =>
      page.evaluate(() => ({
        value: document.getElementById("nation-box")?.textContent?.trim() || "",
        unit: document.querySelector(".js-nation-unit")?.textContent?.trim() || "",
      }));

    await render(
      [{ movieId: 1001, rank: 1, name: "A", todayBox: 120.5, todayBoxText: "120.5", todayUnit: "万" }],
      { todayBox: 500, todayBoxText: "500", todayUnit: "万" },
    );
    assert.strictEqual((await champText()).unit, "万");
    assert.ok((await champText()).value.includes("120.5"), "champion shows decoded amount");

    await render(
      [{ movieId: 1001, rank: 1, name: "A", todayBox: 0, todayBoxText: "--", todayUnit: "万" }],
      { todayBox: 0, todayBoxText: "--", todayUnit: "万" },
    );
    assert.ok((await champText()).value.includes("120.5"), "temporary decode gap keeps champion amount");

    await render(
      [{ movieId: 2002, rank: 1, name: "B", todayBox: 88.8, todayBoxText: "88.8", todayUnit: "万" }],
      { todayBox: 300, todayBoxText: "300", todayUnit: "万" },
    );
    assert.ok((await champText()).value.includes("88.8"), "new champion must not inherit old champion amount");

    await render(
      [{ movieId: 2002, rank: 1, name: "B", todayBox: 88.8, todayBoxText: "88.8", todayUnit: "万" }],
      { todayBox: 300, todayBoxText: "300", todayUnit: "万" },
      "2026-09-14",
    );
    assert.ok((await champText()).value.includes("88.8"));
    await render(
      [{ movieId: 2002, rank: 1, name: "B", todayBox: 12.3, todayBoxText: "12.3", todayUnit: "万" }],
      { todayBox: 40, todayBoxText: "40", todayUnit: "万" },
      "2026-09-15",
    );
    assert.ok((await champText()).value.includes("12.3"), "cross-day must not reuse yesterday champion cache");

    await render(
      [{ movieId: 3003, rank: 1, name: "C", todayBox: 50, todayBoxText: "50", todayUnit: "万" }],
      { todayBox: 200, todayBoxText: "200", todayUnit: "万" },
    );
    const before = await nationText();
    await render(
      [{ movieId: 3003, rank: 1, name: "C", todayBox: 50, todayBoxText: "50", todayUnit: "万" }],
      { todayBox: 0, todayBoxText: "--", todayUnit: "万" },
    );
    const afterGap = await nationText();
    assert.strictEqual(afterGap.value, before.value, "same-day temporary nation gap keeps last amount");
    assert.notStrictEqual(afterGap.value, "0", "decode failure must not become business zero");

    await render(
      [{ movieId: 4004, rank: 1, name: "D", todayBox: 66.6, todayBoxText: "66.6", todayUnit: "万" }],
      { todayBox: 180, todayBoxText: "180", todayUnit: "万" },
    );
    const movieBoxBefore = await page.evaluate(
      () => document.querySelector('[data-metric="dailyBox"] .metric__value')?.textContent?.trim() || "",
    );
    assert.ok(movieBoxBefore.includes("66.6"), "movie daily box renders");
    await render(
      [{ movieId: 4004, rank: 1, name: "D", todayBox: 0, todayBoxText: "--", todayUnit: "万" }],
      { todayBox: 180, todayBoxText: "180", todayUnit: "万" },
    );
    const movieBoxAfterGap = await page.evaluate(
      () => document.querySelector('[data-metric="dailyBox"] .metric__value')?.textContent?.trim() || "",
    );
    assert.ok(movieBoxAfterGap.includes("66.6"), "movie daily box stays visible during decode gap");

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
