const fs = require("fs");

/** 强登录 Cookie：仅这些才视为已登录（btoken/logan 等登录页就会出现，不能用来判定） */
const STRONG_IDENTITY_COOKIE_NAMES =
  /^(passport_token|token|sessionid|sessionid_ss|access_token|refresh_token|userid|user_id|uid|lt|ssoid|sso|mss_token|edger_token)$/i;

/** 弱 Cookie：登录页也会下发，禁止当作已登录 */
const WEAK_LOGIN_COOKIE_NAMES =
  /^(btoken|passport_btoken|logan_session_token|ci|ci\.sig|iuuid|iuuid\.sig|WEBDFPID|utm_source_rg)$/i;

/** 兼容旧启发式（仅用于辅助，不单独判定登录） */
const IDENTITY_COOKIE_HINTS =
  /passport|(^|[._-])token([._-]|$)|(^|[._-])sess([._-]|$)|(^|[._-])auth([._-]|$)|(^|[._-])user([._-]|$)|login/i;

/** 明确排除：不能用于判断“已登录” */
const NON_IDENTITY_COOKIE_HINTS = /^(csrf|uuid|mygsig|_lxsdk|Hm_|mt_|__mt)/i;

/** 猫眼/美团登录链路会把身份 Cookie 写到这些域 */
function isAuthCookieDomain(domain) {
  const d = String(domain || "").toLowerCase();
  return d.includes("maoyan.com") || d.includes("meituan.com");
}

function getMaoyanCookies(state) {
  return (state?.cookies || []).filter(
    (cookie) => isAuthCookieDomain(cookie.domain) && String(cookie.value || "").length > 0,
  );
}

function isIdentityCookie(name) {
  const n = String(name || "");
  if (!n || NON_IDENTITY_COOKIE_HINTS.test(n)) return false;
  if (WEAK_LOGIN_COOKIE_NAMES.test(n)) return false;
  if (STRONG_IDENTITY_COOKIE_NAMES.test(n)) return true;
  // passport_* 但排除 btoken 系列
  if (/^passport_/i.test(n) && !/btoken/i.test(n)) return true;
  if (IDENTITY_COOKIE_HINTS.test(n) && !/btoken|logan/i.test(n)) return true;
  return false;
}

function getIdentityCookies(state) {
  return getMaoyanCookies(state).filter((cookie) => isIdentityCookie(cookie.name));
}

/** 浏览器状态文件是否存在且含猫眼 Cookie（不代表已验证登录） */
function storageStateExists(state) {
  if (!state || typeof state !== "object") return false;
  return getMaoyanCookies(state).length > 0;
}

/** 文件级启发式：存在强身份 Cookie（仍需浏览器内 API 验证才算可用） */
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

/** 把 Playwright cookies() 结果规范成 storageState JSON（避免调用 storageState 临时开标签） */
function cookiesToStorageState(cookies = []) {
  const list = Array.isArray(cookies) ? cookies : [];
  return {
    cookies: list.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      expires: typeof c.expires === "number" ? c.expires : -1,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: c.sameSite || "Lax",
    })),
    origins: [],
  };
}

/** 仅输出 Cookie 名（不含值），供登录诊断日志上传后台 */
function summarizeCookieNames(state, limit = 40) {
  const cookies = getMaoyanCookies(state);
  const names = [...new Set(cookies.map((c) => String(c.name || "")).filter(Boolean))];
  const identity = getIdentityCookies(state).map((c) => c.name);
  return {
    total: cookies.length,
    identityCount: identity.length,
    identityNames: identity.slice(0, 12),
    names: names.slice(0, limit),
  };
}

/**
 * 可落盘的登录态：必须有强身份 Cookie。
 * tracking / 设备指纹（_lxsdk、csrfToken 等）不能当成已登录，否则会误报登录成功，
 * 明日/后天等明细接口仍返回 login_required。
 * 若 detail API 已验证通过，由调用方另行允许落盘。
 */
function storageStateHasPersistableCookies(state) {
  return storageStateLooksLoggedIn(state);
}

module.exports = {
  IDENTITY_COOKIE_HINTS,
  NON_IDENTITY_COOKIE_HINTS,
  STRONG_IDENTITY_COOKIE_NAMES,
  WEAK_LOGIN_COOKIE_NAMES,
  isAuthCookieDomain,
  getMaoyanCookies,
  getIdentityCookies,
  isIdentityCookie,
  storageStateExists,
  storageStateLooksLoggedIn,
  storageStateHasPersistableCookies,
  summarizeCookieNames,
  loginFingerprint,
  readStorageStateSafe,
  storageFileLooksLoggedIn,
  storageFileExists,
  buildCookieHeaderFromState,
  loadCookieHeaderFromFile,
  cookiesToStorageState,
};
