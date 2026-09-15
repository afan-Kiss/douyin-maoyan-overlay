/**
 * Electron 实机：验证预览窗 9:16、无边框、无底部空白比例
 * node scripts/start-electron.js deploy/verify-window-aspect-electron.js
 */
const path = require("path");
const { app, BrowserWindow, Menu } = require("electron");
const { resolveWindowSize, ASPECT_RATIO } = require("../lib/window-size");

const ROOT = path.join(__dirname, "..");

function nearlyAspect(w, h) {
  return Math.abs(w / h - 1080 / 1920) < 0.015;
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  const size = resolveWindowSize(540, 960, null, { liveOutput: false });
  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: 360,
    minHeight: 640,
    frame: false,
    autoHideMenuBar: true,
    title: "",
    show: true,
    useContentSize: true,
    backgroundColor: "#050a0b",
    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setContentSize(size.width, size.height);
  win.setAspectRatio(ASPECT_RATIO);
  win.setMenu(null);
  win.setMenuBarVisibility(false);
  await win.loadFile(path.join(ROOT, "ui", "index.html"));
  await new Promise((r) => setTimeout(r, 2000));

  const content = win.getContentSize();
  const bounds = win.getBounds();
  const metrics = await win.webContents.executeJavaScript(`(() => {
    const vp = document.getElementById("viewport");
    const rect = vp?.getBoundingClientRect();
    const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--viewport-scale")) || 1;
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      viewportW: rect?.width || 0,
      viewportH: rect?.height || 0,
      scale,
      className: vp?.className || "",
    };
  })()`);

  // 错误输入 525×1080 应被归一
  const normalized = resolveWindowSize(525, 1080, null, { liveOutput: false });

  const report = {
    framed: false,
    menuBarVisible: win.isMenuBarVisible(),
    applicationMenu: Menu.getApplicationMenu(),
    resolved: size,
    contentSize: { width: content[0], height: content[1] },
    bounds: { width: bounds.width, height: bounds.height },
    metrics,
    normalized525: normalized,
    aspectLocked: ASPECT_RATIO,
  };

  console.log("[WINDOW_ASPECT_VERIFY]", JSON.stringify(report, null, 2));

  const ok =
    nearlyAspect(content[0], content[1]) &&
    nearlyAspect(size.width, size.height) &&
    size.width === 540 &&
    size.height === 960 &&
    normalized.width === 525 &&
    normalized.height === 933 &&
    Math.abs(metrics.viewportW / metrics.viewportH - 1080 / 1920) < 0.02 &&
    win.isMenuBarVisible() === false &&
    Menu.getApplicationMenu() == null;

  win.close();
  app.exit(ok ? 0 : 2);
});
