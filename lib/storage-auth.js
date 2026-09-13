const fs = require("fs");

/** 仅与账号/会话身份相关的 Cookie 名（不含 csrf/uuid/mygsig 等设备追踪字段） */
const IDENTITY_COOKIE_HINTS =
  /passport|(^|[._-])token([._-]|$)|(^|[._-])sess([._-]|$)|(^|[._-])auth([._-]|$)|(^|[._-])user([._-]|$)|login/i;

/** 明确排除：不能用于判断“已登录” */
const NON_IDENTITY_COOKIE_HINTS = /^(csrf|uuid|mygsig|_lxsdk|Hm_|mt_|__mt)/i;

function getMaoyanCookies(state) {
  return (state?.cookies || []).filter(
    (cookie) =>
      String(cookie.domain || "").includes("maoyan.com") &&
      String(cookie.value || "").length > 0,
  );
}

function isIdentityCookie(name) {
  const n = String(name || "");
  if (!n || NON_IDENTITY_COOKIE_HINTS.test(n)) return false;
  return IDENTITY_COOKIE_HINTS.test(n);
}

function getIdentityCookies(state) {
  return getMaoyanCookies(state).filter((cookie) => isIdentityCookie(cookie.name));
}

/** 浏览器状态文件是否存在且含猫眼 Cookie（不代表已验证登录） */
function storageStateExists(state) {
  if (!state || typeof state !== "object") return false;
  return getMaoyanCookies(state).length > 0;
}

/** 文件级启发式：存在身份相关 Cookie（仍需浏览器内 API 验证才算 loginVerified） */
function storageStateLooksLoggedIn(state) {
  return getIdentityCookies(state).length > 0;
}

function readStorageStateSafe(filePath, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const text = fs.readFileSync(filePath, "utf-8");
      if (!text.trim()) return null;
      return JSON.parse(text);
    } catch {
      if (attempt + 1 >= retries) return null;
    }
  }
  return null;
}

function storageFileLooksLoggedIn(filePath) {
  const state = readStorageStateSafe(filePath);
  return storageStateLooksLoggedIn(state);
}

function storageFileExists(filePath) {
  const state = readStorageStateSafe(filePath);
  return storageStateExists(state);
}

/** 仅比较身份 Cookie，tracking Cookie 变化不触发 fresh login */
function loginFingerprint(state) {
  const cookies = getIdentityCookies(state).sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || "")),
  );
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("|");
}

function buildCookieHeaderFromState(state) {
  const cookies = getMaoyanCookies(state);
  if (!cookies.length) return "";
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function loadCookieHeaderFromFile(filePath) {
  const state = readStorageStateSafe(filePath);
  return buildCookieHeaderFromState(state);
}

module.exports = {
  IDENTITY_COOKIE_HINTS,
  NON_IDENTITY_COOKIE_HINTS,
  getMaoyanCookies,
  getIdentityCookies,
  isIdentityCookie,
  storageStateExists,
  storageStateLooksLoggedIn,
  loginFingerprint,
  readStorageStateSafe,
  storageFileLooksLoggedIn,
  storageFileExists,
  buildCookieHeaderFromState,
  loadCookieHeaderFromFile,
};
