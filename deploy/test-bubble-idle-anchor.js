/**
 * 无数值 idle anchor：不再自动刷「暂无变化」，保持空白。
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
    executablePath: [
      "C:/Users/Administrator/AppData/Local/Google/Chrome/Bin/chrome.exe",
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    ].find((p) => fs.existsSync(p)),
  });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.addInitScript(() => {
    window.testSettings = { bubble: { enabled: true, durationMs: 2000 } };
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
      {
        movieId: 9001,
        rank: 1,
        name: "锚点测试",
        todayBox: 0,
        todayBoxText: "--",
        todayBoxHtml: '<span class="stonefont">&#xe001;</span>',
        todayUnit: "万",
      },
    ]);
    const card = document.querySelector(".race-card");
    const bubble = card?.querySelector(".race-card__delta-bubble");
    const metric = card?.querySelector('[data-metric="dailyBox"] .metric__value');
    if (metric) metric.innerHTML = '<span class="metric__box-encoded mtsi-font-encoded">123</span><span class="metric__box-unit">万</span>';
    if (bubble && card) {
      window.__racePreview.bindBubbleAnchor?.("movie-9001", bubble);
    }
  });

  await page.clock.runFor(3000);
  const text = await page.evaluate(
    () => document.querySelector(".race-card__delta-bubble")?.textContent || "",
  );
  assert.equal(text, "", "idle anchor must not auto-show 暂无变化");

  await browser.close();
  await new Promise((r) => server.close(r));
  console.log("PASS bubble idle anchor stays empty");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
