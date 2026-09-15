/**
 * 单轮真实 Electron decode 探针
 * node scripts/start-electron.js deploy/probe-box-v2-decode.js
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
  await new Promise((r) => setTimeout(r, 2500));

  const result = await win.webContents.executeJavaScript(`(async () => {
    const api = await import('./box-pipeline.js');
    const sessionMod = await import('./dashboard-session.js');
    const maoyanApi = await import('./maoyan-api.js');
    const registry = await import('./font-registry.js');

    const raw = await maoyanApi.fetchDashboard(${JSON.stringify(config.apiBase)}, '', { topCount: 5 });
    const session = sessionMod.createDashboardSession(raw, 5);
    const out = {
      hasFontStyle: Boolean(session.fontStyle),
      movies: (session.parsed.movies || []).map((m) => ({
        id: String(m.movieId),
        html: String(m.todayBoxHtml || '').slice(0, 80),
        encoded: maoyanApi.isEncodedBoxHtml(m.todayBoxHtml || ''),
        status: m.decodeStatus,
      })),
    };

    if (!session.fontStyle) return { ...out, reason: 'no_font' };

    await sessionMod.prepareSessionFont(session);
    const built = await sessionMod.buildSessionPuaMap(session);
    const contentKey = built?.contentKey || session.fontContentKey;
    out.contentKey = contentKey;
    out.builtSummary = {
      ok: built?.built?.ok,
      reason: built?.built?.reason || built?.built?.rejection_reason,
      confidence: built?.built?.confidence,
      mapSize: built?.built?.map?.size || 0,
      method: built?.built?.method,
    };
    out.mapVerified = registry.isMapVerified(contentKey);
    out.mapVerifiedLoose = registry.isMapVerified(registry.normalizeFontIdentity?.(contentKey) || contentKey);
    const looseKey = registry.normalizeFontIdentity(contentKey) || contentKey;
    out.mapEntry = (() => {
      const e =
        registry.getMapForKey?.(contentKey) ||
        registry.getMapForKeyLoose?.(contentKey) ||
        registry.getMapForKey?.(looseKey) ||
        registry.getMapForKeyLoose?.(looseKey);
      if (!e) return null;
      return {
        size: e.map?.size || 0,
        confidence: e.mapMeta?.confidence || e.confidence || '',
        ok: e.ok,
        key: contentKey,
        looseKey,
      };
    })();

    const decoded = maoyanApi.decodeDashboardFields(session.parsed, contentKey, {
      movies: session.parsed.movies,
      crossCheckMovies: session.parsed.movies,
    });
    out.decoded = (decoded.movies || []).map((m) => ({
      id: String(m.movieId),
      status: m.decodeStatus,
      todayBox: m.todayBox,
      text: m.todayBoxText,
      verified: m.decodeVerified,
    }));
    out.decodedOk = out.decoded.filter((m) => m.status === 'ok' && m.todayBox > 0).length;

    const { createBoxStore } = await import('./box-store.js');
    const store = createBoxStore();
    const pipeline = api.createBoxPipeline({
      store,
      lockPollMs: false,
      fetchDashboardFn: async () => raw,
    });
    const once = await pipeline.runOnce({ topCount: 5 });
    out.runOnce = {
      ok: once.ok,
      reason: once.reason,
      moviesDecoded: once.moviesDecoded,
      failedMovieIds: once.failedMovieIds,
    };
    return out;
  })()`);

  console.log(JSON.stringify(result, null, 2));
  win.close();
  app.exit(result?.decodedOk > 0 || result?.runOnce?.ok ? 0 : 2);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error(err);
    app.exit(1);
  }),
);
