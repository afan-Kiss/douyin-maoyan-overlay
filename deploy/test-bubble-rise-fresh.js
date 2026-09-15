/**
 * 涨幅不能被样本/缓存粘住
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

  const render = (amount) =>
    page.evaluate((amount) => {
      window.__racePreview.renderList([
        { movieId: 7007, rank: 1, name: "涨幅", todayBox: amount, todayBoxText: String(amount), todayUnit: "万" },
      ]);
    }, amount);

  await render(500.12);
  await page.clock.runFor(3000);
  assert.equal(
    await page.evaluate(() => document.querySelector(".race-card__delta-bubble")?.textContent || ""),
    "",
    "no rise → stay empty",
  );

  await render(501.25);
  const rise = await page.evaluate(() => ({
    text: document.querySelector(".race-card__delta-bubble")?.textContent || "",
    color: getComputedStyle(document.querySelector(".race-card__delta-bubble")).color,
  }));
  assert.ok(rise.text.includes("↑"), `expected rise arrow, got ${rise.text}`);
  assert.equal(rise.color, "rgb(255, 77, 77)");

  await browser.close();
  await new Promise((r) => server.close(r));
  console.log("PASS bubble rise uses fresh amount");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
