/**
 * Electron 实机：预览 9:16 + liveOutput 1080×1920，禁止最大化拉宽
 * 诊断输出 innerSize / DPR / viewport rect / contentSize / capturePage（不改渲染）
 * node scripts/start-electron.js deploy/verify-window-aspect-electron.js
 */
const path = require("path");
const { app, BrowserWindow, Menu } = require("electron");
const { resolveWindowSize, ASPECT_RATIO } = require("../lib/window-size");

const ROOT = path.join(__dirname, "..");

function nearlyAspect(w, h) {
  return Math.abs(w / h - 1080 / 1920) < 0.015;
}

async function safeCapturePageSize(win) {
  try {
    if (typeof win.capturePage !== "function") return { ok: false, reason: "capturePage unavailable" };
    const image = await win.capturePage();
    if (!image || typeof image.getSize !== "function") {
      return { ok: false, reason: "capture image missing getSize" };
    }
    const size = image.getSize();
    const aspect = size.height > 0 ? size.width / size.height : null;
    return {
      ok: true,
      width: size.width,
      height: size.height,
      aspect,
      near9x16: size.height > 0 && Math.abs(aspect - 1080 / 1920) < 0.02,
    };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
}

async function openAndMeasure({ liveOutput, width, height }) {
  const size = resolveWindowSize(width, height, null, { liveOutput });
  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: liveOutput ? size.width : 360,
    minHeight: liveOutput ? size.height : 640,
    maxWidth: liveOutput ? size.width : undefined,
    maxHeight: liveOutput ? size.height : undefined,
    frame: false,
    autoHideMenuBar: true,
    title: "",
    show: true,
    useContentSize: true,
    resizable: !liveOutput,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#050a0b",
    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setContentSize(size.width, size.height);
  win.setAspectRatio(ASPECT_RATIO);
  win.setMaximizable(false);
  win.setResizable(!liveOutput);
  if (liveOutput) {
    win.setMaximumSize(size.width, size.height);
  }
  win.setMenu(null);
  win.setMenuBarVisibility(false);
  await win.loadFile(path.join(ROOT, "ui", "index.html"), {
    query: liveOutput ? { liveOutput: "1" } : {},
  });
  await new Promise((r) => setTimeout(r, 1500));

  const content = win.getContentSize();
  const metrics = await win.webContents.executeJavaScript(`(() => {
    const vp = document.getElementById("viewport");
    const rect = vp?.getBoundingClientRect();
    const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--viewport-scale")) || 1;
    const sideGap = Math.max(0, (window.innerWidth - (rect?.width || 0)) / 2);
    const bottomGap = Math.max(0, window.innerHeight - ((rect?.top || 0) + (rect?.height || 0)));
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      viewportRect: rect
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom }
        : null,
      viewportW: rect?.width || 0,
      viewportH: rect?.height || 0,
      scale,
      sideGap,
      bottomGap,
      className: vp?.className || "",
      letterboxHost: document.documentElement.classList.contains("viewport-host--letterbox"),
    };
  })()`);

  const capture = await safeCapturePageSize(win);

  const report = {
    liveOutput,
    resolved: size,
    contentSize: { width: content[0], height: content[1] },
    diagnostics: {
      innerWidth: metrics.innerWidth,
      innerHeight: metrics.innerHeight,
      devicePixelRatio: metrics.devicePixelRatio,
      viewportGetBoundingClientRect: metrics.viewportRect,
      browserWindowGetContentSize: { width: content[0], height: content[1] },
      capturePage: capture,
    },
    metrics,
    maximizable: win.isMaximizable(),
    resizable: win.isResizable(),
  };

  win.close();
  return report;
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  const preview = await openAndMeasure({ liveOutput: false, width: 540, height: 960 });
  const badSaved = resolveWindowSize(525, 1080, null, { liveOutput: false });
  const live = await openAndMeasure({ liveOutput: true, width: 525, height: 1080 });

  const report = {
    framed: false,
    applicationMenu: Menu.getApplicationMenu(),
    preview,
    badSaved,
    live,
    aspectLocked: ASPECT_RATIO,
  };

  console.log("[WINDOW_ASPECT_VERIFY]", JSON.stringify(report, null, 2));
  console.log("[WINDOW_ASPECT_DIAG]", JSON.stringify({
    preview: preview.diagnostics,
    live: live.diagnostics,
  }, null, 2));

  const liveCaptureOk =
    !live.diagnostics.capturePage.ok || live.diagnostics.capturePage.near9x16 === true;

  const ok =
    nearlyAspect(preview.contentSize.width, preview.contentSize.height) &&
    preview.contentSize.width === 540 &&
    preview.contentSize.height === 960 &&
    preview.metrics.sideGap < 2 &&
    preview.metrics.letterboxHost === false &&
    Math.abs(preview.metrics.viewportW / preview.metrics.viewportH - 1080 / 1920) < 0.02 &&
    badSaved.width === 540 &&
    badSaved.height === 960 &&
    live.contentSize.width === 1080 &&
    live.contentSize.height === 1920 &&
    live.resizable === false &&
    live.maximizable === false &&
    live.metrics.sideGap < 2 &&
    live.metrics.scale === 1 &&
    liveCaptureOk &&
    Menu.getApplicationMenu() == null;

  if (!ok) {
    console.error("[WINDOW_ASPECT_VERIFY] FAILED");
  } else {
    console.log("[WINDOW_ASPECT_VERIFY] OK");
  }

  app.exit(ok ? 0 : 2);
});
