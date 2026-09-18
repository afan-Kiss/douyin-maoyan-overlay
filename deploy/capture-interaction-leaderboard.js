/**
 * Electron 1080×1920 互动榜验收截图
 * node scripts/start-electron.js deploy/capture-interaction-leaderboard.js
 */
const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain } = require("electron");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "ui");
const OUT_PNG = path.join(OUT_DIR, "interaction-leaderboard-1080x1920.png");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sampleMovies() {
  return Array.from({ length: 10 }, (_, i) => {
    const todayBox = i === 0 ? 852.22 : 120 + i * 37.5;
    return {
      movieId: 5000 + i,
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
  const ok = async () => ({ ready: false });
  ipcMain.handle("get-config", async () => ({
    apiBase: "http://127.0.0.1:8765",
    pollIntervalMs: 5000,
    topCount: 10,
  }));
  ipcMain.handle("get-overlay-settings", async () => ({
    bubble: { enabled: true, durationMs: 2000, fontSize: 26 },
    fonts: {},
  }));
  ipcMain.handle("get-api-status", ok);
  ipcMain.handle("ensure-api", ok);
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
  try {
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
      query: { preview: "1", liveOutput: "1", interactionDemo: "1" },
    });

    const ready = await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const check = () => window.__racePreview && window.__movieInteraction;
        if (check()) return resolve(true);
        const t = setInterval(() => {
          if (check()) {
            clearInterval(t);
            resolve(true);
          }
        }, 50);
        setTimeout(() => { clearInterval(t); resolve(false); }, 12000);
      })
    `);
    if (!ready) throw new Error("preview APIs not ready");

    const movies = sampleMovies();
    const painted = await win.webContents.executeJavaScript(`
      (() => {
        const movies = ${JSON.stringify(movies)};
        window.__racePreview.renderList(movies);
        window.__racePreview.updateNation(
          { todayBox: 3200, todayBoxText: "3200", todayUnit: "万", viewCountDesc: "120万", showCountDesc: "8万场", seatValue: "12%" },
          { calendar: { today: "2026-09-18" }, updateTimeText: "2026-09-18 15:49:46" }
        );
        window.__racePreview.setStatus("ok", "");
        window.__movieInteraction.updateMovieCatalog(movies);
        window.__movieInteraction.setViewerCount(123000);
        movies.forEach((m, i) => {
          const presets = [28000, 2400, 1200, -300, 8600, 150, -1200, 42000, 980, -50];
          window.__movieInteraction.setMovieScore(m.movieId, presets[i]);
        });
        for (let i = 0; i < 12; i++) {
          window.__movieInteraction.addDanmaku({
            msgId: "shot-" + i,
            nickname: ["小明","阿杰","小雨","老王","小白","阿强","婷婷","大伟","阿珍","阿飞","阿龙","阿花"][i],
            content: ["哪吒好评","这部电影不错","刚从电影院回来感觉太震撼","特效炸裂","支持国产","剧情很燃","差评有点闷","年度最佳","封神第二部怎么样","挺好看的","值得二刷","节奏很好"][i],
            createdAt: Date.now()
          });
        }
        window.__movieInteraction.showMovieScoreBubble({
          eventId: "shot-bubble",
          nickname: "张三",
          movieId: movies[0].movieId,
          movieName: movies[0].name,
          action: "好评",
          scoreDelta: 300,
          totalScore: 28300
        });
        const cards = [...document.querySelectorAll(".race-card:not(.race-card--skeleton)")];
        return {
          cardCount: cards.length,
          skeleton: document.querySelectorAll(".race-card--skeleton").length,
          firstTitle: cards[0]?.querySelector(".race-card__title")?.textContent || "",
          firstBox: cards[0]?.querySelector('[data-metric="dailyBox"] .metric__value')?.textContent || "",
          firstScore: cards[0]?.querySelector("[data-live-score]")?.textContent || "",
        };
      })()
    `);
    console.log("paintResult", JSON.stringify(painted));
    if (!painted || painted.cardCount < 10) {
      throw new Error("failed to paint TOP10: " + JSON.stringify(painted));
    }

    await delay(1800);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(OUT_PNG, image.toPNG());
    const size = image.getSize();
    console.log(
      JSON.stringify({ ok: true, pngPath: OUT_PNG, width: size.width, height: size.height }, null, 2),
    );
    await win.close();
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
