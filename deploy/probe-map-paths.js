/**
 * Compare session/worker/main map build paths.
 * node scripts/start-electron.js deploy/probe-map-paths.js
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
    const sessionMod = await import('./dashboard-session.js');
    const pipeline = await import('./font-pipeline.js');
    const mapper = await import('./font-pua-mapper.js');
    const helpersMod = await import('./pua-cross-helpers.js');
    const { isMapReadyForV2 } = await import('./box-pipeline.js');
    const helpers = {
      validateNationCrossCheck: helpersMod.validateNationCrossCheck,
      validateDecodedBoxStructure: helpersMod.validateDecodedBoxStructure,
      isUntrustedBoxDecode: helpersMod.isUntrustedBoxDecode,
      parseBoxNum: helpersMod.parseBoxNum,
      parseRate: helpersMod.parseRate,
    };

    const raw = await maoyanApi.fetchDashboard(${JSON.stringify(config.apiBase)}, '', { topCount: 5 });
    const session = sessionMod.createDashboardSession(raw, 5);
    await sessionMod.prepareSessionFont(session);
    const crossContext = maoyanApi.buildCrossContextFromRaw(raw, { topCount: 5 });
    const style = session.fontStyle;
    const url = mapper.extractFontUrls(style);
    const buffer = await mapper.fetchFontBuffer(url.startsWith('//') ? 'https:' + url : url);

    const out = { movieCount: crossContext.movies.length, contentKey: session.fontContentKey };

    let t0 = performance.now();
    const mainBuilt = await mapper.buildPuaMapFromFontBuffer(buffer.slice(0), style, {
      crossContext,
      helpers,
      budget: { timeoutMs: 20000, maxExamined: 200000 },
    });
    out.main = {
      ms: Math.round(performance.now() - t0),
      ok: mainBuilt.ok,
      reason: mainBuilt.reason || mainBuilt.rejection_reason,
      confidence: mainBuilt.confidence,
      method: mainBuilt.method,
      mapSize: mainBuilt.map?.size || 0,
      examined: mainBuilt.candidates_examined,
    };

    t0 = performance.now();
    const scheduled = await pipeline.schedulePuaMapBuild(style, crossContext, {
      force: true,
      fontBuffer: buffer.slice(0),
      budget: { timeoutMs: 20000, maxExamined: 200000 },
    });
    out.scheduled = {
      ms: Math.round(performance.now() - t0),
      ok: scheduled.ok,
      reason: scheduled.reason || scheduled.rejection_reason,
      confidence: scheduled.confidence,
      method: scheduled.method,
      mapSize: scheduled.map?.size || 0,
      examined: scheduled.candidates_examined,
      versionKey: scheduled.versionKey,
    };

    t0 = performance.now();
    const sess = await sessionMod.buildSessionPuaMap(session, {
      force: true,
      budget: { timeoutMs: 20000, maxExamined: 200000 },
    });
    out.session = {
      ms: Math.round(performance.now() - t0),
      ok: sess.built?.ok,
      reason: sess.built?.reason || sess.built?.rejection_reason,
      confidence: sess.built?.confidence,
      method: sess.built?.method,
      mapSize: sess.built?.map?.size || 0,
      contentKey: sess.contentKey,
      mapReady: isMapReadyForV2(sess.contentKey),
      crossMovies: sess.crossContext?.movies?.length,
    };

    return out;
  })()`);

  console.log(JSON.stringify(result, null, 2));
  win.close();
  app.exit(result?.session?.mapReady || result?.main?.ok ? 0 : 2);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error(err);
    app.exit(1);
  }),
);
