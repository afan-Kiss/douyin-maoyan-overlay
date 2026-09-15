/**
 * 3秒节奏：无涨幅不创建气泡；有涨 → 红色 +数字 ↑，上浮动效后隐藏
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

async function main() {
  const root = path.resolve(__dirname, "../ui");
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, "http://x").pathname;
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
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:/Users/Administrator/AppData/Local/Google/Chrome/Bin/chrome.exe",
  });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.addInitScript(() => {
    window.testSettings = { bubble: { enabled: true, durationMs: 2000, fontSize: 34 } };
    window.overlay = {
      getConfig: async () => ({}),
      getOverlaySettings: async () => window.testSettings,
      getSessionStatus: async () => ({}),
      onSettingsChanged: (cb) => {
        window.changeSettings = cb;
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/?preview=1`);
  await page.waitForFunction(() => window.__racePreview);
  await page.clock.install();

  await page.evaluate(() => {
    window.__racePreview.renderList([
      { movieId: 1, rank: 1, name: "诊断", todayBox: 100, todayBoxText: "100", todayUnit: "万" },
    ]);
  });
  await page.clock.runFor(3000);
  const idle = await page.evaluate(() => document.querySelector(".race-card__delta-bubble")?.textContent);
  assert.equal(idle, "", "delta==0 时不应出现「暂无变化」气泡");

  await page.evaluate(() => {
    window.__racePreview.renderList([
      {
        movieId: 1,
        rank: 1,
        name: "诊断",
        todayBox: 101.5,
        todayBoxText: "101.5",
        todayUnit: "万",
      },
    ]);
  });
  const rise = await page.evaluate(() => ({
    text: document.querySelector(".race-card__delta-bubble")?.textContent,
    color: getComputedStyle(document.querySelector(".race-card__delta-bubble")).color,
    anim: document.querySelector(".race-card__delta-bubble")?.classList.contains("is-animating"),
  }));
  assert.ok(rise.text.includes("↑"), `expected rise arrow, got ${rise.text}`);
  assert.equal(rise.color, "rgb(255, 77, 77)");
  assert.equal(rise.anim, true);

  await browser.close();
  await new Promise((r) => server.close(r));
  console.log("PASS diag-bubble-dom");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
