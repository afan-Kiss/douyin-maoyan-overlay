/**
 * LiveAssistant 电影互动桥回归
 * node deploy/test-movie-interaction-bridge.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const UI_DIR = path.join(ROOT, "ui");

const CHROME_CANDIDATES = [
  "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Bin\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function startUiServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const filePath = path.normalize(path.join(UI_DIR, urlPath === "/" ? "index.html" : urlPath));
      if (!filePath.startsWith(UI_DIR)) return res.writeHead(403).end();
      fs.readFile(filePath, (err, data) => {
        if (err) return res.writeHead(404).end();
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function startMockAssistant(state) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const pathname = url.pathname.replace(/\/+$/, "") || "/";
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json; charset=utf-8");

      if (state.offline) {
        res.writeHead(503).end(JSON.stringify({ ok: false }));
        return;
      }

      if (pathname.endsWith("/health")) {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (pathname.endsWith("/scores")) {
        res.end(JSON.stringify({ movies: state.scores }));
        return;
      }
      if (pathname.endsWith("/events")) {
        const after = url.searchParams.get("after") || "";
        state.lastAfter = after;
        const events = state.events.filter((e) => {
          const id = e.eventId || e.msgId || "";
          return !after || id > after;
        });
        const nextCursor = events.length
          ? events[events.length - 1].eventId || events[events.length - 1].msgId
          : after;
        res.end(JSON.stringify({ events, nextCursor }));
        return;
      }
      res.writeHead(404).end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}/diangexitong/api/movie-interaction`,
      });
    });
  });
}

async function launchBrowser() {
  const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  const opts = { headless: true, args: ["--no-sandbox", "--disable-gpu"] };
  if (chromePath) return chromium.launch({ ...opts, executablePath: chromePath });
  try {
    return await chromium.launch(opts);
  } catch (error) {
    console.log(`SKIP: Chrome not found (${error.message || error})`);
    process.exit(2);
  }
}

function sampleMovies() {
  return [
    {
      movieId: "1001",
      rank: 1,
      name: "哪吒之魔童闹海",
      todayBox: 852.22,
      todayBoxText: "852.22",
      displayBoxWan: 852.22,
      todayUnit: "万",
      boxRate: "22.1%",
      showCountRate: "25.0%",
    },
    {
      movieId: "1002",
      rank: 2,
      name: "封神第二部",
      todayBox: 420.5,
      todayBoxText: "420.5",
      displayBoxWan: 420.5,
      todayUnit: "万",
      boxRate: "12.0%",
      showCountRate: "18.0%",
    },
  ];
}

async function main() {
  const state = {
    offline: false,
    scores: [
      { movieId: "1001", movieName: "哪吒之魔童闹海", score: 300000 },
      { movieId: "1002", movieName: "封神第二部", score: -2000 },
    ],
    events: [],
    lastAfter: null,
  };

  const ui = await startUiServer();
  const mock = await startMockAssistant(state);
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await page.addInitScript(() => {
      window.overlay = {
        getConfig: async () => ({ apiBase: "http://127.0.0.1:8765", pollIntervalMs: 60000, topCount: 10 }),
        getOverlaySettings: async () => ({ bubble: { enabled: true, durationMs: 2000 } }),
        onSettingsChanged: () => () => {},
        getApiStatus: async () => ({ ready: false }),
        ensureApi: async () => ({ ready: false }),
        isLoggedIn: async () => true,
        getSessionStatus: async () => ({
          detailApiReady: true,
          identityCookieExists: true,
          sessionUsable: true,
        }),
        startLogin: async () => {},
        onApiReady: () => () => {},
      };
    });

    // 1) LiveAssistant 关闭：猫眼仍可渲染
    state.offline = true;
    await page.goto(`${ui.baseUrl}/index.html?preview=1&interactionApi=${encodeURIComponent(mock.baseUrl)}`);
    await page.waitForFunction(() => window.__racePreview && window.__movieInteraction);
    await page.evaluate((movies) => {
      window.__racePreview.renderList(movies);
      window.__racePreview.setStatus("ok", "");
    }, sampleMovies());
    await page.waitForTimeout(1200);
    const offlineSnap = await page.evaluate(() => ({
      title: document.querySelector(".ix-title")?.textContent?.trim(),
      rows: document.querySelectorAll(".race-card:not(.race-card--skeleton)").length,
      box: document.querySelector('[data-metric="dailyBox"] .metric__value')?.textContent || "",
      offline: !document.getElementById("ix-interaction-offline")?.classList.contains("is-hidden"),
      offlineText: document.getElementById("ix-interaction-offline")?.textContent || "",
    }));
    assert.strictEqual(offlineSnap.title, "电影互动榜");
    assert.ok(offlineSnap.rows >= 2, "猫眼榜仍显示");
    assert.ok(offlineSnap.box.includes("852"), `票房仍显示: ${offlineSnap.box}`);
    assert.ok(offlineSnap.offline, "应显示互动服务离线");
    assert.ok(/互动服务离线/.test(offlineSnap.offlineText));

    // 2) scores 更新直播间评分
    state.offline = false;
    await page.evaluate(async () => {
      const result = await window.__movieInteraction.service.fetchScores();
      window.__movieInteraction.applyRemoteScores(result.movies || []);
      return result;
    });
    const scoresSnap = await page.evaluate(() =>
      [...document.querySelectorAll("[data-live-score]")].map((el) => el.textContent.trim()),
    );
    assert.ok(scoresSnap.some((s) => s.includes("300,000") || s.includes("300000")), `scores=${scoresSnap}`);
    assert.ok(scoresSnap.some((s) => s.includes("-2,000") || s.includes("-2000")), `scores=${scoresSnap}`);

    // 3) movie_score → 10 秒气泡
    await page.clock.install();
    const bubble1 = await page.evaluate(() =>
      window.__movieInteraction.showMovieScoreBubble({
        eventId: "evt-score-1",
        nickname: "张三",
        movieId: "1001",
        movieName: "哪吒之魔童闹海",
        action: "good",
        scoreDelta: 300,
        totalScore: 300300,
      }),
    );
    assert.strictEqual(bubble1.skipped, undefined);
    let bubbleVisible = await page.evaluate(() =>
      Boolean(document.querySelector('.score-bubble[data-event-id="evt-score-1"]')),
    );
    assert.ok(bubbleVisible, "评分气泡应出现");

    // 6) 重复 eventId 不重复显示
    const dup = await page.evaluate(() =>
      window.__movieInteraction.showMovieScoreBubble({
        eventId: "evt-score-1",
        nickname: "张三",
        movieId: "1001",
        movieName: "哪吒之魔童闹海",
        action: "good",
        scoreDelta: 300,
        totalScore: 300300,
      }),
    );
    assert.strictEqual(dup.skipped, true);
    const bubbleCount = await page.evaluate(
      () => document.querySelectorAll('.score-bubble[data-event-id="evt-score-1"]').length,
    );
    assert.strictEqual(bubbleCount, 1);

    await page.clock.runFor(10000);
    await page.waitForTimeout(400);
    bubbleVisible = await page.evaluate(() =>
      Boolean(document.querySelector('.score-bubble[data-event-id="evt-score-1"]')),
    );
    assert.strictEqual(bubbleVisible, false, "评分气泡 10 秒后消失");

    // 4) danmaku 进入词云球
    await page.evaluate(() => {
      window.__movieInteraction.applyRemoteEvents([
        {
          type: "danmaku",
          msgId: "dm-1",
          nickname: "小明",
          content: "哪吒好看",
          createdAt: new Date().toISOString(),
        },
      ]);
    });
    const cloudText = await page.evaluate(
      () => document.querySelector('.ix-cloud__item[data-msg-id="dm-1"]')?.textContent || "",
    );
    assert.ok(/小明:哪吒好看/.test(cloudText), `cloud=${cloudText}`);

    // 5) after 断点
    state.events = [
      {
        type: "danmaku",
        eventId: "evt-a",
        msgId: "dm-a",
        nickname: "阿杰",
        content: "剧情不错",
      },
      {
        type: "movie_score",
        eventId: "evt-b",
        nickname: "李四",
        movieId: "1002",
        movieName: "封神第二部",
        action: "bad",
        scoreDelta: -100,
        totalScore: -2100,
      },
    ];
    await page.evaluate(() => {
      try {
        localStorage.removeItem("movie_interaction_cursor");
      } catch {}
    });
    const firstPull = await page.evaluate(async () => window.__movieInteraction.service.fetchEvents(""));
    assert.ok(firstPull.ok && firstPull.events.length >= 2);
    const secondPull = await page.evaluate(async () => {
      const cursor = window.__movieInteraction.service.readEventCursor();
      return window.__movieInteraction.service.fetchEvents(cursor);
    });
    assert.ok(secondPull.ok);
    assert.strictEqual(secondPull.events.length, 0, "after 断点后不应重复拉旧事件");
    assert.ok(state.lastAfter, "mock 应收到 after");

    // 7) 票房上涨气泡路径仍存在且独立
    const riseApi = await page.evaluate(() => typeof window.__racePreview.pulseInlineDelta === "function");
    assert.ok(riseApi, "票房气泡 API 仍在");

    // 8) TOP 真实字段未变
    const topSnap = await page.evaluate(() => ({
      name: document.querySelector(".race-card__title")?.textContent || "",
      box: document.querySelector('[data-metric="dailyBox"] .metric__value')?.textContent || "",
      headers: [...document.querySelectorAll(".ix-board__head .ix-col")].map((el) => el.textContent.trim()),
    }));
    assert.ok(topSnap.name.includes("哪吒"));
    assert.ok(topSnap.box.includes("852"));
    assert.deepStrictEqual(topSnap.headers, [
      "排名",
      "影片名称",
      "实时票房",
      "票房占比",
      "排片占比",
      "直播间评分",
    ]);

    // max visible = 5
    assert.strictEqual(
      await page.evaluate(() => window.__movieInteraction.SCORE_BUBBLE_MAX_VISIBLE),
      5,
    );

    console.log("PASS movie interaction bridge");
  } finally {
    await browser.close();
    ui.server.close();
    mock.server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
