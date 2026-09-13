/**
 * Electron 实际窗口 capturePage 像素验证：
 * node deploy/test-electron-capture.js
 */
const path = require("path");
const fs = require("fs");
const { app, BrowserWindow } = require("electron");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "ui");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureMode({ width, height, liveOutput, outName }) {
  const win = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: 1,
    },
  });

  win.setContentSize(width, height);
  await win.loadFile(path.join(ROOT, "ui", "index.html"), {
    query: { preview: "1", liveOutput: liveOutput ? "1" : "0" },
  });
  await delay(1200);

  const metrics = await win.webContents.executeJavaScript(`(() => {
    const viewport = document.getElementById("viewport");
    const rect = viewport?.getBoundingClientRect();
    const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--viewport-scale")) || 1;
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      viewportCssWidth: rect?.width || 0,
      viewportCssHeight: rect?.height || 0,
      viewportScale: scale,
      viewportClass: viewport?.className || "",
      devicePixelRatio: window.devicePixelRatio,
    };
  })()`);

  const image = await win.webContents.capturePage();
  const size = image.getSize();
  const pngPath = path.join(OUT_DIR, outName);
  fs.writeFileSync(pngPath, image.toPNG());
  await win.close();

  return {
    mode: liveOutput ? "live-output" : "desktop-preview",
    electronContentSize: { width, height },
    capturePagePng: { width: size.width, height: size.height },
    deviceScaleFactor: metrics.devicePixelRatio,
    viewportCss: {
      width: metrics.viewportCssWidth,
      height: metrics.viewportCssHeight,
      scale: metrics.viewportScale,
      className: metrics.viewportClass,
    },
    windowInner: { width: metrics.innerWidth, height: metrics.innerHeight },
    pngPath,
  };
}

app.whenReady().then(async () => {
  try {
    const preview = await captureMode({
      width: 540,
      height: 960,
      liveOutput: false,
      outName: "electron-capture-preview-540x960.png",
    });
    const live = await captureMode({
      width: 1080,
      height: 1920,
      liveOutput: true,
      outName: "electron-capture-live-1080x1920.png",
    });

    const report = { preview, live };
    console.log(JSON.stringify(report, null, 2));

    const liveNative =
      live.capturePagePng.width >= 1080 &&
      live.capturePagePng.height >= 1920 &&
      live.viewportCss.width >= 1070 &&
      live.viewportCss.height >= 1910;

    if (!liveNative) {
      console.error("Live output capture is not native 1080x1920");
      app.exit(1);
      return;
    }

    console.log("Electron capture test OK");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
