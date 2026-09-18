/**
 * Electron 1080×1920：LiveAssistant 桥验收截图（内置 mock）
 * node scripts/start-electron.js deploy/capture-interaction-bridge.js
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
const { app, BrowserWindow, ipcMain } = require("electron");

const ROOT = path.join(__dirname, "..");
const OUT_PNG = path.join(ROOT, "ui", "interaction-bridge-1080x1920.png");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startMockAssistant() {
  return new Promise((resolve) => {
    const scores = [
      { movieId: "5000", movieName: "哪吒之魔童闹海", score: 300000 },
      { movieId: "5001", movieName: "封神第二部", score: 2400 },
      { movieId: "5002", movieName: "抓娃娃", score: 1200 },
      { movieId: "5003", movieName: "默杀", score: -300 },
    ];
    let events = [
      {
        type: "danmaku",
        eventId: "e1",
        msgId: "d1",
        nickname: "小明",
        content: "哪吒好看",
      },
      {
        type: "danmaku",
        eventId: "e2",
        msgId: "d2",
        nickname: "阿杰",
        content: "剧情不错",
      },
      {
        type: "movie_score",
        eventId: "e3",
        nickname: "张三",
        movieId: "5000",
        movieName: "哪吒之魔童闹海",
        action: "good",
        scoreDelta: 300,
        totalScore: 300300,
      },
    ];

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const pathname = url.pathname.replace(/\/+$/, "");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      if (pathname.endsWith("/health")) return res.end(JSON.stringify({ ok: true }));
      if (pathname.endsWith("/scores")) return res.end(JSON.stringify({ movies: scores }));
      if (pathname.endsWith("/events")) {
        const after = url.searchParams.get("after") || "";
        const list = events.filter((e) => !after || String(e.eventId) > after);
        const nextCursor = list.length ? list[list.length - 1].eventId : after;
        // 只下发一次，避免截图时重复刷
        events = [];
        return res.end(JSON.stringify({ events: list, nextCursor }));
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

function sampleMovies() {
  return Array.from({ length: 10 }, (_, i) => {
    const todayBox = i === 0 ? 852.22 : 120 + i * 37.5;
    return {
      movieId: String(5000 + i),
      rank: i + 1,
      name: [
        "哪吒之魔童闹海",
        "封神第二部",
        "抓娃娃",
        "默杀",
        "云边有个小卖部",
        "异人之下",
        "志愿军：存亡之战",
        "解密",
        "刺猬",
        "浴火之路",
      ][i],
      todayBox,
      todayBoxText: String(todayBox),
      displayBoxWan: todayBox,
      todayUnit: "万",
      boxRate: `${(22 - i * 1.3).toFixed(1)}%`,
      showCountRate: `${(25 - i * 1.1).toFixed(1)}%`,
    };
  });
}

function registerPreviewIpc() {
  ipcMain.handle("get-config", async () => ({
    apiBase: "http://127.0.0.1:8765",
    pollIntervalMs: 5000,
    topCount: 10,
  }));
  ipcMain.handle("get-overlay-settings", async () => ({
    bubble: { enabled: true, durationMs: 2000 },
    fonts: {},
  }));
  ipcMain.handle("get-api-status", async () => ({ ready: false }));
  ipcMain.handle("ensure-api", async () => ({ ready: false }));
  ipcMain.handle("is-logged-in", async () => true);
  ipcMain.handle("get-session-status", async () => ({
    detailApiReady: true,
    identityCookieExists: true,
    sessionUsable: true,
  }));
  ipcMain.handle("report-session-api-error", async () => ({}));
  ipcMain.handle("is-login-running", async () => false);
  ipcMain.handle("start-login", async () => ({ ok: false }));
}

app.whenReady().then(async () => {
  let mock;
  try {
    mock = await startMockAssistant();
    registerPreviewIpc();
    const win = new BrowserWindow({
      width: 1080,
      height: 1920,
      useContentSize: true,
      show: false,
      webPreferences: {
        preload: path.join(ROOT, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        zoomFactor: 1,
      },
    });
    win.setContentSize(1080, 1920);
    await win.loadFile(path.join(ROOT, "ui", "index.html"), {
      query: {
        preview: "1",
        liveOutput: "1",
        interactionApi: mock.baseUrl,
      },
    });

    const ready = await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const check = () => window.__racePreview && window.__movieInteraction;
        if (check()) return resolve(true);
        const t = setInterval(() => {
          if (check()) { clearInterval(t); resolve(true); }
        }, 50);
        setTimeout(() => { clearInterval(t); resolve(false); }, 12000);
      })
    `);
    if (!ready) throw new Error("preview APIs not ready");

    const movies = sampleMovies();
    const painted = await win.webContents.executeJavaScript(`
      (async () => {
        const movies = ${JSON.stringify(movies)};
        window.__racePreview.renderList(movies);
        window.__racePreview.setStatus("ok", "");
        window.__movieInteraction.updateMovieCatalog(movies);
        window.__movieInteraction.setViewerCount(123000);
        const scores = await window.__movieInteraction.service.fetchScores();
        window.__movieInteraction.applyRemoteScores(scores.movies || []);
        const events = await window.__movieInteraction.service.fetchEvents("");
        window.__movieInteraction.applyRemoteEvents(events.events || []);
        const cards = [...document.querySelectorAll(".race-card:not(.race-card--skeleton)")];
        return {
          cardCount: cards.length,
          firstScore: cards[0]?.querySelector("[data-live-score]")?.textContent || "",
          bubble: document.querySelector(".score-bubble")?.textContent || "",
          cloud: document.querySelectorAll(".ix-cloud__item").length,
          offlineHidden: document.getElementById("ix-interaction-offline")?.classList.contains("is-hidden"),
        };
      })()
    `);
    console.log("paintResult", JSON.stringify(painted));
    if (!painted || painted.cardCount < 10) throw new Error("paint failed");

    await delay(1600);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(OUT_PNG, image.toPNG());
    console.log(JSON.stringify({ ok: true, pngPath: OUT_PNG, size: image.getSize(), painted }, null, 2));
    await win.close();
    mock.server.close();
    app.exit(0);
  } catch (error) {
    console.error(error);
    try {
      mock?.server?.close();
    } catch {}
    app.exit(1);
  }
});
