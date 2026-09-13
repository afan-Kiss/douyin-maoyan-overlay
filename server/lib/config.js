import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { getIniValue, parseIni } from "./ini.js";

const require = createRequire(import.meta.url);
const { loadCookieHeaderFromFile } = require("../../lib/storage-auth.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
export const DATA_DIR = process.env.MAOYAN_DATA_DIR || path.join(ROOT, "..", "data");

export const DIR = ROOT;
export const CONFIG_FILE = path.join(DATA_DIR, "config.ini");
export const COOKIE_FILE = path.join(DATA_DIR, "cookies.txt");
export const STORAGE_STATE = path.join(DATA_DIR, "browser_state.json");
/** sigManager 运行时 cookie 暂存；不得直接覆盖正式 browser_state.json */
export const STORAGE_RUNTIME_PENDING = path.join(DATA_DIR, "browser_state.runtime.pending.json");
export const SESSION_CACHE_DIR = path.join(DATA_DIR, "session_cache");

export const API_HOST = "0.0.0.0";
export const SIG_TTL_SECONDS = 25 * 60;
export const BROWSER_API_CACHE_TTL = 90;
export const DASHBOARD_CACHE_TTL = 5;
export const MAX_CACHE_ENTRIES = 50;
export const UPSTREAM_TIMEOUT_MS = 30000;

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

export const BOX_PAGE = (movieId) =>
  `https://piaofang.maoyan.com/i/imovie/${movieId}/box?barTheme=592828`;

let _configCache = null;
let _configMtime = 0;

export function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return { chromePath: "", port: 8765 };
    }
    const stat = fs.statSync(CONFIG_FILE);
    if (_configCache && stat.mtimeMs === _configMtime) {
      return _configCache;
    }
    const ini = parseIni(fs.readFileSync(CONFIG_FILE, "utf-8"));
    _configCache = {
      chromePath:
        getIniValue(ini, "browser", "path") ||
        getIniValue(ini, "浏览器", "路径"),
      port:
        Number(
          getIniValue(ini, "server", "port") ||
            getIniValue(ini, "服务", "端口", "8765")
        ) || 8765,
    };
    _configMtime = stat.mtimeMs;
    return _configCache;
  } catch {
    return { chromePath: "", port: 8765 };
  }
}

export function getApiPort() {
  return loadConfig().port;
}

function autoDetectChrome() {
  const local = process.env.LOCALAPPDATA || "";
  const list = [
    path.join(local, "Google", "Chrome", "Bin", "chrome.exe"),
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const p of list) {
    if (p && fs.existsSync(p)) return p;
  }
  return "";
}

export function getChromeExecutable() {
  const cfg = loadConfig();
  const manual = (cfg.chromePath || "").trim();
  if (manual && fs.existsSync(manual)) return manual;

  const env = (process.env.MAOYAN_CHROME || "").trim();
  if (env && fs.existsSync(env)) return env;

  return autoDetectChrome();
}

export function buildApiUrl(movieId, boxLevel) {
  const q = new URLSearchParams({
    movieId: String(movieId),
    boxLevel: String(boxLevel),
    yodaReady: "h5",
    csecplatform: "4",
    csecversion: "4.3.0",
  });
  return `https://piaofang.maoyan.com/i/api/movie/getBoxShow?${q}`;
}

export function sessionCachePath(movieId, boxLevel) {
  fs.mkdirSync(SESSION_CACHE_DIR, { recursive: true });
  return path.join(SESSION_CACHE_DIR, `${movieId}_${boxLevel}.json`);
}

export function wukongSessionCachePath(movieId, apiSlug) {
  fs.mkdirSync(SESSION_CACHE_DIR, { recursive: true });
  const safe = String(apiSlug).replace(/[^\w-]/g, "_");
  return path.join(SESSION_CACHE_DIR, `wukong_${movieId}_${safe}.json`);
}

export function parseCapturedAt(value) {
  if (!value) return 0;
  const t = Date.parse(String(value).replace("Z", "+00:00"));
  return Number.isFinite(t) ? t / 1000 : 0;
}

export function parseCookies(text) {
  const cookies = [];
  for (const part of text.split(";")) {
    const s = part.trim();
    if (!s || !s.includes("=")) continue;
    const i = s.indexOf("=");
    cookies.push({
      name: s.slice(0, i).trim(),
      value: s.slice(i + 1).trim(),
      domain: ".maoyan.com",
      path: "/",
    });
  }
  return cookies;
}

export function randomTraceId() {
  const n = Math.floor(Math.random() * 9e17) + 1e15;
  return String(-n);
}

export function loadCookieHeader() {
  return loadCookieHeaderFromFile(STORAGE_STATE);
}

export function ensureConfigTemplate() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_FILE)) return;
  const template = `[browser]
path=

[server]
port=8765
`;
  try {
    fs.writeFileSync(CONFIG_FILE, template, "utf-8");
  } catch {
    /* noop */
  }
}
