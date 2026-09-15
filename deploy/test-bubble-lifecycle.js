/**
 * 气泡生命周期：临时「暂无变化」显示后必须自动移除；无涨幅 tick 不再刷 idle。
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
        movieId: 8001,
        rank: 1,
        name: "生命周期",
        todayBox: 100,
        todayBoxText: "100",
        todayUnit: "万",
      },
    ]);
  });

  await page.evaluate(() => {
    const el = document.querySelector(".race-card__delta-bubble");
    window.__racePreview.bindBubbleAnchor("movie-8001", el);
    window.__racePreview.pulseNoChangeBubble(el, "movie-8001");
  });

  let text = await page.evaluate(
    () => document.querySelector(".race-card__delta-bubble")?.textContent || "",
  );
  assert.equal(text, "暂无变化", "idle bubble should show immediately when pulsed");

  await page.clock.runFor(2100);
  const state = await page.evaluate(() => {
    const el = document.querySelector(".race-card__delta-bubble");
    return {
      text: el?.textContent || "",
      visible: el?.classList.contains("is-visible") || false,
      removed: !(el?.classList.contains("is-visible")) && !(el?.textContent || "").trim(),
    };
  });
  assert.equal(state.removed, true, "idle bubble must auto-remove after duration");
  assert.equal(state.text, "");
  assert.equal(state.visible, false);

  // 再等超过 3s tick：无涨幅不得再次刷出「暂无变化」
  await page.clock.runFor(4000);
  text = await page.evaluate(
    () => document.querySelector(".race-card__delta-bubble")?.textContent || "",
  );
  assert.equal(text, "", "no-change tick must not recreate idle bubble");

  await browser.close();
  await new Promise((r) => server.close(r));
  console.log("PASS: bubble idle lifecycle auto-removes");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
