const { storageStateLooksLoggedIn } = require("./storage-auth");

const VERIFY_MOVIE_ID = "1462628";

const DETAIL_VERIFY_PATH =
  `/i/api/movie/getBoxShow?movieId=${VERIFY_MOVIE_ID}&boxLevel=1&yodaReady=h5&csecplatform=4&csecversion=4.3.0`;

const DASHBOARD_VERIFY_URL =
  "https://piaofang.maoyan.com/i/api/dashboard-ajax/movie?orderType=0&channelId=40009&sVersion=2&WuKongReady=h5";

function unwrapPayload(raw) {
  return raw?.data?.data ?? raw?.data ?? raw;
}

function isHtmlResponse(text) {
  const sample = String(text || "").trim().slice(0, 300).toLowerCase();
  return sample.startsWith("<!doctype") || sample.startsWith("<html") || sample.includes("<title");
}

function isRiskResponse(text) {
  return /风控|验证|captcha|access denied|请先登录|security check/i.test(String(text || ""));
}

function isErrorJsonPayload(raw) {
  const inner = unwrapPayload(raw);
  if (!inner || typeof inner !== "object") return true;
  if (typeof inner.detail === "string" && inner.detail.trim()) {
    const msg = inner.detail.trim();
    if (/签名|不存在|失败|错误|超时|请刷新|请稍后再试|登录|风控/.test(msg)) {
      return true;
    }
  }
  if (typeof inner.code === "string" && /error|fail|denied|403|401/.test(inner.code)) {
    return true;
  }
  return false;
}

function validateDetailApiPayload(raw) {
  if (!raw || typeof raw !== "object") return false;
  if (isErrorJsonPayload(raw)) return false;
  const inner = unwrapPayload(raw);
  if (!inner || typeof inner !== "object") return false;
  return Boolean(
    inner.timeChartData ||
      inner.boxDatas ||
      inner.boxInfoDataRes ||
      inner.series ||
      inner.boxSummaryList,
  );
}

function validateDashboardPayload(raw) {
  if (!raw || typeof raw !== "object") return false;
  if (isErrorJsonPayload(raw)) return false;
  const list = raw?.movieList?.list ?? unwrapPayload(raw)?.movieList?.list;
  return Array.isArray(list) && list.length > 0;
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function evaluateFetchResult(result) {
  if (!result || typeof result !== "object") {
    return { ok: false, reason: "empty_response" };
  }
  if (result.status === 401) return { ok: false, reason: "login_required", status: 401 };
  if (result.status === 403) return { ok: false, reason: "upstream_403", status: 403 };
  if (!result.ok) return { ok: false, reason: `http_${result.status || 0}`, status: result.status || 0 };
  if (isHtmlResponse(result.text)) return { ok: false, reason: "login_html" };
  if (isRiskResponse(result.text)) return { ok: false, reason: "risk_page" };
  const data = parseJsonSafe(result.text);
  if (!data) return { ok: false, reason: "bad_json" };
  return { ok: true, data, status: result.status };
}

async function fetchVerifyInPage(page, absoluteUrl) {
  return page.evaluate(async (url) => {
    try {
      const resp = await fetch(url, { credentials: "include" });
      const text = await resp.text();
      return { ok: resp.ok, status: resp.status, text };
    } catch (error) {
      return { ok: false, status: 0, text: "", reason: String(error?.message || error) };
    }
  }, absoluteUrl);
}

/**
 * 在 Playwright 浏览器上下文中验证会话能力。
 * 不以大盘接口作为“已登录”依据；detail API (getBoxShow) 为核心能力验证。
 */
async function verifyCapabilitiesInContext(context, options = {}) {
  const movieId = String(options.movieId || VERIFY_MOVIE_ID);
  const detailUrl = options.detailUrl ||
    `https://piaofang.maoyan.com/i/api/movie/getBoxShow?movieId=${movieId}&boxLevel=1&yodaReady=h5&csecplatform=4&csecversion=4.3.0`;
  const dashboardUrl = options.dashboardUrl || DASHBOARD_VERIFY_URL;
  const checkDashboard = options.checkDashboard !== false;

  let page;
  let created = false;
  const empty = {
    storageStateExists: false,
    identityCookieExists: false,
    accountLoggedIn: false,
    browserSessionReady: false,
    browserSessionVerified: false,
    signatureReady: false,
    detailApiReady: false,
    dashboardAvailable: false,
    lastVerifyError: "verify_failed",
  };

  try {
    let state;
    try {
      state = await context.storageState();
    } catch {
      state = { cookies: [] };
    }

    const identityCookieExists = storageStateLooksLoggedIn(state);
    const storageStateExists = (state?.cookies || []).some((c) =>
      String(c.domain || "").includes("maoyan.com"),
    );

    const pages = context.pages();
    page = pages.length ? pages[0] : null;
    if (!page) {
      page = await context.newPage();
      created = true;
      await page.goto("https://piaofang.maoyan.com/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    }

    const detailRaw = await fetchVerifyInPage(page, detailUrl);
    const detailEval = evaluateFetchResult(detailRaw);
    const detailApiReady = detailEval.ok && validateDetailApiPayload(detailEval.data);

    let dashboardAvailable = false;
    if (checkDashboard) {
      const dashRaw = await fetchVerifyInPage(page, dashboardUrl);
      const dashEval = evaluateFetchResult(dashRaw);
      dashboardAvailable = dashEval.ok && validateDashboardPayload(dashEval.data);
    }

    const browserSessionVerified = detailApiReady;
    const signatureReady = detailApiReady;
    const browserSessionReady = detailApiReady || dashboardAvailable || identityCookieExists;
    const accountLoggedIn = identityCookieExists;
    const lastVerifyError = detailApiReady
      ? null
      : detailEval.reason || detailRaw?.reason || "detail_api_unavailable";

    return {
      storageStateExists,
      identityCookieExists,
      accountLoggedIn,
      browserSessionReady,
      browserSessionVerified,
      signatureReady,
      detailApiReady,
      dashboardAvailable,
      lastVerifyError,
    };
  } catch (error) {
    return {
      ...empty,
      lastVerifyError: String(error?.message || error || "verify_failed"),
    };
  } finally {
    if (created && page) {
      await page.close().catch(() => {});
    }
  }
}

/** @deprecated 使用 verifyCapabilitiesInContext */
async function verifyLoginInContext(context) {
  const result = await verifyCapabilitiesInContext(context);
  return result.detailApiReady === true;
}

module.exports = {
  VERIFY_MOVIE_ID,
  DETAIL_VERIFY_PATH,
  DASHBOARD_VERIFY_URL,
  unwrapPayload,
  isHtmlResponse,
  isRiskResponse,
  isErrorJsonPayload,
  validateDetailApiPayload,
  validateDashboardPayload,
  evaluateFetchResult,
  verifyCapabilitiesInContext,
  verifyLoginInContext,
};
