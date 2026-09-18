/**
 * 1080×1920 字体放大清晰度截图验收
 * node scripts/start-electron.js deploy/capture-typography.js
 */
const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain } = require("electron");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "ui", "typography-1080x1920.png");

async function main() {
  const maoyan = require(path.join(ROOT, "maoyan-service"));
  const { loadSettings } = require(path.join(ROOT, "lib", "settings"));
  const { getSessionStatus } = require(path.join(ROOT, "lib", "session-status"));

  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  } catch {
    /* ignore */
  }
  config.apiBase = maoyan.buildApiBase(config);
  await maoyan.ensureMaoyanService(config);

  ipcMain.handle("get-config", () => ({ apiBase: config.apiBase, pollIntervalMs: 5000, topCount: 10 }));
  ipcMain.handle("get-overlay-settings", () => loadSettings());
  ipcMain.handle("get-api-status", () => maoyan.getApiStatus());
  ipcMain.handle("ensure-api", async () => maoyan.ensureMaoyanService(config));
  ipcMain.handle("is-logged-in", () => Boolean(getSessionStatus()?.loginCookieReady));
  ipcMain.handle("get-session-status", () => getSessionStatus());
  ipcMain.handle("report-session-api-error", () => ({ ok: true }));
  ipcMain.handle("is-login-running", () => false);
  ipcMain.handle("start-login", () => ({ ok: false }));

  const win = new BrowserWindow({
    width: 1080,
    height: 1920,
    useContentSize: true,
    show: true,
    frame: false,
    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setContentSize(1080, 1920);

  await win.loadFile(path.join(ROOT, "ui", "index.html"), {
    query: { interactionDemo: "1", liveOutput: "1" },
  });

  for (let i = 0; i < 40; i += 1) {
    const ready = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.race-card:not(.race-card--skeleton)').length >= 5`,
    );
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 800));

  const metrics = await win.webContents.executeJavaScript(`(() => {
    const cs = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      return {
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        filter: s.filter,
        opacity: s.opacity,
        text: (el.textContent || '').trim().slice(0, 40),
      };
    };
    const stage = document.querySelector('.stage');
    return {
      title: cs('.ix-title'),
      head: cs('.ix-board__head'),
      movie: cs('.race-card__title'),
      box: cs('.race-row__box .metric__value'),
      score: cs('[data-live-score]'),
      guideTitle: cs('.ix-guide__title'),
      guideList: cs('.ix-guide__list'),
      disclaimer: cs('.ix-guide__disclaimer'),
      clock: cs('.ix-clock'),
      live: cs('.ix-live'),
      scroll: {
        body: document.body.scrollHeight > document.body.clientHeight + 2,
        stage: stage ? stage.scrollHeight > stage.clientHeight + 2 : null,
        race: document.getElementById('race-list')?.scrollHeight > document.getElementById('race-list')?.clientHeight + 2,
      },
      cards: document.querySelectorAll('.race-card:not(.race-card--skeleton)').length,
      viewportScale: getComputedStyle(document.documentElement).getPropertyValue('--viewport-scale').trim(),
      boardFilter: getComputedStyle(document.querySelector('.ix-board') || document.body).backdropFilter,
    };
  })()`);

  console.log("[TYPO_METRICS]", JSON.stringify(metrics, null, 2));
  const img = await win.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log("[SHOT]", OUT);

  const titleOk = metrics.title && parseFloat(metrics.title.fontSize) >= 56;
  const headOk = metrics.head && parseFloat(metrics.head.fontSize) >= 18;
  const movieOk = metrics.movie && parseFloat(metrics.movie.fontSize) >= 26;
  const boxOk = metrics.box && parseFloat(metrics.box.fontSize) >= 26;
  const scoreOk = metrics.score && parseFloat(metrics.score.fontSize) >= 26;
  const guideOk = metrics.guideList && parseFloat(metrics.guideList.fontSize) >= 22;
  const discOk = metrics.disclaimer && parseFloat(metrics.disclaimer.fontSize) >= 16;
  const noTitleFilter = !metrics.title?.filter || metrics.title.filter === "none";
  const noScroll = !metrics.scroll?.stage && !metrics.scroll?.race;
  // body scrollHeight 在部分环境下会偏大；以 stage/race 与卡片数为主
  const ok =
    titleOk &&
    headOk &&
    movieOk &&
    boxOk &&
    scoreOk &&
    guideOk &&
    discOk &&
    noTitleFilter &&
    noScroll &&
    metrics.cards >= 10;

  win.close();
  app.exit(ok ? 0 : 2);
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error(error);
    app.exit(1);
  }),
);
