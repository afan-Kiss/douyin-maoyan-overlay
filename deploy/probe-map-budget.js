/**
 * Probe PUA map build with extended budget.
 * node scripts/start-electron.js deploy/probe-map-budget.js
 */
const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain } = require("electron");

const ROOT = path.join(__dirname, "..");

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
  config.overlay = loadSettings();
  await maoyan.ensureMaoyanService(config);

  ipcMain.handle("get-config", () => ({ apiBase: config.apiBase, pollIntervalMs: 5000, topCount: 5 }));
  ipcMain.handle("get-overlay-settings", () => loadSettings());
  ipcMain.handle("get-api-status", () => maoyan.getApiStatus());
  ipcMain.handle("ensure-api", async () => maoyan.ensureMaoyanService(config));
  ipcMain.handle("is-logged-in", () => Boolean(getSessionStatus()?.loginCookieReady));
  ipcMain.handle("get-session-status", () => getSessionStatus());
  ipcMain.handle("report-session-api-error", () => ({ ok: true }));
  ipcMain.handle("is-login-running", () => false);
  ipcMain.handle("start-login", () => ({ ok: false }));

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadFile(path.join(ROOT, "ui", "index.html"), { query: { preview: "1" } });
  await new Promise((r) => setTimeout(r, 2000));

  const result = await win.webContents.executeJavaScript(`(async () => {
    const sessionMod = await import('./dashboard-session.js');
    const maoyanApi = await import('./maoyan-api.js');
    const registry = await import('./font-registry.js');
    const { isMapReadyForV2 } = await import('./box-pipeline.js');

    const raw = await maoyanApi.fetchDashboard(${JSON.stringify(config.apiBase)}, '', { topCount: 5 });
    const session = sessionMod.createDashboardSession(raw, 5);
    await sessionMod.prepareSessionFont(session);

    const budgets = [
      {},
      { timeoutMs: 15000, maxExamined: 50000 },
      { timeoutMs: 30000, maxExamined: 100000 },
    ];
    const runs = [];
    for (const budget of budgets) {
      const t0 = performance.now();
      const built = await sessionMod.buildSessionPuaMap(session, { force: true, budget });
      const contentKey = built?.contentKey || session.fontContentKey;
      runs.push({
        budget,
        ms: Math.round(performance.now() - t0),
        ok: built?.built?.ok,
        reason: built?.built?.reason || built?.built?.rejection_reason,
        confidence: built?.built?.confidence,
        mapSize: built?.built?.map?.size || 0,
        contentKey,
        mapReady: isMapReadyForV2(contentKey),
        mapVerified: registry.isMapVerified(contentKey),
        looseSize: registry.getMapForKeyLoose(contentKey)?.size || 0,
      });
      if (runs[runs.length - 1].mapReady) break;
    }
    return { runs };
  })()`);

  console.log(JSON.stringify(result, null, 2));
  const ok = result?.runs?.some((r) => r.mapReady);
  win.close();
  app.exit(ok ? 0 : 2);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error(err);
    app.exit(1);
  }),
);
