const path = require("path");
const { BrowserWindow } = require("electron");
const { isPackagedApp } = require("./update/paths");
const { skipAutoUpdate } = require("./update/version");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calcProgressPercent(progress) {
  const phase = String(progress?.phase || "");
  const downloaded = Number(progress?.downloaded) || 0;
  const total = Number(progress?.total) || 0;

  if (phase === "checking") return 8;
  if (phase === "available") return 12;
  if (phase === "downloading" || phase === "verifying") {
    if (total > 0) return 12 + Math.floor((downloaded / total) * 78);
    return 20;
  }
  if (phase === "verified") return 92;
  if (phase === "applying") return 96;
  if (phase === "loading") return 90;
  if (phase === "starting") return 5;
  return 50;
}

const SPLASH_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;font-family:"Segoe UI","Microsoft YaHei",sans-serif;background:#050a0b;color:#f5f5f5;user-select:none}
.splash{display:flex;flex-direction:column;justify-content:center;gap:14px;width:100%;height:100%;padding:28px 32px 24px;background:radial-gradient(circle at 20% 0%,rgba(58,138,154,.18),transparent 42%),radial-gradient(circle at 80% 100%,rgba(255,90,90,.12),transparent 40%),#050a0b}
.splash__title{font-size:22px;font-weight:700;letter-spacing:.04em}
.splash__version{font-size:12px;color:rgba(255,255,255,.55)}
.splash__message{min-height:22px;font-size:14px;color:rgba(255,255,255,.88)}
.splash__bar-wrap{width:100%;height:8px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden}
.splash__bar{width:0%;height:100%;border-radius:inherit;background:linear-gradient(90deg,#3a8a9a 0%,#5ec4d8 55%,#ff6b6b 100%);transition:width .18s ease}
.splash__detail{min-height:16px;font-size:12px;color:rgba(255,255,255,.5)}
</style>
</head>
<body>
<div class="splash">
  <div class="splash__title">电影实时票房榜</div>
  <div class="splash__version" id="version">v--</div>
  <div class="splash__message" id="message">正在启动…</div>
  <div class="splash__bar-wrap" id="bar-wrap">
    <div class="splash__bar" id="bar"></div>
  </div>
  <div class="splash__detail" id="detail"></div>
</div>
<script>
function formatBytes(n){n=Number(n)||0;if(n>=1048576)return(n/1048576).toFixed(1)+" MB";if(n>=1024)return Math.floor(n/1024)+" KB";return n+" B"}
function applyProgress(payload){
  payload=payload||{};
  document.getElementById("message").textContent=String(payload.message||"正在启动…");
  const showBar=Boolean(payload.showBar)||["checking","available","downloading","verifying","applying"].includes(payload.phase);
  document.getElementById("bar-wrap").hidden=!showBar;
  document.getElementById("bar").style.width=Math.max(0,Math.min(100,Number(payload.percent)||0))+"%";
  const downloaded=Number(payload.downloaded)||0,total=Number(payload.total)||0,detail=document.getElementById("detail");
  if(showBar&&total>0)detail.textContent=formatBytes(downloaded)+" / "+formatBytes(total);
  else if(payload.detail)detail.textContent=String(payload.detail);
  else detail.textContent="";
}
window.splashApi?.onProgress?.(applyProgress);
window.splashApi?.getVersion?.().then(function(v){if(v)document.getElementById("version").textContent="v"+v});
applyProgress({message:"正在启动…",percent:3,showBar:true});
</script>
</body>
</html>`;

function createStartupSplash(appVersion = "") {
  const versionLabel = appVersion ? `v${appVersion}` : "v--";
  const html = SPLASH_HTML.replace(
    '<div class="splash__version" id="version">v--</div>',
    `<div class="splash__version" id="version">${versionLabel}</div>`,
  );

  const splashWindow = new BrowserWindow({
    width: 440,
    height: 240,
    frame: false,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: true,
    backgroundColor: "#050a0b",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload-splash.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  splashWindow.setMenuBarVisibility(false);
  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return splashWindow;
}

function createSplashController(splashWindow) {
  let pending = [];
  let ready = false;

  const flush = () => {
    if (!ready || !splashWindow || splashWindow.isDestroyed()) return;
    for (const payload of pending) {
      splashWindow.webContents.send("splash-progress", payload);
    }
    pending = [];
  };

  const send = (payload) => {
    if (!splashWindow || splashWindow.isDestroyed()) return;
    if (!ready) {
      pending.push(payload);
      return;
    }
    splashWindow.webContents.send("splash-progress", payload);
  };

  const markReady = () => {
    ready = true;
    flush();
  };

  const close = () => {
    pending = [];
    ready = false;
    if (!splashWindow || splashWindow.isDestroyed()) return;
    splashWindow.destroy();
  };

  return { send, close, markReady, window: splashWindow };
}

function bindSplashReady(splashWindow, controller) {
  if (!splashWindow || splashWindow.isDestroyed()) {
    controller.markReady();
    return;
  }
  const done = () => controller.markReady();
  if (splashWindow.webContents.isLoading()) {
    splashWindow.webContents.once("did-finish-load", done);
  } else {
    done();
  }
}

async function checkAndDownloadUpdate(updateManager, splash) {
  if (!isPackagedApp() || skipAutoUpdate() || !updateManager.updateCheckConfigured()) {
    splash.send({ phase: "loading", message: "正在进入主程序…", percent: 90, showBar: true });
    return false;
  }

  if (!updateManager.tryBeginJob()) {
    splash.send({ phase: "loading", message: "正在进入主程序…", percent: 90, showBar: true });
    return false;
  }

  let pollTimer = null;
  const startPolling = () => {
    pollTimer = setInterval(() => {
      const progress = updateManager.getProgress();
      splash.send({
        phase: progress.phase,
        message: progress.message,
        percent: calcProgressPercent(progress),
        downloaded: progress.downloaded,
        total: progress.total,
        showBar: true,
      });
    }, 120);
  };
  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  try {
    splash.send({ phase: "checking", message: "正在检查更新…", percent: 8, showBar: true });
    const info = await updateManager.check();
    if (!info?.updateAvailable) {
      updateManager.endJob();
      return false;
    }

    splash.send({
      phase: "available",
      message: "发现新版本，开始下载…",
      percent: 12,
      showBar: true,
      total: info.fileSize,
    });

    startPolling();
    await updateManager.downloadAndApply(info);
    return true;
  } catch (error) {
    stopPolling();
    updateManager.endJob();
    splash.send({
      phase: "warning",
      message: "更新未完成，正在进入主程序…",
      detail: error?.message || String(error),
      percent: 100,
      showBar: true,
    });
    await sleep(700);
    return false;
  } finally {
    stopPolling();
  }
}

module.exports = {
  createStartupSplash,
  createSplashController,
  checkAndDownloadUpdate,
  calcProgressPercent,
  bindSplashReady,
};
