/**
 * Electron 多帧追踪：今日大盘 / 冠军 / 单片实时票房
 * node scripts/start-electron.js deploy/trace-box-regions-electron.js
 */
const fs = require("node:fs");
const path = require("node:path");

const OUT_DIR = path.join(__dirname, "../audit-data/box-region-trace");
const FRAMES = Number(process.env.TRACE_FRAMES || 12);
const INTERVAL_MS = Number(process.env.TRACE_INTERVAL_MS || 1500);

function probeRegion(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) {
      return { selector: sel, missing: true };
    }
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      selector: sel,
      text: (el.textContent || "").trim().slice(0, 80),
      innerHtmlLen: (el.innerHTML || "").length,
      fontFamily: style.fontFamily,
      fontVersion: el.dataset?.fontVersion || "",
      opacity: style.opacity,
      visibility: style.visibility,
      width: rect.width,
      height: rect.height,
      encoded: el.classList.contains("mtsi-font-encoded"),
    };
  }, selector);
}

async function main() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();

  const win = new BrowserWindow({
    width: 1080,
    height: 1920,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "../preload.js"),
    },
  });

  const uiIndex = path.join(__dirname, "../ui/index.html");
  await win.loadFile(uiIndex, { query: { dataTrace: "1" } });

  await win.webContents.executeJavaScript(`
    window.overlay = window.overlay || {
      getConfig: async () => ({ apiBase: 'http://127.0.0.1:8765', pollIntervalMs: 2000 }),
      getOverlaySettings: async () => ({ bubble: { enabled: true, durationMs: 2000 } }),
      getSessionStatus: async () => ({}),
      getApiStatus: async () => ({ ready: true, apiBase: 'http://127.0.0.1:8765' }),
      ensureApi: async () => ({ ready: true, apiBase: 'http://127.0.0.1:8765' }),
      onSettingsChanged: () => {},
    };
  `);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const timeline = [];
  const selectors = ["#nation-box", "#champ-box", ".race-card[data-rank='1'] [data-metric='dailyBox'] .metric__value"];

  for (let i = 0; i < FRAMES; i++) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    const shot = path.join(OUT_DIR, `frame-${String(i).padStart(3, "0")}.png`);
    await win.webContents.capturePage().then((img) => fs.writeFileSync(shot, img.toPNG()));
    const regions = {};
    for (const sel of selectors) {
      regions[sel] = await probeRegion(win.webContents, sel);
    }
    const fonts = await win.webContents.executeJavaScript(`
      ({
        published: window.__fontPublished || null,
        ready: document.fonts ? document.fonts.status : 'unknown',
      })
    `);
    timeline.push({ t: Date.now(), frame: i, regions, fonts, screenshot: path.basename(shot) });
    process.stdout.write(`frame ${i}: nation="${regions["#nation-box"]?.text || ""}" champ="${regions["#champ-box"]?.text || ""}"\n`);
  }

  const outJson = path.join(OUT_DIR, `trace-${Date.now()}.json`);
  fs.writeFileSync(outJson, JSON.stringify({ timeline, frames: FRAMES, intervalMs: INTERVAL_MS }, null, 2));
  console.log(`trace written: ${outJson}`);
  await app.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
