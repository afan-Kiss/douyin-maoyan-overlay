const { storageStateLooksLoggedIn } = require("./storage-auth");

/** 仅 dashboard 整体失败时使用的兜底 movieId，必须显式记录 verifySource=fallback */
const FALLBACK_VERIFY_MOVIE_ID = "1462628";

const DASHBOARD_VERIFY_URL =
  "https://piaofang.maoyan.com/i/api/dashboard-ajax/movie?orderType=0&channelId=40009&sVersion=2&WuKongReady=h5";

const BOX_PAGE = (movieId) =>
  `https://piaofang.maoyan.com/i/imovie/${movieId}/box?barTheme=592828`;

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

function extractMtgsigFromRequest(reqLike) {
  if (!reqLike) return null;
  const headers = reqLike.headers || reqLike;
  if (headers.mtgsig) {
    return { headers: { ...headers }, source: "request_header" };
  }
  const url = reqLike.url || "";
  try {
    const q = new URL(url, "https://piaofang.maoyan.com").searchParams.get("mtgsig");
    if (q) {
      return { headers: { ...headers, mtgsig: q }, source: "request_query" };
    }
  } catch {
    /* noop */
  }
  return null;
}

function pickVerifyMovieFromDashboard(raw) {
  const list = raw?.movieList?.list ?? unwrapPayload(raw)?.movieList?.list;
  if (!Array.isArray(list) || !list.length) return null;

  for (let i = 0; i < Math.min(3, list.length); i++) {
    const item = list[i];
    const movieId = item?.movieId ?? item?.id ?? item?.movieInfo?.movieId;
    if (movieId) {
      const movieName = item?.movieName || item?.name || item?.movieInfo?.movieName || null;
      return {
        verifyMovieId: String(movieId),
        verifyMovieName: movieName ? String(movieName) : null,
        verifySource: "dashboard-current-movie",
        rank: i + 1,
      };
    }
  }
  return null;
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

async function fetchDashboardInPage(page, dashboardUrl) {
  let captured = null;
  const onResponse = async (resp) => {
    const url = resp.url();
    if (!url.includes("dashboard-ajax/movie")) return;
    try {
      const text = await resp.text();
      captured = parseJsonSafe(text);
    } catch {
      captured = null;
    }
  };

  page.on("response", onResponse);
  try {
    const dashRaw = await fetchVerifyInPage(page, dashboardUrl);
    const dashEval = evaluateFetchResult(dashRaw);
    if (dashEval.ok && validateDashboardPayload(dashEval.data)) {
      return { ok: true, data: dashEval.data };
    }

    await page.goto("https://piaofang.maoyan.com/dashboard", {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await page.waitForTimeout(2000);

    if (captured && validateDashboardPayload(captured)) {
      return { ok: true, data: captured };
    }

    return {
      ok: false,
      reason: dashEval.reason || "dashboard_unavailable",
      status: dashEval.status || dashRaw?.status || 0,
    };
  } finally {
    page.off("response", onResponse);
  }
}

function matchesGetBoxShowRequest(url, movieId, boxLevel = "1") {
  try {
    const u = new URL(url, "https://piaofang.maoyan.com");
    if (!u.pathname.includes("getBoxShow")) return false;
    return (
      u.searchParams.get("movieId") === String(movieId) &&
      u.searchParams.get("boxLevel") === String(boxLevel)
    );
  } catch {
    return false;
  }
}

/**
 * 在票房页监听真实 getBoxShow 请求/响应，确认 mtgsig 与 payload。
 */
async function verifyDetailOnBoxPage(page, movieId, boxLevel = "1") {
  const captured = {
    headers: null,
    url: null,
    httpStatus: 0,
    payload: null,
    signatureSource: null,
    responseSeen: false,
  };
  let boxPageLoaded = false;

  const rememberRequest = (req) => {
    if (req.method() !== "GET") return;
    const url = req.url();
    if (!matchesGetBoxShowRequest(url, movieId, boxLevel)) return;
    const got = extractMtgsigFromRequest(req);
    if (got?.headers?.mtgsig) {
      captured.headers = got.headers;
      captured.url = url;
      captured.signatureSource = got.source;
    }
  };

  const onResponse = async (resp) => {
    const url = resp.url();
    if (!matchesGetBoxShowRequest(url, movieId, boxLevel)) return;
    captured.responseSeen = true;
    captured.httpStatus = resp.status();
    rememberRequest(resp.request());
    try {
      const text = await resp.text();
      captured.payload = parseJsonSafe(text);
    } catch {
      captured.payload = null;
    }
  };

  page.on("request", rememberRequest);
  page.on("response", onResponse);

  try {
    try {
      const onBox = await page.evaluate(() => location.hostname.includes("piaofang"));
      if (!onBox) {
        await page.goto("https://piaofang.maoyan.com/dashboard", {
          waitUntil: "domcontentloaded",
          timeout: 90000,
        });
        await page.waitForTimeout(1000);
      }
    } catch {
      /* noop */
    }

    await page.goto(BOX_PAGE(movieId), { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(800);

    try {
      boxPageLoaded = await page.evaluate(
        (id) =>
          location.hostname.includes("piaofang") &&
          (location.pathname.includes(`/imovie/${id}/box`) || location.pathname.includes("/box")),
        movieId,
      );
    } catch {
      boxPageLoaded = false;
    }

    for (let i = 0; i < 4 && !captured.headers?.mtgsig; i++) {
      if (i > 0) await page.waitForTimeout(1200);
    }

    const signatureCaptured = Boolean(captured.headers?.mtgsig);
    const detailHttpStatus = captured.httpStatus || 0;
    const detailPayloadValid = validateDetailApiPayload(captured.payload);
    const httpOk = detailHttpStatus >= 200 && detailHttpStatus < 300;
    const detailApiReady = signatureCaptured && httpOk && detailPayloadValid;

    let lastVerifyError = null;
    if (!boxPageLoaded) lastVerifyError = "box_page_not_loaded";
    else if (!captured.responseSeen) lastVerifyError = "getboxshow_request_not_seen";
    else if (!signatureCaptured) lastVerifyError = "mtgsig_not_captured";
    else if (!httpOk) {
      lastVerifyError =
        detailHttpStatus === 401
          ? "detail_http_401"
          : detailHttpStatus === 403
            ? "detail_http_403"
            : `detail_http_${detailHttpStatus}`;
    } else if (!detailPayloadValid) lastVerifyError = "detail_payload_invalid";

    return {
      boxPageLoaded,
      getBoxShowRequestSeen: captured.responseSeen,
      signatureCaptured,
      signatureSource: captured.signatureSource,
      detailHttpStatus,
      detailPayloadValid,
      detailApiReady,
      lastVerifyError,
    };
  } finally {
    page.off("request", rememberRequest);
    page.off("response", onResponse);
  }
}

/**
 * 在 Playwright 浏览器上下文中验证会话能力。
 * dashboard 仅判断大盘可访问；detail API 为核心能力验证（真实 mtgsig 请求）。
 */
async function verifyCapabilitiesInContext(context, options = {}) {
  const dashboardUrl = options.dashboardUrl || DASHBOARD_VERIFY_URL;
  const checkDashboard = options.checkDashboard !== false;
  const boxLevel = String(options.boxLevel || "1");

  let page;
  let created = false;
  const empty = {
    storageStateExists: false,
    identityCookieExists: false,
    loginCookieReady: false,
    productionDetailReady: false,
    loginRequired: false,
    accountLoggedIn: false,
    sessionUsable: false,
    browserSessionReady: false,
    browserSessionVerified: false,
    signatureReady: false,
    detailApiReady: false,
    dashboardAvailable: false,
    verifyMovieId: null,
    verifyMovieName: null,
    verifySource: null,
    signatureCaptured: false,
    signatureSource: null,
    detailHttpStatus: null,
    detailPayloadValid: false,
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
    }

    let dashboardAvailable = false;
    let verifyPick = null;

    if (options.dashboardData && validateDashboardPayload(options.dashboardData)) {
      dashboardAvailable = true;
      verifyPick = pickVerifyMovieFromDashboard(options.dashboardData);
    } else if (checkDashboard) {
      const dashResult = await fetchDashboardInPage(page, dashboardUrl);
      dashboardAvailable = dashResult.ok === true;
      if (dashboardAvailable) {
        verifyPick = pickVerifyMovieFromDashboard(dashResult.data);
      }
    }

    if (options.movieId) {
      verifyPick = {
        verifyMovieId: String(options.movieId),
        verifyMovieName: options.verifyMovieName || null,
        verifySource: options.verifySource || "dashboard-current-movie",
      };
    }

    const verifyMovieId = String(verifyPick?.verifyMovieId || FALLBACK_VERIFY_MOVIE_ID);
    const verifyMovieName = verifyPick?.verifyMovieName || options.verifyMovieName || null;
    const verifySource = options.verifySource || (verifyPick ? verifyPick.verifySource : "fallback");

    const detailResult = await verifyDetailOnBoxPage(page, verifyMovieId, boxLevel);

    const detailApiReady = detailResult.detailApiReady === true;
    const signatureCaptured = detailResult.signatureCaptured === true;
    const browserSessionVerified = detailApiReady;
    const signatureReady = signatureCaptured;
    const browserSessionReady = detailApiReady || dashboardAvailable || identityCookieExists;
    const loginRequired =
      detailResult.lastVerifyError === "detail_http_401" ||
      detailResult.lastVerifyError === "login_required";
    const loginCookieReady = identityCookieExists;
    const productionDetailReady = detailApiReady;
    const sessionUsable = Boolean(identityCookieExists && detailApiReady && !loginRequired);
    const accountLoggedIn = identityCookieExists;

    return {
      storageStateExists,
      identityCookieExists,
      loginCookieReady,
      productionDetailReady,
      loginRequired,
      accountLoggedIn,
      sessionUsable,
      browserSessionReady,
      browserSessionVerified,
      signatureReady,
      detailApiReady,
      dashboardAvailable,
      verifyMovieId,
      verifyMovieName,
      verifySource,
      boxPageLoaded: detailResult.boxPageLoaded,
      getBoxShowRequestSeen: detailResult.getBoxShowRequestSeen,
      signatureCaptured: detailResult.signatureCaptured,
      signatureSource: detailResult.signatureSource,
      detailHttpStatus: detailResult.detailHttpStatus,
      detailPayloadValid: detailResult.detailPayloadValid,
      lastVerifyError: detailApiReady ? null : detailResult.lastVerifyError || "detail_api_unavailable",
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
  FALLBACK_VERIFY_MOVIE_ID,
  DASHBOARD_VERIFY_URL,
  BOX_PAGE,
  matchesGetBoxShowRequest,
  unwrapPayload,
  isHtmlResponse,
  isRiskResponse,
  isErrorJsonPayload,
  validateDetailApiPayload,
  validateDashboardPayload,
  evaluateFetchResult,
  pickVerifyMovieFromDashboard,
  fetchDashboardInPage,
  verifyDetailOnBoxPage,
  verifyCapabilitiesInContext,
  verifyLoginInContext,
};
