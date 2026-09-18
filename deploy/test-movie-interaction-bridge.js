/**
 * LiveAssistant 电影互动桥回归（对齐真实 API 结构）
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

/** Mock 与 LiveAssistant 真实 API 一致 */
function startMockAssistant(state) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const pathname = url.pathname.replace(/\/+$/, "") || "/";
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8");

      if (state.offline) {
        res.writeHead(503).end(JSON.stringify({ ok: false }));
        return;
      }

      if (pathname.endsWith("/health") && req.method === "GET") {
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (pathname.endsWith("/scores") && req.method === "GET") {
        res.end(JSON.stringify({ ok: true, movies: state.scores }));
        return;
      }

      if (pathname.endsWith("/movies") && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body || "{}");
            state.postedCatalogs.push(parsed);
            state.lastPostedMovies = Array.isArray(parsed.movies) ? parsed.movies : [];
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.writeHead(400).end(JSON.stringify({ ok: false }));
          }
        });
        return;
      }

      if (pathname.endsWith("/events") && req.method === "GET") {
        const afterRaw = url.searchParams.get("after");
        const after = afterRaw == null || afterRaw === "" ? 0 : Number(afterRaw) || 0;
        state.lastAfter = after;
        if (Array.isArray(state.eventRequests)) state.eventRequests.push(after);
        const events = state.events.filter((e) => Number(e.seq) > after);
        const cursor = events.length ? Number(events[events.length - 1].seq) : after;
        res.end(
          JSON.stringify({
            ok: true,
            after,
            cursor,
            events,
          }),
        );
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

function nestedEventsFixture() {
  return [
    {
      seq: 1,
      type: "danmaku",
      createdAt: "2026-09-18T13:00:00.000Z",
      data: {
        msgId: "dm-nested-1",
        userId: "u1",
        nickname: "小明",
        content: "哪吒好看",
        platform: "douyin",
        roomId: "room-1",
      },
    },
    {
      seq: 2,
      type: "movie_score",
      createdAt: "2026-09-18T13:00:01.000Z",
      data: {
        eventId: "score-nested-1",
        userId: "u2",
        nickname: "张三",
        movieId: "1001",
        movieName: "哪吒之魔童闹海",
        action: "good",
        scoreDelta: 300,
        totalScore: 300300,
        platform: "douyin",
        roomId: "room-1",
      },
    },
  ];
}

async function main() {
  const state = {
    offline: false,
    scores: [
      {
        movieId: "1001",
        movieName: "哪吒之魔童闹海",
        score: 300000,
        goodUserCount: 128,
        badUserCount: 23,
      },
      {
        movieId: "1002",
        movieName: "封神第二部",
        score: -2000,
        goodUserCount: 0,
        badUserCount: 0,
      },
    ],
    events: [],
    lastAfter: null,
    eventRequests: [],
    postedCatalogs: [],
    lastPostedMovies: [],
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

    // 8) LiveAssistant 离线不影响票房
    state.offline = true;
    await page.goto(`${ui.baseUrl}/index.html?preview=1&interactionApi=${encodeURIComponent(mock.baseUrl)}`);
    await page.waitForFunction(() => window.__racePreview && window.__movieInteraction);
    await page.evaluate(() => {
      try {
        localStorage.removeItem("movie_interaction_cursor");
      } catch {}
      window.__movieInteraction.service.resetCatalogSignature?.();
    });
    await page.evaluate((movies) => {
      window.__racePreview.renderList(movies);
      window.__racePreview.setStatus("ok", "");
    }, sampleMovies());
    await page.waitForTimeout(800);
    const offlineSnap = await page.evaluate(() => ({
      rows: document.querySelectorAll(".race-card:not(.race-card--skeleton)").length,
      box: document.querySelector('[data-metric="dailyBox"] .metric__value')?.textContent || "",
      offline: !document.getElementById("ix-interaction-offline")?.classList.contains("is-hidden"),
    }));
    assert.ok(offlineSnap.rows >= 2, "猫眼榜仍显示");
    assert.ok(offlineSnap.box.includes("852"), `票房仍显示: ${offlineSnap.box}`);
    assert.ok(offlineSnap.offline, "应显示互动服务离线");

    // 1) TOP10 POST 到 LiveAssistant
    state.offline = false;
    state.postedCatalogs = [];
    await page.evaluate(() => window.__movieInteraction.service.resetCatalogSignature?.());
    const post1 = await page.evaluate(async (movies) => {
      // updateMovieCatalog 内部会签名去重后 POST
      window.__movieInteraction.updateMovieCatalog(movies);
      // 等微任务里的 void publishCatalog 完成
      await new Promise((r) => setTimeout(r, 50));
      return {
        signature: window.__movieInteraction.service.getLastCatalogSignature(),
        postedViaService: await window.__movieInteraction.service.publishCatalog(movies),
      };
    }, sampleMovies());
    await page.waitForTimeout(200);
    assert.ok(state.postedCatalogs.length >= 1, "mock 应收到 /movies POST");
    assert.strictEqual(state.lastPostedMovies[0].movieId, "1001");
    assert.ok(Array.isArray(state.lastPostedMovies[0].aliases), "aliases 字段必须存在");
    assert.strictEqual(state.lastPostedMovies[0].rank, 1);
    assert.ok(post1.signature, "应记录目录签名");
    assert.ok(post1.postedViaService.skipped, "相同目录二次 publish 应跳过");

    // 2) 相同目录不反复 POST
    const postsBefore = state.postedCatalogs.length;
    const post2 = await page.evaluate(async (movies) => {
      window.__movieInteraction.updateMovieCatalog(movies);
      await new Promise((r) => setTimeout(r, 50));
      return window.__movieInteraction.service.publishCatalog(movies);
    }, sampleMovies());
    assert.ok(post2.skipped && post2.reason === "unchanged", `应跳过: ${JSON.stringify(post2)}`);
    assert.strictEqual(state.postedCatalogs.length, postsBefore, "相同目录不得再 POST");

    // 3) 排名/电影变化后重新 POST
    const changed = [
      { ...sampleMovies()[1], rank: 1 },
      { ...sampleMovies()[0], rank: 2 },
    ];
    const post3 = await page.evaluate(async (movies) => {
      window.__movieInteraction.updateMovieCatalog(movies);
      await new Promise((r) => setTimeout(r, 50));
      return {
        signature: window.__movieInteraction.service.getLastCatalogSignature(),
        countHint: true,
      };
    }, changed);
    await page.waitForTimeout(100);
    assert.ok(state.postedCatalogs.length > postsBefore, "变化后应重新 POST");
    assert.ok(post3.signature, "变化后签名应更新");

    // scores + good/bad normalize
    const scoresResult = await page.evaluate(async () => {
      const result = await window.__movieInteraction.service.fetchScores();
      window.__movieInteraction.applyRemoteScores(result.movies || []);
      return {
        movies: result.movies,
        stats1001: window.__movieInteraction.getMovieStats("1001"),
        stats1002: window.__movieInteraction.getMovieStats("1002"),
        score1001: window.__movieInteraction.getMovieScore("1001"),
        dom: [...document.querySelectorAll(".race-card")].map((card) => ({
          id: card.dataset.movieId,
          good: card.querySelector("[data-good-user-count]")?.textContent?.trim(),
          bad: card.querySelector("[data-bad-user-count]")?.textContent?.trim(),
          score: card.querySelector("[data-live-score]")?.textContent?.trim(),
        })),
      };
    });
    assert.strictEqual(scoresResult.movies[0].goodUserCount, 128);
    assert.strictEqual(scoresResult.movies[0].badUserCount, 23);
    assert.strictEqual(scoresResult.movies[1].goodUserCount, 0);
    assert.strictEqual(scoresResult.movies[1].badUserCount, 0);
    assert.strictEqual(scoresResult.stats1001.goodUserCount, 128);
    assert.strictEqual(scoresResult.stats1001.badUserCount, 23);
    assert.ok(scoresResult.dom.some((d) => d.good === "128" && d.bad === "23"));
    assert.ok(scoresResult.dom.some((d) => /300/.test(d.score || "")));

    // 缺字段 / 负数 → 0；同 movie score 更新时人数一起刷新
    state.scores = [
      {
        movieId: "1001",
        movieName: "哪吒之魔童闹海",
        score: 300500,
        goodUserCount: undefined,
        badUserCount: null,
      },
      {
        movieId: "1002",
        movieName: "封神第二部",
        score: -1500,
        goodUserCount: -9,
        badUserCount: -3.7,
      },
    ];
    const normalizedEdge = await page.evaluate(async () => {
      const result = await window.__movieInteraction.service.fetchScores();
      window.__movieInteraction.applyRemoteScores(result.movies || []);
      return {
        movies: result.movies,
        stats1001: window.__movieInteraction.getMovieStats("1001"),
        stats1002: window.__movieInteraction.getMovieStats("1002"),
        score1001: window.__movieInteraction.getMovieScore("1001"),
        score1002: window.__movieInteraction.getMovieScore("1002"),
      };
    });
    assert.deepStrictEqual(
      {
        good: normalizedEdge.movies[0].goodUserCount,
        bad: normalizedEdge.movies[0].badUserCount,
      },
      { good: 0, bad: 0 },
    );
    assert.deepStrictEqual(
      {
        good: normalizedEdge.movies[1].goodUserCount,
        bad: normalizedEdge.movies[1].badUserCount,
      },
      { good: 0, bad: 0 },
    );
    assert.strictEqual(normalizedEdge.stats1001.goodUserCount, 0);
    assert.strictEqual(normalizedEdge.stats1002.badUserCount, 0);
    assert.strictEqual(normalizedEdge.score1001, 300500);
    assert.strictEqual(normalizedEdge.score1002, -1500);

    // 大人数格式化
    state.scores = [
      {
        movieId: "1001",
        movieName: "哪吒之魔童闹海",
        score: 300500,
        goodUserCount: 9999,
        badUserCount: 0,
      },
      {
        movieId: "1002",
        movieName: "封神第二部",
        score: -1500,
        goodUserCount: 12800,
        badUserCount: 12000,
      },
    ];
    const bigNums = await page.evaluate(async () => {
      const result = await window.__movieInteraction.service.fetchScores();
      window.__movieInteraction.applyRemoteScores(result.movies || []);
      const format = window.__movieInteraction.formatVoteCount;
      return {
        t0: format(0),
        t9999: format(9999),
        t12800: format(12800),
        t12000: format(12000),
        dom: [...document.querySelectorAll(".race-card")].map((card) => ({
          id: card.dataset.movieId,
          good: card.querySelector("[data-good-user-count]")?.textContent?.trim(),
          bad: card.querySelector("[data-bad-user-count]")?.textContent?.trim(),
        })),
      };
    });
    assert.strictEqual(bigNums.t0, "0");
    assert.strictEqual(bigNums.t9999, "9999");
    assert.ok(/^1\.3万$/.test(bigNums.t12800), `12800 → ${bigNums.t12800}`);
    assert.strictEqual(bigNums.t12000, "1.2万");
    assert.ok(bigNums.dom.some((d) => d.good === "9999"));
    assert.ok(bigNums.dom.some((d) => d.good === "1.3万" && d.bad === "1.2万"));

    // 4/5) 真实嵌套 danmaku + movie_score
    // 先停 poller：page.clock.runFor 会推进 setInterval，否则会污染 after/cursor 断言
    state.events = nestedEventsFixture();
    await page.clock.install();
    await page.evaluate(() => window.__movieInteraction.poller.stop());

    const pull = await page.evaluate(async () => {
      try {
        localStorage.removeItem("movie_interaction_cursor");
      } catch {}
      const result = await window.__movieInteraction.service.fetchEvents("");
      window.__movieInteraction.applyRemoteEvents(result.events || []);
      // 处理成功后再提交 cursor（fetchEvents 本身不永久 commit）
      const candidate = result.candidateCursor ?? result.cursor;
      window.__movieInteraction.service.commitEventCursor?.(candidate) ||
        window.__movieInteraction.service.writeEventCursor(candidate);
      return {
        count: result.events.length,
        cursor: result.cursor,
        types: result.events.map((e) => e.type),
        stored: window.__movieInteraction.service.readEventCursor(),
        first: result.events[0],
        second: result.events[1],
      };
    });
    assert.strictEqual(pull.count, 2);
    assert.deepStrictEqual(pull.types, ["danmaku", "movie_score"]);
    assert.strictEqual(Number(pull.cursor), 2, "cursor 必须是数字 seq");
    assert.strictEqual(String(pull.stored), "2");
    assert.ok(pull.first.msgId === "dm-nested-1" && pull.first.nickname === "小明");
    assert.ok(pull.second.eventId === "score-nested-1" && pull.second.scoreDelta === 300);

    const cloudText = await page.evaluate(
      () => document.querySelector('.ix-cloud__item[data-msg-id="dm-nested-1"]')?.textContent || "",
    );
    assert.ok(/小明:哪吒好看/.test(cloudText), `cloud=${cloudText}`);

    const bubbleVisible = await page.evaluate(() =>
      Boolean(document.querySelector('.score-bubble[data-event-id="score-nested-1"]')),
    );
    assert.ok(bubbleVisible, "嵌套 movie_score 应出气泡");

    await page.clock.runFor(10000);
    await page.waitForTimeout(400);
    const bubbleGone = await page.evaluate(() =>
      Boolean(document.querySelector('.score-bubble[data-event-id="score-nested-1"]')),
    );
    assert.strictEqual(bubbleGone, false, "评分气泡 10 秒后消失");

    // 6/7) cursor 数字 + 重启后 after 继续（poller 已停，手动拉事件，不依赖单值 lastAfter 时序）
    state.eventRequests = [];
    state.lastAfter = null;
    const cursorPhase = await page.evaluate(async () => {
      try {
        localStorage.removeItem("movie_interaction_cursor");
      } catch {}
      const first = await window.__movieInteraction.service.fetchEvents("");
      const candidate1 = first.candidateCursor ?? first.cursor;
      window.__movieInteraction.service.commitEventCursor?.(candidate1) ||
        window.__movieInteraction.service.writeEventCursor(candidate1);
      const storedAfterFirst = window.__movieInteraction.service.readEventCursor();
      const second = await window.__movieInteraction.service.fetchEvents("2");
      const candidate2 = second.candidateCursor ?? second.cursor;
      window.__movieInteraction.service.commitEventCursor?.(candidate2) ||
        window.__movieInteraction.service.writeEventCursor(candidate2);
      const resumedCursor = localStorage.getItem("movie_interaction_cursor");
      const resumed = await window.__movieInteraction.service.fetchEvents(resumedCursor);
      return {
        first,
        storedAfterFirst,
        second,
        resumedCursor,
        resumed,
      };
    });

    assert.ok(state.eventRequests.includes(0), `应出现 after=0: ${JSON.stringify(state.eventRequests)}`);
    assert.ok(state.eventRequests.includes(2), `应出现 after=2: ${JSON.stringify(state.eventRequests)}`);
    assert.deepStrictEqual(
      state.eventRequests.slice(0, 3),
      [0, 2, 2],
      `cursor 专项请求序列应为 [0,2,2]，实际=${JSON.stringify(state.eventRequests)}`,
    );
    assert.strictEqual(Number(state.eventRequests[0]), 0, "第一次请求 after=0");
    assert.strictEqual(Number(cursorPhase.first.cursor), 2, "第一次返回 cursor=2");
    assert.strictEqual(String(cursorPhase.storedAfterFirst), "2", "localStorage 应写成 2");
    assert.ok(cursorPhase.second.ok);
    assert.strictEqual(cursorPhase.second.events.length, 0, "after=2 后不应重复旧事件");
    assert.strictEqual(Number(state.eventRequests[1]), 2, "第二次请求 after=2");
    assert.strictEqual(String(cursorPhase.resumedCursor), "2", "模拟重启仍读到 localStorage=2");
    assert.strictEqual(Number(state.eventRequests[2]), 2, "重启后继续从 after=2");
    assert.strictEqual(Number(cursorPhase.resumed.cursor) || Number(state.lastAfter), 2);
    assert.strictEqual(Number(state.lastAfter), 2);

    // 票房路径仍在
    assert.ok(
      await page.evaluate(() => typeof window.__racePreview.pulseInlineDelta === "function"),
    );

    console.log("PASS movie interaction bridge (live api aligned)");
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
