const { chromium } = require("playwright");
const { storageStateLooksLoggedIn } = require("./storage-auth");
const { resolveChromePath } = require("./browser-path");
const { buildLoginWarmApiUrls } = require("./maoyan-sign");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

/** 仅 dashboard 整体失败时使用的兜底 movieId，必须显式记录 verifySource=fallback */
const FALLBACK_VERIFY_MOVIE_ID = "1462628";

const DASHBOARD_VERIFY_URL =
  "https://piaofang.maoyan.com/i/api/dashboard-ajax/movie?orderType=0&channelId=40009&sVersion=2&WuKongReady=h5";

const BOX_PAGE = (movieId) =>
  `https://piaofang.maoyan.com/i/imovie/${movieId}/box?barTheme=592828`;

/** 页面被重定向到猫眼/美团登录页 */
function isMaoyanLoginRedirect(host, path) {
  const h = String(host || "").toLowerCase();
  const p = String(path || "").toLowerCase();
  return (
    h.includes("passport.maoyan.com") ||
    h.includes("passport.meituan.com") ||
    h.includes("openid.meituan.com") ||
    h.includes("auth.meituan.com") ||
    /\/(login|blogin|signin|userlogin|oauth|authorize)(\/|$|\?)/i.test(p)
  );
}

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

async function fetchDashboardInPage(page, dashboardUrl, options = {}) {
  const noNavigation = options.noNavigation === true;
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

    if (noNavigation) {
      return {
        ok: false,
        reason: dashEval.reason || "dashboard_unavailable",
        status: dashEval.status || dashRaw?.status || 0,
      };
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
    if (!/getBoxShow/i.test(u.pathname)) return false;
    if (movieId) {
      const mid = u.searchParams.get("movieId");
      if (mid && mid !== String(movieId)) return false;
    }
    if (boxLevel != null && boxLevel !== "") {
      const bl = u.searchParams.get("boxLevel");
      // 页面偶发不带 boxLevel 或带其它档，只要是 getBoxShow 就先收下签名
      if (bl && bl !== String(boxLevel) && String(boxLevel) !== "*") {
        /* still accept — login capture should not drop signed traffic */
      }
    }
    return true;
  } catch {
    return false;
  }
}

function movieIdFromBoxPath(path) {
  const m = String(path || "").match(/\/imovie\/(\d+)(?:\/box)?/i);
  return m ? m[1] : null;
}

function extractMtgsigLoose(headers, url) {
  const h = headers || {};
  const direct =
    h.mtgsig ||
    h.Mtgsig ||
    h.MtgSig ||
    h["mtg-sig"] ||
    "";
  if (direct) return { headers: { ...h, mtgsig: direct }, source: "request_header" };
  try {
    const q = new URL(url || "", "https://piaofang.maoyan.com").searchParams.get("mtgsig");
    if (q) return { headers: { ...h, mtgsig: q }, source: "request_query" };
  } catch {
    /* noop */
  }
  return null;
}

/**
 * 在票房页监听真实 getBoxShow 请求/响应，确认 mtgsig 与 payload。
 * options.noNavigation=true 时不跳转页面，仅在当前页用 fetch 探测。
 * options.allowSoftReload=true 时允许 reload/同页 goto 以挂上监听后再抓自然请求。
 */
