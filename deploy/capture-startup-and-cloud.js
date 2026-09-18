/**
 * Electron：启动耗时 + 词云 0/5/10 秒位置自检
 * node scripts/start-electron.js deploy/capture-startup-and-cloud.js
 */
const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain } = require("electron");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "ui");

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
  const t0 = Date.now();
  const mark = (name) => console.log("[STARTUP_TIMING]", `${name} +${Date.now() - t0}ms`);

  mark("service_start");
  const status = await maoyan.ensureMaoyanService(config);
  mark(status?.ready ? "api_reachable" : "api_not_ready");

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
    show: true,
    frame: false,
    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.webContents.on("console-message", (_e, _level, message) => {
    const text = String(message || "");
    if (text.includes("[STARTUP_TIMING]") || text.includes("[MAOYAN_")) {
      console.log("[RENDER]", text.slice(0, 400));
    }
  });

  // interactionDemo 便于观察弹幕球
  await win.loadFile(path.join(ROOT, "ui", "index.html"), {
    query: { interactionDemo: "1" },
  });
  mark("window_loaded");

  const waitFirst = async () => {
    for (let i = 0; i < 40; i += 1) {
      const snap = await win.webContents.executeJavaScript(`({
        ready: document.body.classList.contains('is-ready'),
        real: [...document.querySelectorAll('.race-card:not(.race-card--skeleton)')].length,
        firstTitle: document.querySelector('.race-card:not(.race-card--skeleton) .race-card__title')?.textContent || ''
      })`);
      if (snap.real >= 5) return snap;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  };

  const first = await waitFirst();
  mark("first_top10_render");
  console.log("[FIRST_TOP10]", first);

  const anim = await win.webContents.executeJavaScript(`(() => {
    const glow = getComputedStyle(document.querySelector('.ix-cloud__glow') || document.body);
    const a = getComputedStyle(document.querySelector('.ix-cloud__orbit--a') || document.body);
    const b = getComputedStyle(document.querySelector('.ix-cloud__orbit--b') || document.body);
    const c = getComputedStyle(document.querySelector('.ix-cloud__orbit--c') || document.body);
    return {
      glowAnim: glow.animationName,
      glowState: glow.animationPlayState,
      orbitA: a.animationName,
      orbitAState: a.animationPlayState,
      orbitB: b.animationName,
      orbitC: c.animationName,
      cloudCount: window.__movieInteraction ? document.querySelectorAll('.ix-cloud__item').length : 0,
    };
  })()`);
  console.log("[CLOUD_CSS]", anim);

  const samples = [];
  for (const sec of [0, 5, 10]) {
    if (sec > 0) await new Promise((r) => setTimeout(r, sec === 5 ? 5000 : 5000));
    const pos = await win.webContents.executeJavaScript(`(() => {
      const items = [...document.querySelectorAll('.ix-cloud__item')].slice(0, 3).map((el) => {
        const t = el.style.transform || '';
        const m = /translate3d\\(([^,]+),\\s*([^,]+),\\s*([^)]+)\\)/.exec(t);
        return {
          text: (el.textContent || '').slice(0, 24),
          x: m ? parseFloat(m[1]) : null,
          y: m ? parseFloat(m[2]) : null,
          z: m ? parseFloat(m[3]) : null,
        };
      });
      return { sec: ${sec}, items };
    })()`);
    samples.push(pos);
    const shot = path.join(OUT_DIR, `cloud-spin-${sec}s.png`);
    const img = await win.capturePage();
    fs.writeFileSync(shot, img.toPNG());
    console.log("[CLOUD_SAMPLE]", JSON.stringify(pos));
    console.log("[SHOT]", shot);
  }

  const moved =
    samples[0]?.items?.[0] &&
    samples[2]?.items?.[0] &&
    Math.hypot(
      (samples[2].items[0].x || 0) - (samples[0].items[0].x || 0),
      (samples[2].items[0].z || 0) - (samples[0].items[0].z || 0),
    );
  console.log("[CLOUD_MOVE_0_TO_10]", moved);

  const ok =
    Boolean(first?.real >= 5) &&
    String(anim.orbitA || "").includes("cloudOrbitSpinA") &&
    anim.orbitAState !== "paused" &&
    Number(moved) > 8;

  win.close();
  app.exit(ok ? 0 : 2);
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error(error);
    app.exit(1);
  }),
);
