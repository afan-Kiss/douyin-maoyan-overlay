/**
 * Diagnose why PUA map times out.
 * node scripts/start-electron.js deploy/probe-map-diag.js
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

  for (const ch of [
    "get-config",
    "get-overlay-settings",
    "get-api-status",
    "ensure-api",
    "is-logged-in",
    "get-session-status",
    "report-session-api-error",
    "is-login-running",
    "start-login",
  ]) {
    ipcMain.removeHandler(ch);
  }
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
    const maoyanApi = await import('./maoyan-api.js');
    const mapper = await import('./font-pua-mapper.js');
    const helpersMod = await import('./pua-cross-helpers.js');
    const helpers = {
      validateNationCrossCheck: helpersMod.validateNationCrossCheck,
      validateDecodedBoxStructure: helpersMod.validateDecodedBoxStructure,
      isUntrustedBoxDecode: helpersMod.isUntrustedBoxDecode,
      parseBoxNum: helpersMod.parseBoxNum,
      parseRate: helpersMod.parseRate,
    };

    const raw = await maoyanApi.fetchDashboard(${JSON.stringify(config.apiBase)}, '', { topCount: 5 });
    const fullCtx = maoyanApi.buildCrossContextFromRaw(raw);
    const top5Ctx = {
      ...fullCtx,
      movies: (fullCtx.movies || []).slice(0, 5),
    };
    const top10Ctx = {
      ...fullCtx,
      movies: (fullCtx.movies || []).slice(0, 10),
    };

    const style = raw.fontStyle || '';
    const url = mapper.extractFontUrls(style);
    const buffer = await mapper.fetchFontBuffer(url.startsWith('//') ? 'https:' + url : url);

    const runs = [];
    for (const [label, crossContext, budget] of [
      ['full_default', fullCtx, {}],
      ['top5_default', top5Ctx, {}],
      ['top5_30s', top5Ctx, { timeoutMs: 30000, maxExamined: 200000 }],
      ['top10_15s', top10Ctx, { timeoutMs: 15000, maxExamined: 150000 }],
    ]) {
      const t0 = performance.now();
      const built = await mapper.buildPuaMapFromFontBuffer(buffer.slice(0), style, {
        crossContext,
        helpers,
        budget,
      });
      runs.push({
        label,
        movieCount: (crossContext.movies || []).length,
        ms: Math.round(performance.now() - t0),
        ok: built.ok,
        reason: built.reason || built.rejection_reason,
        confidence: built.confidence,
        method: built.method,
        mapSize: built.map?.size || 0,
        examined: built.candidates_examined,
        timeout: built.timeout,
        provisional: built.provisional,
      });
    }
    return {
      fullMovieCount: (fullCtx.movies || []).length,
      nationHtml: String(fullCtx.nationHtml || '').slice(0, 80),
      runs,
    };
  })()`);

  console.log(JSON.stringify(result, null, 2));
  const ok = result?.runs?.some((r) => r.ok && r.mapSize > 0);
  win.close();
  app.exit(ok ? 0 : 2);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error(err);
    app.exit(1);
  }),
);