async function verifyDetailOnBoxPage(page, movieId, boxLevel = "1", options = {}) {
  const noNavigation = options.noNavigation === true;
  const allowSoftReload = options.allowSoftReload === true;
  const wantMovieId = String(movieId || FALLBACK_VERIFY_MOVIE_ID);
  const captured = {
    headers: null,
    url: null,
    httpStatus: 0,
    payload: null,
    signatureSource: null,
    responseSeen: false,
  };
  /** slug -> { headers, url }：登录时一并缓存预测/下映等签名 */
  const apiSignatures = {};
  let boxPageLoaded = false;
  let softReloaded = false;

  const acceptRequest = (req) => {
    try {
      if (req.method() !== "GET") return;
      const url = req.url();
      if (!/piaofang\.maoyan\.com/i.test(url) || !/\/i\/api\//i.test(url)) return;
      const got = extractMtgsigLoose(req.headers(), url);
      if (!got?.headers?.mtgsig) return;

      const slugMatch = String(url).match(/\/i\/api\/movie\/([^/?#]+)/i);
      if (slugMatch?.[1]) {
        apiSignatures[slugMatch[1]] = {
          headers: { ...got.headers },
          url: got.url || url,
        };
      }

      // 任意带 mtgsig 的票房 API 都记签名；getBoxShow 优先用于 payload
      const isBoxShow = /getBoxShow/i.test(url);
      if (!captured.headers?.mtgsig || isBoxShow) {
        captured.headers = got.headers;
        captured.url = url;
        captured.signatureSource = got.source + (isBoxShow ? "+boxshow" : "+api");
      }
    } catch {
      /* ignore */
    }
  };

  const onResponse = async (resp) => {
    try {
      const url = resp.url();
      if (!/getBoxShow/i.test(url)) {
        acceptRequest(resp.request());
        return;
      }
      captured.responseSeen = true;
      captured.httpStatus = resp.status();
      acceptRequest(resp.request());
      try {
        const text = await resp.text();
        const data = parseJsonSafe(text);
        if (validateDetailApiPayload(data)) {
          captured.payload = data;
        } else if (!captured.payload) {
          captured.payload = data;
        }
      } catch {
        /* body may be consumed */
      }
    } catch {
      /* ignore */
    }
  };

  const getBoxShowPath = (id) =>
    `/i/api/movie/getBoxShow?movieId=${id}&boxLevel=${boxLevel}&yodaReady=h5&csecplatform=4&csecversion=4.3.0`;

  const tryCaptureFromPerformance = async (id) => {
    try {
      const found = await page.evaluate((wantId) => {
        const entries = performance.getEntriesByType("resource") || [];
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const name = entries[i]?.name || "";
          if (!name.includes("getBoxShow") && !name.includes("/i/api/movie/")) continue;
          try {
            const u = new URL(name);
            if (wantId && name.includes("getBoxShow")) {
              const mid = u.searchParams.get("movieId");
              if (mid && mid !== String(wantId)) continue;
            }
            const mtgsig = u.searchParams.get("mtgsig");
            if (mtgsig) return { url: name, mtgsig, boxShow: name.includes("getBoxShow") };
          } catch {
            /* ignore */
          }
        }
        return null;
      }, String(id));
      if (found?.mtgsig) {
        if (!captured.headers?.mtgsig || found.boxShow) {
          captured.headers = { ...(captured.headers || {}), mtgsig: found.mtgsig };
          captured.url = found.url;
          captured.signatureSource = captured.signatureSource || "performance_resource";
        }
        return true;
      }
    } catch {
      /* page may be navigating */
    }
    return false;
  };

  const triggerSignedFetches = async (id) => {
    const mid = String(id || wantMovieId);
    const urls = [
      getBoxShowPath(mid),
      ...buildLoginWarmApiUrls(mid),
      DASHBOARD_VERIFY_URL,
    ];
    try {
      await page.evaluate(async (list) => {
        for (const url of list) {
          try {
            await fetch(url, { credentials: "include" });
          } catch {
            /* noop */
          }
        }
      }, urls);
    } catch {
      /* page may be navigating */
    }
  };

  page.on("request", acceptRequest);
  page.on("response", onResponse);

  try {
    let pageLocation = { host: "", path: "" };
    try {
      pageLocation = await page.evaluate(() => ({
        host: location.hostname,
        path: location.pathname,
      }));
    } catch {
      pageLocation = { host: "", path: "" };
    }

    if (isMaoyanLoginRedirect(pageLocation.host, pageLocation.path)) {
      return {
        boxPageLoaded: false,
        redirectedToLogin: true,
        getBoxShowRequestSeen: false,
        signatureCaptured: false,
        signatureSource: null,
        detailHttpStatus: 0,
        detailPayloadValid: false,
        detailApiReady: false,
        loginRequired: true,
        lastVerifyError: "login_required",
        softReloaded: false,
        verifyMovieId: wantMovieId,
      };
    }

    const pageMovieId = movieIdFromBoxPath(pageLocation.path) || wantMovieId;
    const alreadyOnBox =
      pageLocation.host.includes("piaofang") &&
      (/\/imovie\/\d+\/box/i.test(pageLocation.path) || /\/box/i.test(pageLocation.path));

    if (!noNavigation) {
      try {
        const onBox = pageLocation.host.includes("piaofang");
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

      if (!alreadyOnBox) {
        await page.goto(BOX_PAGE(pageMovieId), { waitUntil: "domcontentloaded", timeout: 90000 });
        await page.waitForTimeout(1200);
      }

      try {
        pageLocation = await page.evaluate(() => ({
          host: location.hostname,
          path: location.pathname,
        }));
        boxPageLoaded =
          pageLocation.host.includes("piaofang") &&
          (/\/imovie\/\d+\/box/i.test(pageLocation.path) || /\/box/i.test(pageLocation.path));
      } catch {
        boxPageLoaded = false;
      }
    } else {
      boxPageLoaded = alreadyOnBox || pageLocation.host.includes("piaofang");
    }

    const redirectedToLogin = isMaoyanLoginRedirect(pageLocation.host, pageLocation.path);
    const activeMovieId = movieIdFromBoxPath(pageLocation.path) || pageMovieId || wantMovieId;

    await tryCaptureFromPerformance(activeMovieId);

    // 先等自然请求，再主动触发（对齐 sigManager）
    for (let i = 0; i < 5 && !captured.headers?.mtgsig; i++) {
      if (i > 0) await page.waitForTimeout(700);
      await triggerSignedFetches(activeMovieId);
      await tryCaptureFromPerformance(activeMovieId);
      if (captured.headers?.mtgsig) break;
    }

    // 已有 getBoxShow 后，再补抓一轮预测/下映签名
    if (captured.headers?.mtgsig) {
      const need =
        !apiSignatures.getPredictionBox?.headers?.mtgsig ||
        !apiSignatures.getTechData?.headers?.mtgsig;
      if (need) {
        await triggerSignedFetches(activeMovieId);
        for (let w = 0; w < 4; w++) {
          if (
            apiSignatures.getPredictionBox?.headers?.mtgsig &&
            apiSignatures.getTechData?.headers?.mtgsig
          ) {
            break;
          }
          await page.waitForTimeout(400);
        }
      }
    }

    // 监听挂上后再 reload/同 URL goto，抓页面自然签名请求
    if (allowSoftReload && alreadyOnBox && !captured.headers?.mtgsig && !redirectedToLogin) {
      softReloaded = true;
      try {
        const href = BOX_PAGE(activeMovieId);
        await page.goto(href, { waitUntil: "domcontentloaded", timeout: 90000 });
        await page.waitForTimeout(1800);
        await tryCaptureFromPerformance(activeMovieId);
        for (let i = 0; i < 4 && !captured.headers?.mtgsig; i++) {
          if (i > 0) await page.waitForTimeout(600);
          await triggerSignedFetches(activeMovieId);
          await tryCaptureFromPerformance(activeMovieId);
        }
        // 再等一会自然请求 + 扩展签名
        for (let w = 0; w < 4 && !captured.headers?.mtgsig; w++) {
          await page.waitForTimeout(500);
        }
        if (captured.headers?.mtgsig) {
          await triggerSignedFetches(activeMovieId);
          for (let w = 0; w < 4; w++) {
            if (
              apiSignatures.getPredictionBox?.headers?.mtgsig &&
              apiSignatures.getTechData?.headers?.mtgsig
            ) {
              break;
            }
            await page.waitForTimeout(400);
          }
        }
        boxPageLoaded = true;
      } catch {
        /* reload failed */
      }
    }

    const signatureCaptured = Boolean(captured.headers?.mtgsig);
    let detailHttpStatus = captured.httpStatus || 0;
    let detailPayloadValid = validateDetailApiPayload(captured.payload);
    let httpOk = detailHttpStatus >= 200 && detailHttpStatus < 300;
    let detailApiReady = signatureCaptured && httpOk && detailPayloadValid;

    let lastVerifyError = null;
    if (redirectedToLogin) lastVerifyError = "login_required";
    else if (!boxPageLoaded && noNavigation) lastVerifyError = "waiting_box_page";
    else if (!boxPageLoaded) lastVerifyError = "box_page_not_loaded";
    else if (!captured.responseSeen && !signatureCaptured) lastVerifyError = "getboxshow_request_not_seen";
    else if (!signatureCaptured) lastVerifyError = "mtgsig_not_captured";
    else if (!httpOk) {
      lastVerifyError =
        detailHttpStatus === 401
          ? "detail_http_401"
          : detailHttpStatus === 403
            ? "detail_http_403"
            : `detail_http_${detailHttpStatus || 0}`;
    } else if (!detailPayloadValid) lastVerifyError = "detail_payload_invalid";

    // 有签名但缺 payload：用已捕获 URL / 默认 path 再探一次
    if (signatureCaptured && !detailApiReady && captured.headers?.mtgsig) {
      try {
        const signedUrl = captured.url || getBoxShowPath(activeMovieId);
        const probe = await page.evaluate(async (url) => {
          try {
            const resp = await fetch(url, { credentials: "include" });
            const text = await resp.text();
            return { ok: resp.ok, status: resp.status, text };
          } catch (error) {
            return { ok: false, status: 0, text: "", reason: String(error?.message || error) };
          }
        }, signedUrl);
        const evaled = evaluateFetchResult(probe);
        detailHttpStatus = evaled.status || probe.status || detailHttpStatus;
        httpOk = detailHttpStatus >= 200 && detailHttpStatus < 300;
        if (evaled.ok && validateDetailApiPayload(evaled.data)) {
          captured.payload = evaled.data;
          detailPayloadValid = true;
          detailApiReady = true;
          captured.responseSeen = true;
          lastVerifyError = null;
        } else if (signatureCaptured && httpOk) {
          // 登录场景：有签名 + 2xx 即视为 detail 可用（payload 结构偶发变化）
          detailApiReady = true;
          lastVerifyError = null;
        } else if (!lastVerifyError) {
          lastVerifyError = evaled.reason || "detail_payload_invalid";
        }
      } catch {
        /* ignore */
      }
    }

    // 登录场景兜底：只要抓到 mtgsig，就算签名能力就绪（payload 交给后续生产路径补）
    if (!detailApiReady && signatureCaptured && !redirectedToLogin) {
      detailApiReady = true;
      lastVerifyError = null;
    }

    const loginRequired =
      redirectedToLogin ||
      lastVerifyError === "detail_http_401" ||
      lastVerifyError === "login_required";

    return {
      boxPageLoaded,
      redirectedToLogin,
      getBoxShowRequestSeen: captured.responseSeen,
      signatureCaptured,
      signatureSource: captured.signatureSource,
      signatureHeaders: captured.headers?.mtgsig
        ? { ...(captured.headers || {}) }
        : null,
      signatureUrl: captured.url || null,
      apiSignatures: { ...apiSignatures },
      detailHttpStatus,
      detailPayloadValid,
      detailApiReady,
      loginRequired,
      lastVerifyError: detailApiReady ? null : lastVerifyError,
      softReloaded,
      verifyMovieId: activeMovieId,
    };
  } finally {
    page.off("request", acceptRequest);
    page.off("response", onResponse);
  }
}

function emptyCapabilityResult(lastVerifyError = "verify_failed") {
  return {
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
    lastVerifyError,
  };
}

/**
 * 仅在用户已打开的登录浏览器标签页上验证，绝不 newPage / 绝不另启 Chrome。
 * 用于登录等待循环，避免标签页闪动与无头风控误判。
 */
async function verifyCapabilitiesInLiveContext(context, options = {}) {
  const pages = (context.pages?.() || []).filter((p) => {
    try {
      return p && !p.isClosed();
    } catch {
      return false;
    }
  });
  if (!pages.length) {
    return emptyCapabilityResult("no_live_page");
  }

  let page = pages[0];
  for (const candidate of pages) {
    try {
      const url = candidate.url();
      if (/piaofang\.maoyan\.com/i.test(url)) {
        page = candidate;
        break;
      }
    } catch {
      /* ignore */
    }
  }

  let loc = { host: "", path: "", href: "" };
  try {
    loc = await page.evaluate(() => ({
      host: location.hostname,
      path: location.pathname,
      href: location.href,
    }));
  } catch {
    try {
      const href = page.url() || "";
      const u = new URL(href);
      loc = { host: u.hostname, path: u.pathname, href };
    } catch {
      loc = { host: "", path: "", href: "" };
    }
  }

  let state;
  try {
    const cookies = await context.cookies();
    state = { cookies, origins: [] };
  } catch {
    state = { cookies: [] };
  }
  const identityCookieExists = storageStateLooksLoggedIn(state);

  // 仍在登录页时绝不 goto，避免轮询把登录页抢走/闪跳
  if (isMaoyanLoginRedirect(loc.host, loc.path)) {
    return {
      ...emptyCapabilityResult("login_required"),
      identityCookieExists,
      loginCookieReady: identityCookieExists,
      accountLoggedIn: identityCookieExists,
      loginRequired: true,
      lastVerifyError: "login_required",
    };
  }

  // 尚未落到票房域：只等用户自行跳转，禁止主动导航
  if (!String(loc.host || "").includes("piaofang")) {
    return {
      ...emptyCapabilityResult("waiting_piaofang_page"),
      identityCookieExists,
      loginCookieReady: identityCookieExists,
      accountLoggedIn: identityCookieExists,
      lastVerifyError: "waiting_piaofang_page",
    };
  }

  return verifyCapabilitiesInContext(context, {
    ...options,
    existingPageOnly: true,
    preferredPage: page,
    managePage: false,
    // 登录轮询绝对禁止导航：goto 会抢走用户登录页/造成标签闪跳
    noDashboardNavigation: true,
    noNavigation: true,
    checkDashboard: options.checkDashboard === true,
  });
}

/**
 * 从用户可见的登录浏览器导出 cookie，在后台无头浏览器里做能力验证。
 * 仅用于登录完成后的一次性生产路径检查，不得用于登录轮询。
 */
async function verifyCapabilitiesHeadlessFromContext(liveContext, options = {}) {
  let state;
  try {
    state = await liveContext.storageState();
  } catch {
    return emptyCapabilityResult("storage_state_unavailable");
  }

  const dataDir = options.dataDir || "";
  const chromePath = resolveChromePath(dataDir);
  const launchOpts = {
    headless: true,
    args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox"],
  };
  if (chromePath) launchOpts.executablePath = chromePath;

  let browser;
  let context;
  try {
    browser = await chromium.launch(launchOpts);
    context = await browser.newContext({
      storageState: state,
      locale: "zh-CN",
      userAgent: USER_AGENT,
    });
    return await verifyCapabilitiesInContext(context, options);
  } catch (error) {
    return emptyCapabilityResult(String(error?.message || error || "headless_verify_failed"));
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
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
  const managePage = options.managePage !== false;
  const empty = emptyCapabilityResult();

  try {
    let state;
    try {
      state = await context.storageState();
    } catch {
      state = { cookies: [] };
    }

    const identityCookieExists = storageStateLooksLoggedIn(state);
    const storageStateExists = (state?.cookies || []).some((c) =>
      /maoyan\.com|meituan\.com/i.test(String(c.domain || "")),
    );

    const pages = context.pages();
    page = options.preferredPage || null;
    if (page) {
      try {
        if (page.isClosed()) page = null;
      } catch {
        page = null;
      }
    }
    if (!page) {
      page = pages.length ? pages[0] : null;
    }
    if (!page) {
      if (options.existingPageOnly) {
        return {
          ...empty,
          lastVerifyError: "no_live_page",
        };
      }
      page = await context.newPage();
      created = true;
    }

    let dashboardAvailable = false;
    let verifyPick = null;

    if (options.dashboardData && validateDashboardPayload(options.dashboardData)) {
      dashboardAvailable = true;
      verifyPick = pickVerifyMovieFromDashboard(options.dashboardData);
    } else if (checkDashboard) {
      const dashResult = await fetchDashboardInPage(page, dashboardUrl, {
        noNavigation: options.noDashboardNavigation === true || options.noNavigation === true,
      });
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

    const detailResult = await verifyDetailOnBoxPage(page, verifyMovieId, boxLevel, {
      noNavigation: options.noNavigation === true,
    });

    const detailApiReady = detailResult.detailApiReady === true;
    const signatureCaptured = detailResult.signatureCaptured === true;
    const browserSessionVerified = detailApiReady;
    const loginRequired =
      detailResult.loginRequired === true ||
      detailResult.lastVerifyError === "detail_http_401" ||
      detailResult.lastVerifyError === "login_required";
    // 请求里见到签名字段 ≠ 可调用明细；login_required 时禁止宣称 signatureReady
    const signatureReady = signatureCaptured && !loginRequired;
    const browserSessionReady = detailApiReady || dashboardAvailable || identityCookieExists;
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
      signatureHeaders: detailResult.signatureHeaders || null,
      signatureUrl: detailResult.signatureUrl || null,
      apiSignatures: detailResult.apiSignatures || {},
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
    if (managePage && created && page) {
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
  isMaoyanLoginRedirect,
  matchesGetBoxShowRequest,
  movieIdFromBoxPath,
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
  verifyCapabilitiesInLiveContext,
  verifyCapabilitiesHeadlessFromContext,
  verifyLoginInContext,
};
