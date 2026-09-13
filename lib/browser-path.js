const fs = require("fs");
const path = require("path");

function parseIni(text) {
  const sections = {};
  let section = "";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1].trim();
      if (!sections[section]) sections[section] = {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!section) continue;
    sections[section][key] = value;
  }
  return sections;
}

function readConfigFile(configFile) {
  if (!fs.existsSync(configFile)) {
    return { chromePath: "", port: 8765 };
  }
  const sections = parseIni(fs.readFileSync(configFile, "utf-8"));
  const browser = sections.browser || sections["浏览器"] || {};
  const server = sections.server || sections["服务"] || {};
  const chromePath = browser.path || browser["路径"] || "";
  const port = Number(server.port || server["端口"] || 8765) || 8765;
  return { chromePath: String(chromePath).trim(), port };
}

function ensureConfigTemplate(configFile) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  if (fs.existsSync(configFile)) return;
  fs.writeFileSync(
    configFile,
    `[browser]\npath=\n\n[server]\nport=8765\n`,
    "utf-8",
  );
}

function writeConfigFile(configFile, { chromePath, port = 8765 }) {
  ensureConfigTemplate(configFile);
  const current = readConfigFile(configFile);
  const nextPath = chromePath !== undefined ? chromePath : current.chromePath;
  const nextPort = port !== undefined ? port : current.port;
  fs.writeFileSync(
    configFile,
    `[browser]\npath=${nextPath}\n\n[server]\nport=${nextPort}\n`,
    "utf-8",
  );
}

function autoDetectChrome() {
  const local = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const candidates = [
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(local, "Google", "Chrome", "Bin", "chrome.exe"),
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
  ];

  // 注册表 App Paths（换机后常见安装路径）
  try {
    const { execSync } = require("child_process");
    const regKeys = [
      "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
      "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
      "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
    ];
    for (const key of regKeys) {
      try {
        const out = execSync(`reg query "${key}" /ve`, {
          encoding: "utf8",
          windowsHide: true,
          timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        const m = String(out).match(/REG_SZ\s+(.+\.exe)/i);
        if (m?.[1]) candidates.unshift(m[1].trim().replace(/^"|"$/g, ""));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  for (const candidate of candidates) {
    if (candidate && validateChromeExecutable(candidate)) return candidate;
  }
  return "";
}

function validateChromeExecutable(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    // Chrome 启动器 stub 大约 1–3MB，过小多半是坏文件/快捷方式残片
    if (!stat.isFile() || stat.size < 50 * 1024) return false;
  } catch {
    return false;
  }
  const base = path.basename(filePath).toLowerCase();
  // 接受 chrome.exe / Google Chrome.exe / chromium.exe
  return base.endsWith(".exe") && /chrome|chromium/i.test(base);
}

function resolveChromePath(dataDir) {
  const configFile = path.join(dataDir, "config.ini");
  const saved = readConfigFile(configFile).chromePath;
  if (saved && validateChromeExecutable(saved)) return saved;

  const env = String(process.env.MAOYAN_CHROME || "").trim();
  if (env && validateChromeExecutable(env)) return env;

  const detected = autoDetectChrome();
  if (detected) {
    // 自动探测成功则写入，换机后少弹选择框
    try {
      saveChromePath(dataDir, detected);
    } catch {
      /* ignore */
    }
    return detected;
  }
  return "";
}

function saveChromePath(dataDir, chromePath) {
  const configFile = path.join(dataDir, "config.ini");
  const current = readConfigFile(configFile);
  writeConfigFile(configFile, { chromePath, port: current.port });
}

function clearChromePath(dataDir) {
  saveChromePath(dataDir, "");
}

function isRecommendedChromePath(filePath) {
  const normalized = String(filePath || "").replace(/\//g, "\\").toLowerCase();
  // Bin / Application 都算官方 Google Chrome 安装树
  return (
    normalized.includes("\\google\\chrome\\") ||
    normalized.includes("\\chromium\\") ||
    /\\chrome\\application\\chrome\.exe$/i.test(normalized)
  );
}

async function pickChromeExecutable(parentWindow = null) {
  const { dialog, BrowserWindow } = require("electron");
  const parent =
    parentWindow && !parentWindow.isDestroyed()
      ? parentWindow
      : BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  const detected = autoDetectChrome();
  const defaultPath = detected
    ? path.dirname(detected)
    : "C:\\Program Files\\Google\\Chrome\\Application";

  const result = await dialog.showOpenDialog(parent, {
    title: "选择浏览器",
    message: "未找到 Google Chrome，请选择 chrome.exe",
    filters: [{ name: "Chrome 浏览器", extensions: ["exe"] }],
    properties: ["openFile"],
    defaultPath: fs.existsSync(defaultPath) ? defaultPath : undefined,
  });

  if (result.canceled || !result.filePaths?.length) return null;
  const picked = result.filePaths[0];
  if (!validateChromeExecutable(picked)) {
    await dialog.showMessageBox(parent, {
      type: "warning",
      title: "选择浏览器",
      message: "请选择 chrome.exe",
      detail:
        "请进入 Chrome 安装目录，选择名为 chrome.exe 的主程序（不要选快捷方式、卸载程序或其它 exe）。",
      buttons: ["确定"],
    });
    return null;
  }
  if (!isRecommendedChromePath(picked)) {
    const warn = await dialog.showMessageBox(parent, {
      type: "warning",
      title: "选择浏览器",
      message: "当前路径不像常见的 Chrome 安装目录",
      detail:
        `当前选择：${picked}\n\n常见路径示例：\nC:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\n%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe\n\n多数 Google Chrome 都可用。是否仍使用该路径？`,
      buttons: ["重新选择", "仍使用此路径"],
      defaultId: 1,
      cancelId: 0,
    });
    if (warn.response !== 1) return null;
  }
  return picked;
}

async function ensureChromePath(dataDir, options = {}) {
  const existing = resolveChromePath(dataDir);
  if (existing) return existing;

  const picked = await pickChromeExecutable(options.parentWindow);
  if (!picked) return null;

  saveChromePath(dataDir, picked);
  return picked;
}

module.exports = {
  autoDetectChrome,
  validateChromeExecutable,
  isRecommendedChromePath,
  resolveChromePath,
  saveChromePath,
  clearChromePath,
  ensureChromePath,
  pickChromeExecutable,
  readConfigFile,
  ensureConfigTemplate,
};
