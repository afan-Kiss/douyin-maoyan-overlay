/**
 * 票房稳定性长观察：反复 structural 空窗 + 真实 PUA，检测有→无→有；并验证 +数字气泡。
 * 默认 10 分钟。OBSERVE_MS / OBSERVE_INTERVAL_MS 可覆盖。
 *
 * node deploy/observe-live-box-stability.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "audit-data", "live-box-observe");
const OBSERVE_MS = Number(process.env.OBSERVE_MS || 10 * 60 * 1000);
const INTERVAL_MS = Number(process.env.OBSERVE_INTERVAL_MS || 15_000);
const PUA_HTML = "&#xe6d5;&#xe701;&#xe6a2;&#xe6d5;";

function chromePath() {
  return [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Users/Administrator/AppData/Local/Google/Chrome/Bin/chrome.exe",
  ].find((p) => fs.existsSync(p));
}

function isEmptyBox(text) {
  const t = String(text || "")
    .replace(/[¥,\s]/g, "")
    .trim();
  return !t || t === "--" || t === "-";
}

function looksNumericBox(text) {
  const t = String(text || "")
    .replace(/[¥,\s万亿]/g, "")
    .trim();
  return /^\d+(\.\d+)?$/.test(t);
}

async function main() {
  const uiRoot = path.join(ROOT, "ui");
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, "http://localhost").pathname;
    const file = path.join(uiRoot, name === "/" ? "index.html" : decodeURIComponent(name));
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

  const browser = await chromium.launch({ headless: true, executablePath: chromePath() });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  await page.addInitScript(() => {
    window.testSettings = { bubble: { enabled: true, durationMs: 2500, fontSize: 34 } };
    window.overlay = {
      getConfig: async () => ({}),
      getOverlaySettings: async () => window.testSettings,
      getSessionStatus: async () => ({}),
      onSettingsChanged: (cb) => {
        window.changeSettings = cb;
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/?preview=1&boxPipelineTrace=1`);
  await page.waitForFunction(() => window.__racePreview);

  const readUi = () =>
    page.evaluate(() => ({
      at: Date.now(),
      champ: document.getElementById("champ-box")?.textContent?.trim() || "",
      daily:
        document
          .querySelector('.race-card [data-metric="dailyBox"] .metric__value')
          ?.textContent?.trim() || "",
      bubble: document.querySelector(".race-card__delta-bubble")?.textContent?.trim() || "",
    }));

  let amount = 200;
  await page.evaluate(
    ({ amount, pua }) => {
      window.__racePreview.paintStructuralDashboard(
        {
          calendar: { today: "2026-09-15" },
          responseId: 1,
          movies: [
            {
              movieId: 91001,
              rank: 1,
              name: "观察片",
              todayBox: amount,
              todayBoxText: amount.toFixed(2),
              todayUnit: "万",
              decodeStatus: "ok",
              decodeVerified: true,
            },
          ],
          nation: {
            todayBox: amount,
            todayBoxText: amount.toFixed(2),
            todayUnit: "万",
            decodeStatus: "ok",
          },
        },
        {},
        1,
        { responseId: 1 },
      );
      void pua;
    },
    { amount, pua: PUA_HTML },
  );

  const timeline = [];
  let emptyFlips = 0;
  let lastChampEmpty = false;
  let lastDailyEmpty = false;
  let bubbleSeen = false;
  let responseId = 1;
  const started = Date.now();
  let tick = 0;

  while (Date.now() - started < OBSERVE_MS) {
    tick += 1;
    responseId += 1;
    // 每隔一轮制造 structural PUA 空窗
    if (tick % 2 === 1) {
      await page.evaluate(
        ({ responseId, pua }) => {
          window.__racePreview.paintStructuralDashboard(
            {
              calendar: { today: "2026-09-15" },
              fontUrlKey: `mtsi:url:https://cdn.example/font/observe-${responseId}.woff`,
              responseId,
              movies: [
                {
                  movieId: 91001,
                  rank: 1,
                  name: "观察片",
                  todayBox: 0,
                  todayBoxText: "--",
                  todayBoxHtml: pua,
                  todayUnit: "万",
                  decodeStatus: "encoded",
                },
              ],
              nation: {
                todayBox: 0,
                todayBoxText: "--",
                todayBoxHtml: pua,
                todayUnit: "万",
                decodeStatus: "encoded",
              },
            },
            {},
            responseId,
            {
              fontUrlKey: `mtsi:url:https://cdn.example/font/observe-${responseId}.woff`,
              responseId,
            },
          );
        },
        { responseId, pua: PUA_HTML },
      );
    } else {
      amount = Number((amount + 0.2).toFixed(2));
      await page.evaluate(
        ({ amount, responseId }) => {
          const movies = [
            {
              movieId: 91001,
              rank: 1,
              name: "观察片",
              todayBox: amount,
              todayBoxText: amount.toFixed(2),
              todayUnit: "万",
              decodeStatus: "ok",
              decodeVerified: true,
            },
          ];
          window.__racePreview.renderList(movies);
          window.__racePreview.updateChampion(movies, "2026-09-15");
          void responseId;
        },
        { amount, responseId },
      );
    }

    const sample = await readUi();
    const champEmpty = isEmptyBox(sample.champ);
    const dailyEmpty = isEmptyBox(sample.daily);
    if (lastChampEmpty === false && champEmpty) emptyFlips += 1;
    if (lastDailyEmpty === false && dailyEmpty) emptyFlips += 1;
    lastChampEmpty = champEmpty;
    lastDailyEmpty = dailyEmpty;
    if (sample.bubble && sample.bubble.includes("↑")) bubbleSeen = true;
    timeline.push({
      ...sample,
      tick,
      amount,
      champEmpty,
      dailyEmpty,
      phase: tick % 2 === 1 ? "structural-gap" : "decoded-rise",
    });
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = {
    observeMs: OBSERVE_MS,
    intervalMs: INTERVAL_MS,
    samples: timeline.length,
    emptyFlips,
    bubbleSeen,
    finalAmount: amount,
    timelineTail: timeline.slice(-8),
  };
  const outFile = path.join(OUT_DIR, `observe-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`WROTE ${outFile}`);

  assert.equal(emptyFlips, 0, `empty flips must be 0, got ${emptyFlips}`);
  assert.equal(bubbleSeen, true, "must see +数字 ↑ bubble at least once");
  const lastGap = [...timeline].reverse().find((s) => s.phase === "structural-gap");
  if (lastGap) {
    assert.equal(lastGap.champEmpty, false, "gap champ must not be empty");
    assert.equal(lastGap.dailyEmpty, false, "gap daily must not be empty");
    assert.ok(looksNumericBox(lastGap.champ), `gap champ numeric, got ${lastGap.champ}`);
    assert.ok(looksNumericBox(lastGap.daily), `gap daily numeric, got ${lastGap.daily}`);
  }

  await browser.close();
  await new Promise((r) => server.close(r));
  console.log("PASS observe-live-box-stability");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
