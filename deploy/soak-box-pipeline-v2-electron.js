/**
 * Electron 真实 10 分钟 soak：猫眼服务 + 主 UI + BOX_V2 观察。
 *
 * node scripts/start-electron.js deploy/soak-box-pipeline-v2-electron.js
 *
 * OBSERVE_MS=600000 OBSERVE_INTERVAL_MS=5000
 */
const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain } = require("electron");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "audit-data", "live-box-observe");
const OBSERVE_MS = Number(process.env.OBSERVE_MS || 10 * 60 * 1000);
const INTERVAL_MS = Number(process.env.OBSERVE_INTERVAL_MS || 5_000);

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const maoyan = require(path.join(ROOT, "maoyan-service"));
  const { loadSettings } = require(path.join(ROOT, "lib", "settings"));
  const { getSessionStatus } = require(path.join(ROOT, "lib", "session-status"));

  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  } catch {
    config = {};
  }
  const overlay = loadSettings();
  config.apiBase = maoyan.buildApiBase(config);
  config.pollIntervalMs = 5000;
  config.topCount = 5;
  config.overlay = overlay;

  ipcMain.handle("get-config", () => ({
    apiBase: config.apiBase,
    pollIntervalMs: 5000,
    topCount: 5,
  }));
  ipcMain.handle("get-overlay-settings", () => loadSettings());
  ipcMain.handle("get-api-status", () => maoyan.getApiStatus());
  ipcMain.handle("ensure-api", async () => {
    const status = await maoyan.ensureMaoyanService(config);
    if (status?.apiBase) config.apiBase = status.apiBase;
    return status || maoyan.getApiStatus();
  });
  ipcMain.handle("is-logged-in", () => Boolean(getSessionStatus()?.loginCookieReady));
  ipcMain.handle("get-session-status", () => getSessionStatus());
  ipcMain.handle("report-session-api-error", () => ({ ok: true }));
  ipcMain.handle("is-login-running", () => false);
  ipcMain.handle("start-login", () => ({ ok: false, code: "soak_skip_login" }));

  console.log("[SOAK] ensuring maoyan service…");
  let service = null;
  try {
    service = await maoyan.ensureMaoyanService(config);
    if (service?.apiBase) config.apiBase = service.apiBase;
    console.log("[SOAK] service", service || maoyan.getApiStatus());
  } catch (err) {
    console.warn("[SOAK] ensureMaoyanService failed:", err?.message || err);
  }

  const win = new BrowserWindow({
    width: 540,
    height: 1080,
    show: true,
    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  const soakStartedAt = Date.now();
  win.on("closed", () => {
    console.warn("[SOAK] window closed event");
  });

  const boxV2Events = [];
  const samples = [];
  let flashDashCount = 0;
  let champMissingCount = 0;
  let top5MissingCount = 0;
  let publishCount = 0;
  let rejectCount = 0;
  let firstGoodAt = 0;
  let maxCards = 0;

  win.webContents.on("console-message", (_e, _level, message) => {
    const text = String(message || "");
    if (text.includes("[BOX_V2]") || text.includes("BOX_V2")) {
      console.log(text);
    }
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("[SOAK] render-process-gone", details);
  });
  win.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error("[SOAK] did-fail-load", code, desc);
  });

  await win.loadFile(path.join(ROOT, "ui", "index.html"));

  // 防止关窗导致 Electron 直接退出（Windows 默认会 quit）
  app.on("window-all-closed", (e) => {
    if (Date.now() - soakStartedAt < OBSERVE_MS + 15_000) {
      console.warn("[SOAK] prevent quit on window-all-closed");
      e.preventDefault();
    }
  });

  // 保活隐藏窗，避免主观察窗被关后进程立刻退出
  const keepAlive = new BrowserWindow({
    show: false,
    width: 100,
    height: 100,
    webPreferences: { offscreen: true },
  });
  void keepAlive;

  // Hook console.log objects for reliable BOX_V2 payload capture
  try {
    await win.webContents.executeJavaScript(`(() => {
      if (window.__boxV2Hooked) return true;
      window.__boxV2Hooked = true;
      window.__boxV2Events = [];
      const orig = console.log.bind(console);
      console.log = (...args) => {
        if (args[0] === "[BOX_V2]") {
          const payload = args[1] && typeof args[1] === "object" ? args[1] : { raw: args.slice(1) };
          window.__boxV2Events.push({ at: Date.now(), ...payload });
        }
        return orig(...args);
      };
      return true;
    })()`);
  } catch (err) {
    console.error("[SOAK] hook failed", err);
    app.exit(1);
    return;
  }

  await delay(4000);

  const started = Date.now();
  console.log(`[SOAK] observing for ${OBSERVE_MS}ms…`);

  while (Date.now() - started < OBSERVE_MS) {
    if (win.isDestroyed()) {
      console.error("[SOAK] window destroyed early");
      break;
    }
    let snap;
    try {
      snap = await win.webContents.executeJavaScript(`(() => {
      const cards = [...document.querySelectorAll(".race-card")].filter(
        (el) => !el.classList.contains("race-card--skeleton")
      );
      const dailies = cards.map((card) => {
        const el = card.querySelector('[data-metric="dailyBox"] .metric__value');
        return (el?.textContent || "").trim();
      });
      const events = window.__boxV2Events || [];
      window.__boxV2Events = [];
      return {
        at: Date.now(),
        cardCount: cards.length,
        dailies,
        champ: (document.getElementById("champ-box")?.textContent || "").trim(),
        nation: (document.getElementById("nation-box")?.textContent || "").trim(),
        hasData: document.body.classList.contains("is-ready"),
        events,
      };
    })()`);
    } catch (err) {
      console.error("[SOAK] sample failed", err?.message || err);
      await delay(INTERVAL_MS);
      continue;
    }

    for (const ev of snap.events || []) {
      boxV2Events.push(ev);
      if (ev.publish === true) publishCount += 1;
      if (ev.publish === false) rejectCount += 1;
    }

    const emptyDaily = (snap.dailies || []).filter((t) => isEmptyBox(t)).length;
    const numericDaily = (snap.dailies || []).filter((t) => looksNumericBox(t)).length;
    const champEmpty = isEmptyBox(snap.champ);
    const nationEmpty = isEmptyBox(snap.nation);
    maxCards = Math.max(maxCards, snap.cardCount || 0);

    if (snap.hasData && numericDaily > 0 && !champEmpty) {
      if (!firstGoodAt) firstGoodAt = Date.now();
    }
    if (firstGoodAt) {
      if (emptyDaily > 0) flashDashCount += 1;
      if (champEmpty) champMissingCount += 1;
      if (maxCards >= 5 && snap.cardCount < 5) top5MissingCount += 1;
    }

    samples.push({
      at: snap.at,
      elapsedSec: Math.round((Date.now() - started) / 1000),
      cardCount: snap.cardCount,
      dailies: snap.dailies,
      champ: snap.champ,
      nation: snap.nation,
      emptyDaily,
      numericDaily,
      champEmpty,
      nationEmpty,
      publishCount,
      rejectCount,
    });

    console.log("[SOAK_SAMPLE]", {
      ...samples[samples.length - 1],
      lastRejects: (snap.events || [])
        .filter((e) => e.publish === false)
        .map((e) => e.rejectReason || e.reason || "?")
        .slice(-3),
      lastPublish: (snap.events || []).some((e) => e.publish === true),
    });
    await delay(INTERVAL_MS);
  }

  const report = {
    at: new Date().toISOString(),
    observeMs: OBSERVE_MS,
    intervalMs: INTERVAL_MS,
    apiBase: config.apiBase,
    serviceReady: Boolean(service?.ready || maoyan.getApiStatus()?.ready),
    publishCount,
    rejectCount,
    flashDashCount,
    champMissingCount,
    top5MissingCount,
    firstGoodAt,
    maxCards,
    sampleCount: samples.length,
    lastSample: samples[samples.length - 1] || null,
    boxV2EventCount: boxV2Events.length,
    recentBoxV2: boxV2Events.slice(-30),
    ok:
      firstGoodAt > 0 &&
      flashDashCount === 0 &&
      champMissingCount === 0 &&
      top5MissingCount === 0 &&
      publishCount > 0,
  };

  const outFile = path.join(OUT_DIR, `soak-electron-${Date.now()}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify({ report, samples: samples.slice(-80), boxV2Events: boxV2Events.slice(-300) }, null, 2),
  );
  console.log("[SOAK_REPORT]", JSON.stringify(report, null, 2));
  console.log("[SOAK] wrote", outFile);

  try {
    win.close();
  } catch {
    /* ignore */
  }
  app.exit(report.ok ? 0 : 2);
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error("[SOAK_FAIL]", err);
    app.exit(1);
  });
});
