/**
 * 生产链路回归：poll structural 空窗不得闪 --；fresh 与 display 解耦；bubble 只跟 fresh。
 * node deploy/test-live-box-poll-session.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const PUA_HTML = "&#xe6d5;&#xe701;&#xe6a2;&#xe6d5;";

function chromePath() {
  return [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Users/Administrator/AppData/Local/Google/Chrome/Bin/chrome.exe",
  ].find((p) => fs.existsSync(p));
}

async function testSessionMapReuseAcrossPolls() {
  const registry = await import(pathToFileURL(path.resolve(__dirname, "../ui/font-registry.js")).href);
  const session = await import(
    pathToFileURL(path.resolve(__dirname, "../ui/dashboard-session.js")).href
  );
  registry.clearFontRegistry?.();

  const contentKey = "sha256:live-poll-reuse-test";
  const fakeMap = {
    ok: true,
    map: new Map([
      [0xe001, "1"],
      [0xe002, "0"],
    ]),
    confidence: "inferred",
    versionKey: contentKey,
  };
  registry.cacheMapForFont(contentKey, fakeMap);

  const s1 = session.createDashboardSession(
    {
      calendar: { today: "2026-09-15" },
      fontStyle: '@font-face{font-family:"mtsi";src:url("//cdn.example/font/livepoll.woff");}',
      list: [],
    },
    5,
  );
  s1.fontContentKey = contentKey;
  s1.parsed.fontContentKey = contentKey;

  // 模拟 mapping 耗时 > poll：先创建更新的 response，旧 session 变 stale
  const s2 = session.createDashboardSession(
    {
      calendar: { today: "2026-09-15" },
      fontStyle: '@font-face{font-family:"mtsi";src:url("//cdn.example/font/livepoll.woff");}',
      list: [],
    },
    5,
  );
  s2.fontContentKey = contentKey;
  s2.parsed.fontContentKey = contentKey;

  assert.equal(session.isSessionCurrent(s1), false, "older response must be stale");
  assert.equal(session.isSessionCurrent(s2), true, "latest response must be current");

  const cached = registry.getMapForKeyLoose(contentKey);
  assert.ok(cached && cached.size > 0, "same font mapping must remain reusable after newer poll");
  console.log("PASS live-box-poll session map reuse (mapping delay > poll)");
}

async function testUiPollHoldAndBubble() {
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
  await page.goto(`http://127.0.0.1:${server.address().port}/?preview=1`);
  await page.waitForFunction(() => window.__racePreview);

  const readUi = () =>
    page.evaluate(() => {
      const card = document.querySelector(".race-card");
      const daily = card?.querySelector('[data-metric="dailyBox"] .metric__value');
      const bubble = card?.querySelector(".race-card__delta-bubble");
      return {
        champ: document.getElementById("champ-box")?.textContent?.trim() || "",
        daily: daily?.textContent?.trim() || "",
        bubble: bubble?.textContent?.trim() || "",
      };
    });

  // ---------- 第 1 轮：可信明文 100.00万 ----------
  await page.evaluate(() => {
    const movies = [
      {
        movieId: 9001,
        rank: 1,
        name: "链路片",
        todayBox: 100,
        todayBoxText: "100.00",
        todayUnit: "万",
        decodeStatus: "ok",
        decodeVerified: true,
      },
    ];
    window.__racePreview.resetLastGoodIfDayChanged("2026-09-15");
    // 走与线上一致的 structural→display 路径，写入 lastGood / hasDisplayedData
    window.__racePreview.paintStructuralDashboard(
      {
        calendar: { today: "2026-09-15" },
        fontUrlKey: "",
        fontContentKey: "",
        responseId: 1,
        movies,
        nation: {
          todayBox: 500,
          todayBoxText: "500",
          todayUnit: "万",
          decodeStatus: "ok",
        },
      },
      {},
      1,
      { responseId: 1 },
    );
  });
  let ui = await readUi();
  assert.match(ui.champ, /100/, `round1 champion got ${ui.champ}`);
  assert.match(ui.daily, /100/, `round1 daily got ${ui.daily}`);

  // ---------- 第 2 轮：structural 空窗（PUA + 未 ready）----------
  await page.evaluate((pua) => {
    const parsed = {
      calendar: { today: "2026-09-15" },
      fontUrlKey: "mtsi:url:https://cdn.example/font/not-ready-yet.woff",
      fontContentKey: "",
      responseId: 2,
      movies: [
        {
          movieId: 9001,
          rank: 1,
          name: "链路片",
          todayBox: 0,
          todayBoxText: "--",
          todayBoxHtml: pua,
          todayUnit: "万",
          decodeStatus: "encoded",
          decodeVerified: false,
        },
      ],
      nation: {
        todayBox: 0,
        todayBoxText: "--",
        todayBoxHtml: pua,
        todayUnit: "万",
        decodeStatus: "encoded",
      },
    };
    window.__racePreview.paintStructuralDashboard(parsed, {}, 2, {
      fontUrlKey: parsed.fontUrlKey,
      fontContentKey: "",
      responseId: 2,
    });
  }, PUA_HTML);
  ui = await readUi();
  assert.match(ui.champ, /100/, `round2 champion must hold, got ${ui.champ}`);
  assert.match(ui.daily, /100/, `round2 daily must hold, got ${ui.daily}`);
  assert.equal(ui.bubble, "", "round2 no bubble during structural gap");
  assert.notEqual(ui.champ, "--");
  assert.notEqual(ui.daily, "--");

  // stabilize / fresh 解耦断言
  const stabilizeCheck = await page.evaluate((pua) => {
    const kept = window.__racePreview.stabilizeMovie({
      movieId: 9001,
      rank: 1,
      name: "链路片",
      todayBox: 0,
      todayBoxText: "--",
      todayBoxHtml: pua,
      todayUnit: "万",
      decodeStatus: "decode_error",
    });
    return {
      todayBox: kept.todayBox,
      todayBoxText: kept.todayBoxText,
      decodeKeepPrevious: kept.decodeKeepPrevious,
      display: window.__racePreview.getMovieBoxAmount(kept),
      fresh: window.__racePreview.getMovieBoxAmountFresh(kept),
      canPaint: window.__racePreview.canPaintCurrentBox(kept, {
        fontUrlKey: "mtsi:url:https://cdn.example/font/not-ready-yet.woff",
      }),
    };
  }, PUA_HTML);
  assert.equal(stabilizeCheck.todayBox, 100);
  assert.equal(stabilizeCheck.decodeKeepPrevious, true);
  assert.equal(stabilizeCheck.display, 100);
  assert.equal(stabilizeCheck.fresh, 0, "keep-previous must not count as fresh");
  assert.equal(stabilizeCheck.canPaint, false);

  // ---------- 第 3 阶段：mapping ready / 真实 101.00 ----------
  await page.evaluate(() => {
    const movies = [
      {
        movieId: 9001,
        rank: 1,
        name: "链路片",
        todayBox: 101,
        todayBoxText: "101.00",
        todayUnit: "万",
        decodeStatus: "ok",
        decodeVerified: true,
      },
    ];
    window.__racePreview.renderList(movies);
    window.__racePreview.updateChampion(movies, "2026-09-15");
  });
  ui = await readUi();
  assert.match(ui.champ, /101/, `round3 champion got ${ui.champ}`);
  assert.match(ui.daily, /101/, `round3 daily got ${ui.daily}`);
  assert.ok(ui.bubble.includes("↑"), `round3 bubble expected +rise, got "${ui.bubble}"`);
  assert.ok(/1|10000|万/.test(ui.bubble), `round3 bubble should show +1万-ish, got "${ui.bubble}"`);

  // ---------- 第 4 轮：再次 structural 空窗 ----------
  await page.evaluate((pua) => {
    const parsed = {
      calendar: { today: "2026-09-15" },
      fontUrlKey: "mtsi:url:https://cdn.example/font/not-ready-yet.woff",
      fontContentKey: "",
      responseId: 4,
      movies: [
        {
          movieId: 9001,
          rank: 1,
          name: "链路片",
          todayBox: 0,
          todayBoxText: "--",
          todayBoxHtml: pua,
          todayUnit: "万",
          decodeStatus: "encoded",
        },
      ],
      nation: { todayBox: 0, todayBoxText: "--", todayBoxHtml: pua, todayUnit: "万" },
    };
    window.__racePreview.paintStructuralDashboard(parsed, {}, 4, {
      fontUrlKey: parsed.fontUrlKey,
      responseId: 4,
    });
  }, PUA_HTML);
  ui = await readUi();
  assert.match(ui.champ, /101/, `round4 champion must hold 101, got ${ui.champ}`);
  assert.match(ui.daily, /101/, `round4 daily must hold 101, got ${ui.daily}`);
  assert.notEqual(ui.champ, "--");
  assert.notEqual(ui.daily, "--");

  await browser.close();
  await new Promise((r) => server.close(r));
  console.log("PASS live-box-poll UI hold + bubble rise");
}

async function main() {
  await testSessionMapReuseAcrossPolls();
  await testUiPollHoldAndBubble();
  console.log("PASS test-live-box-poll-session");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
