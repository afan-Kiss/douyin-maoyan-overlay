/**
 * 简化票房状态机：lastValidBox / displayBox / 涨幅气泡
 * node deploy/test-simple-box-rise.js
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");
const http = require("node:http");
const { chromium } = require("playwright");

async function testStateMachine() {
  const mod = await import(pathToFileURL(path.resolve(__dirname, "../ui/bubble-tracker.js")).href);
  mod.clearBoxStates();

  let r = mod.ingestBoxSample("m1", 100);
  assert.equal(r.action, "first");
  assert.equal(r.displayBox, 100);
  assert.equal(r.delta, 0);

  r = mod.ingestBoxSample("m1", 100);
  assert.equal(r.action, "same");
  assert.equal(r.delta, 0);

  r = mod.ingestBoxSample("m1", 101);
  assert.equal(r.action, "rise");
  assert.ok(Math.abs(r.delta - 1) < 1e-9);
  assert.equal(r.displayBox, 101);

  r = mod.ingestBoxSample("m1", 0);
  assert.equal(r.action, "invalid");
  assert.equal(r.displayBox, 101);

  r = mod.ingestBoxSample("m1", 101.5);
  assert.equal(r.action, "rise");
  assert.ok(Math.abs(r.delta - 0.5) < 1e-9);

  r = mod.ingestBoxSample("m1", 100);
  assert.equal(r.action, "drop");
  assert.equal(r.displayBox, 101.5);
  assert.equal(r.delta, 0);

  // 连续 20 轮无变化后上涨
  for (let i = 0; i < 20; i += 1) {
    r = mod.ingestBoxSample("m1", 101.5);
    assert.equal(r.action, "same");
  }
  r = mod.ingestBoxSample("m1", 102.5);
  assert.equal(r.action, "rise");
  assert.ok(Math.abs(r.delta - 1) < 1e-9);

  console.log("PASS simple box state machine");
}

async function testUiFlow() {
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
  const executablePath = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Users/Administrator/AppData/Local/Google/Chrome/Bin/chrome.exe",
  ].find((p) => fs.existsSync(p));
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.addInitScript(() => {
    window.testSettings = { bubble: { enabled: true, durationMs: 2000 }, pollIntervalMs: 5000 };
    window.overlay = {
      getConfig: async () => ({ pollIntervalMs: 5000 }),
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

  await page.evaluate(() => window.__racePreview.clearBoxStates());

  const render = (amount, extra = {}) =>
    page.evaluate(
      ({ amount, extra }) => {
        window.__racePreview.renderList([
          {
            movieId: 42,
            rank: 1,
            name: "简化",
            todayBox: amount,
            todayBoxText: amount > 0 ? String(amount) : "--",
            todayUnit: "万",
            decodeStatus: extra.decodeStatus || (amount > 0 ? "ok" : "decode_error"),
            decodeVerified: amount > 0,
            ...extra,
          },
        ]);
        window.__racePreview.updateChampion(
          [
            {
              movieId: 42,
              rank: 1,
              name: "简化",
              todayBox: amount,
              todayBoxText: amount > 0 ? String(amount) : "--",
              todayUnit: "万",
              decodeStatus: extra.decodeStatus || (amount > 0 ? "ok" : "decode_error"),
              decodeVerified: amount > 0,
              ...extra,
            },
          ],
          "2026-09-15",
        );
      },
      { amount, extra },
    );

  const read = () =>
    page.evaluate(() => ({
      daily:
        document.querySelector('[data-metric="dailyBox"] .metric__value')?.textContent?.trim() || "",
      champ: document.getElementById("champ-box")?.textContent?.trim() || "",
      bubble: document.querySelector(".race-card__delta-bubble")?.textContent?.trim() || "",
      state: window.__racePreview.getBoxState("42"),
    }));

  // 1) 100 → 显示，无气泡
  await render(100);
  let ui = await read();
  assert.match(ui.daily, /100/);
  assert.match(ui.champ, /100/);
  assert.equal(ui.bubble, "");

  // 2) 100 → 无气泡
  await render(100);
  ui = await read();
  assert.equal(ui.bubble, "");

  // 3) 101 → +1万 ↑
  await render(101);
  ui = await read();
  assert.match(ui.daily, /101/);
  assert.ok(ui.bubble.includes("↑"), ui.bubble);
  assert.ok(ui.bubble.includes("1") || ui.bubble.includes("万"), ui.bubble);

  await page.clock.runFor(2100);
  ui = await read();
  assert.equal(ui.bubble, "", "2s 后隐藏");

  // 4) decode 失败 → 仍 101，无气泡
  await render(0, { decodeStatus: "decode_error", todayBoxText: "--", todayBoxHtml: "&#xe001;" });
  ui = await read();
  assert.match(ui.daily, /101/);
  assert.match(ui.champ, /101/);
  assert.equal(ui.bubble, "");
  assert.notEqual(ui.daily, "--");

  // 5) 101.5 → +5000元 ↑
  await render(101.5);
  ui = await read();
  assert.match(ui.daily, /101\.5/);
  assert.ok(ui.bubble.includes("↑"), ui.bubble);
  assert.ok(/5000|0\.5万/.test(ui.bubble), ui.bubble);

  await page.clock.runFor(2100);

  // 6) 回落 100 → 仍 101.5，无负气泡
  await render(100);
  ui = await read();
  assert.match(ui.daily, /101\.5/);
  assert.equal(ui.bubble, "");
  assert.equal(ui.state.displayBox, 101.5);

  // 20 轮不变再涨
  for (let i = 0; i < 20; i += 1) await render(101.5);
  ui = await read();
  assert.equal(ui.bubble, "");
  await render(102.5);
  ui = await read();
  assert.ok(ui.bubble.includes("↑"), `20 flat then rise: ${ui.bubble}`);

  await browser.close();
  await new Promise((r) => server.close(r));
  console.log("PASS simple box UI flow");
}

async function main() {
  await testStateMachine();
  await testUiFlow();
  console.log("PASS test-simple-box-rise");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
