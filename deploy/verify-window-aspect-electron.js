/**
 * Electron 实机：预览 9:16 + liveOutput 1080×1920，禁止最大化拉宽
 * node scripts/start-electron.js deploy/verify-window-aspect-electron.js
 */
const path = require("path");
const { app, BrowserWindow, Menu } = require("electron");
const { resolveWindowSize, ASPECT_RATIO } = require("../lib/window-size");

const ROOT = path.join(__dirname, "..");

function nearlyAspect(w, h) {
  return Math.abs(w / h - 1080 / 1920) < 0.015;
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
  await win.loadFile(path.join(ROOT, "ui", "index.html"));
  await new Promise((r) => setTimeout(r, 1500));

  const content = win.getContentSize();
  const metrics = await win.webContents.executeJavaScript(`(() => {
    const vp = document.getElementById("viewport");
    const rect = vp?.getBoundingClientRect();
    const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--viewport-scale")) || 1;
    const sideGap = Math.max(0, (window.innerWidth - (rect?.width || 0)) / 2);
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      viewportW: rect?.width || 0,
      viewportH: rect?.height || 0,
      scale,
      sideGap,
      className: vp?.className || "",
      letterboxHost: document.documentElement.classList.contains("viewport-host--letterbox"),
    };
  })()`);

  const report = {
    liveOutput,
    resolved: size,
    contentSize: { width: content[0], height: content[1] },
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
    Menu.getApplicationMenu() == null;

  app.exit(ok ? 0 : 2);
});
