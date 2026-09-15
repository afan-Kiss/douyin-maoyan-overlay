/**
 * 验证生产主窗口无边框 / 无菜单
 * node scripts/start-electron.js deploy/verify-frameless-window.js
 */
const path = require("path");
const { app, BrowserWindow, Menu } = require("electron");

const ROOT = path.join(__dirname, "..");

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  const win = new BrowserWindow({
    width: 540,
    height: 1080,
    frame: false,
    autoHideMenuBar: true,
    title: "",
    show: true,
    backgroundColor: "#050a0b",
    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.setMenu(null);
  await win.loadFile(path.join(ROOT, "ui", "index.html"));

  await new Promise((r) => setTimeout(r, 2500));

  const report = {
    applicationMenu: Menu.getApplicationMenu(),
    menuBarVisible: win.isMenuBarVisible(),
    title: win.getTitle(),
    bounds: win.getBounds(),
    contentBounds: win.getContentBounds(),
    // frame:false 时 content 与 bounds 宽高通常一致（无标题栏/边框占用）
    chromeExtraWidth: win.getBounds().width - win.getContentBounds().width,
    chromeExtraHeight: win.getBounds().height - win.getContentBounds().height,
    hasLoginBtn: await win.webContents.executeJavaScript(
      `Boolean(document.getElementById("btn-login"))`,
    ),
    titleDrag: await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector(".hero__title-row");
      return el ? getComputedStyle(el).webkitAppRegion : null;
    })()`),
    loginNoDrag: await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById("btn-login");
      return el ? getComputedStyle(el).webkitAppRegion : null;
    })()`),
  };

  console.log("[FRAMELESS_VERIFY]", JSON.stringify(report, null, 2));

  const ok =
    report.applicationMenu == null &&
    report.menuBarVisible === false &&
    report.chromeExtraWidth === 0 &&
    report.chromeExtraHeight === 0 &&
    report.titleDrag === "drag" &&
    report.loginNoDrag === "no-drag";

  win.close();
  app.exit(ok ? 0 : 2);
});
