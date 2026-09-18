/**
 * Bing 图片搜索电影官方海报。
 * 接口与 Google 搜索一致；由 poster-resolver 在 Google 失败后串行调用，禁止并行。
 * 使用独立浏览器 context，禁止复用猫眼登录 Profile / Cookie。
 */
const { isAcceptablePoster, readImageSize, isBannedCandidateUrl } = require("./poster-resolver");
const {
  findChrome,
  downloadImage,
  readProxy,
  stopError,
  logPosterSearch,
  mapReason,
} = require("./poster-search");

function pushUrl(found, seen, raw) {
  let url = String(raw || "")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
  if (url.includes("%3A") || url.includes("%2F")) {
    try {
      url = decodeURIComponent(url);
    } catch {
      /* keep */
    }
  }
  url = url.split('"')[0].split("'")[0].split("\\")[0];
  if (!/^https?:\/\//i.test(url)) return;
  if (isBannedCandidateUrl(url)) return;
  if (seen.has(url)) return;
  seen.add(url);
  found.push(url);
}

function extractBingCandidateUrls(html) {
  const found = [];
  const seen = new Set();
  const text = String(html || "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
  const patterns = [
    /"murl"\s*:\s*"(https?:[^"]+)"/gi,
    /[?&]imgurl=([^&"\\\s]+)/gi,
    /https?:\/\/[^"'\\\s>]+\.(?:jpg|jpeg|png|webp)/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text))) {
      pushUrl(found, seen, match[1] || match[0]);
      if (found.length >= 12) return found;
    }
  }
  return found;
}

async function collectBingCandidateUrls(page) {
  const fromDom = await page.evaluate(() => {
    const urls = [];
    const nodes = document.querySelectorAll("a.iusc, a[m], [m]");
    for (const node of nodes) {
      const raw = node.getAttribute("m") || "";
      if (!raw) continue;
      try {
        const data = JSON.parse(raw);
        if (data && data.murl) urls.push(String(data.murl));
      } catch {
        const match = raw.match(/"murl"\s*:\s*"([^"]+)"/);
        if (match) urls.push(match[1]);
      }
    }
    return urls;
  });
  const html = await page.content();
  return [...fromDom, ...extractBingCandidateUrls(html)];
}

function bingBlockReason(status, finalUrl, html) {
  if (status === 403) return "403";
  if (/\/sorry\/|\/challenge/i.test(finalUrl)) return "captcha";
  if (/unusual traffic|verify you are a human|please solve the challenge/i.test(html)) return "captcha";
  if (status >= 400 && status !== 404) return "captcha";
  return "";
}

async function searchBingPoster(movieName, options = {}) {
  const name = String(movieName || "").trim();
  const movieId = String(options.movieId || "").trim();
  const diagBase = {
    movieId,
    movieName: name,
    movie: name,
    provider: "bing",
    query: "",
    cacheHit: false,
    candidateCount: 0,
    reason: "",
    selectedWidth: "",
    selectedHeight: "",
  };
  if (!name) {
    logPosterSearch({ ...diagBase, cacheHit: false, reason: "empty-name" });
    return { provider: "bing", stopped: false, reason: "empty-name" };
  }
  const chrome = findChrome();
  if (!chrome) {
    logPosterSearch({ ...diagBase, cacheHit: false, reason: "chrome_missing" });
    throw stopError("CHROME_MISSING", "chrome missing");
  }
  let chromium;
  try {
    chromium = require("playwright").chromium;
  } catch (error) {
    logPosterSearch({ ...diagBase, cacheHit: false, reason: "network_error" });
    throw stopError("NETWORK", error.message);
  }

  const query = `${name} 电影 官方海报`;
  diagBase.query = query;
  if (!query.includes(name)) {
    logPosterSearch({ ...diagBase, cacheHit: false, reason: "query-mismatch" });
    return { provider: "bing", reason: "query-mismatch", query };
  }

  const searchUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1&scenario=ImageBasicHover`;
  const proxy = options.proxy !== undefined ? options.proxy : readProxy();
  const launchArgs = ["--no-sandbox", "--disable-gpu", "--disable-blink-features=AutomationControlled"];
  if (proxy) launchArgs.push(`--proxy-server=${String(proxy).replace(/^https?:\/\//i, "")}`);

  const browser = await chromium.launch({
    headless: options.headless !== false,
    executablePath: chrome,
    args: launchArgs,
    ignoreDefaultArgs: ["--enable-automation"],
  });
  try {
    const context = await browser.newContext({
      locale: "zh-CN",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();
    let response;
    try {
      response = await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    } catch (error) {
      logPosterSearch({ ...diagBase, cacheHit: false, reason: "network_error" });
      throw stopError("NETWORK", error.message);
    }
    const status = response?.status?.() || 0;
    await page.waitForTimeout(1800);
    const html = await page.content();
    const finalUrl = page.url();
    const blocked = bingBlockReason(status, finalUrl, html);
    if (blocked) {
      logPosterSearch({ ...diagBase, cacheHit: false, reason: blocked });
      throw stopError(blocked === "403" ? "FORBIDDEN" : "CAPTCHA", "bing blocked");
    }

    const seen = new Set();
    const urls = [];
    for (const url of await collectBingCandidateUrls(page)) {
      if (!url || seen.has(url) || isBannedCandidateUrl(url)) continue;
      seen.add(url);
      urls.push(url);
    }
    diagBase.candidateCount = urls.length;
    let rejected = "no_candidate";
    for (const sourceUrl of urls.slice(0, 10)) {
      let buffer;
      try {
        buffer = await downloadImage(sourceUrl);
      } catch (error) {
        if (error.code === "FORBIDDEN" || error.code === "CAPTCHA") {
          logPosterSearch({
            ...diagBase,
            cacheHit: false,
            reason: mapReason(error.code),
          });
          throw error;
        }
        rejected = "download_failed";
        continue;
      }
      const info = readImageSize(buffer);
      if (!isAcceptablePoster(info)) {
        rejected = "quality_rejected";
        continue;
      }
      logPosterSearch({
        ...diagBase,
        cacheHit: false,
        candidateCount: urls.length,
        selectedWidth: info.width,
        selectedHeight: info.height,
      });
      return {
        provider: "bing",
        buffer,
        width: info.width,
        height: info.height,
        type: info.type,
        sourceUrl,
        query,
        candidateCount: urls.length,
      };
    }
    logPosterSearch({
      ...diagBase,
      cacheHit: false,
      candidateCount: urls.length,
      reason: mapReason(rejected),
    });
    return {
      provider: "bing",
      reason: mapReason(rejected),
      query,
      candidateCount: urls.length,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = {
  searchBingPoster,
  searchOfficialPoster: searchBingPoster,
  extractBingCandidateUrls,
};
