/**
 * Google 图片搜索电影官方海报。
 * 使用独立浏览器 context，禁止复用猫眼登录 Profile / Cookie。
 */
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { isAcceptablePoster, readImageSize, isBannedCandidateUrl } = require("./poster-resolver");

function chromeCandidates(env = process.env) {
  const list = [];
  const push = (p) => {
    const full = String(p || "").trim();
    if (full && !list.includes(full)) list.push(full);
  };
  const localAppData = String(env.LOCALAPPDATA || "").trim();
  if (localAppData) {
    push(path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"));
    push(path.join(localAppData, "Google", "Chrome", "Bin", "chrome.exe"));
  }
  const programFiles = String(env.PROGRAMFILES || "C:\\Program Files").trim();
  const programFilesX86 = String(env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)").trim();
  push(path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"));
  push(path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"));
  // 常见固定安装位（不依赖用户名）
  push("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  push("C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe");
  return list;
}

function findChrome(env = process.env) {
  return chromeCandidates(env).find((p) => fs.existsSync(p)) || "";
}

function stopError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function mapReason(codeOrReason) {
  const raw = String(codeOrReason || "").toLowerCase();
  if (raw === "chrome_missing" || raw === "chrome missing") return "chrome_missing";
  if (raw === "captcha") return "google_captcha";
  if (raw === "forbidden" || raw === "403") return "403";
  if (raw === "network") return "network";
  if (raw === "no-candidate" || raw === "no_candidate") return "no_candidate";
  if (raw === "quality" || raw === "gif" || raw === "quality_rejected") return "quality_rejected";
  if (raw === "cooldown") return "cooldown";
  if (raw === "download" || raw === "download_fail") return "download_fail";
  if (raw === "cache_error") return "cache_error";
  return raw || "network";
}

function logPosterSearch(fields) {
  const lines = ["[POSTER_SEARCH]"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    // 禁止输出 cookie / 鉴权头
    if (/cookie|authorization|set-cookie/i.test(key)) continue;
    lines.push(`${key}=${value}`);
  }
  console.log(lines.join("\n"));
}

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (!/^https?:\/\//i.test(url)) {
      reject(stopError("NETWORK", "bad url"));
      return;
    }
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(
      url,
      {
        timeout: 8000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status === 403) {
          res.resume();
          reject(stopError("FORBIDDEN", "403"));
          return;
        }
        if (status >= 300 && status < 400 && res.headers.location && redirects < 4) {
          res.resume();
          resolve(download(new URL(res.headers.location, url).href, redirects + 1));
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(stopError("NETWORK", `status ${status}`));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 4_000_000) {
            req.destroy();
            reject(stopError("NETWORK", "too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(stopError("NETWORK", "timeout"));
    });
    req.on("error", (error) => reject(stopError("NETWORK", error.message)));
  });
}

function extractCandidateUrls(html) {
  const found = [];
  const seen = new Set();
  const push = (raw) => {
    let url = String(raw || "")
      .replace(/\\u003d/gi, "=")
      .replace(/\\u0026/gi, "&")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&");
    if (!/^https?:\/\//i.test(url)) return;
    if (isBannedCandidateUrl(url)) return;
    url = url.split('"')[0].split("'")[0];
    if (seen.has(url)) return;
    seen.add(url);
    found.push(url);
  };
  const patterns = [
    /"ou":"(https:[^"]+)"/g,
    /imgurl=(https?%3A%2F%2F[^&"]+)/gi,
    /https?:\\\/\\\/[^"'\\\s>]+\.(?:jpg|jpeg|png|webp)/gi,
    /https?:\/\/[^"'\\\s>]+\.(?:jpg|jpeg|png|webp)/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(html))) {
      let value = match[1] || match[0];
      if (value.includes("%3A") || value.includes("%2F")) {
        try {
          value = decodeURIComponent(value);
        } catch {
          /* keep */
        }
      }
      push(value);
      if (found.length >= 12) return found;
    }
  }
  return found;
}

function readProxy() {
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY) {
    return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY;
  }
  try {
    const cred = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deploy", "github.json"), "utf-8"));
    return String(cred.proxy || "").trim() || "";
  } catch {
    return "";
  }
}

async function collectPageCandidateUrls(page) {
  const fromDom = await page.evaluate(() => {
    const urls = [];
    for (const img of document.querySelectorAll("img")) {
      for (const key of ["src", "data-src", "data-iurl"]) {
        const v = img.getAttribute(key) || "";
        if (/^https?:\/\//i.test(v)) urls.push(v);
      }
    }
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href || "";
      const m = href.match(/[?&]imgurl=([^&]+)/i);
      if (m) {
        try {
          urls.push(decodeURIComponent(m[1]));
        } catch {
          urls.push(m[1]);
        }
      }
    }
    return urls;
  });
  const html = await page.content();
  return [...fromDom, ...extractCandidateUrls(html)];
}

async function searchOfficialPoster(movieName, options = {}) {
  const name = String(movieName || "").trim();
  const movieId = String(options.movieId || "").trim();
  const diagBase = {
    movieId,
    movie: name,
    chromePath: "",
    query: "",
    cacheHit: false,
    cooldown: false,
    candidateCount: 0,
    result: "",
    reason: "",
  };
  if (!name) {
    logPosterSearch({ ...diagBase, result: "fail", reason: "empty-name" });
    return { stopped: false, reason: "empty-name" };
  }
  const chrome = findChrome();
  diagBase.chromePath = chrome || "(missing)";
  if (!chrome) {
    logPosterSearch({ ...diagBase, result: "fail", reason: "chrome_missing" });
    throw stopError("CHROME_MISSING", "chrome missing");
  }
  let chromium;
  try {
    chromium = require("playwright").chromium;
  } catch (error) {
    logPosterSearch({ ...diagBase, result: "fail", reason: "network" });
    throw stopError("NETWORK", error.message);
  }

  const query = `${name} 电影 官方海报`;
  diagBase.query = query;
  if (!query.includes(name)) {
    logPosterSearch({ ...diagBase, result: "fail", reason: "query-mismatch" });
    return { reason: "query-mismatch", query };
  }
  const searchUrl = `https://www.google.com/search?tbm=isch&hl=zh-CN&q=${encodeURIComponent(query)}`;
  const proxy = options.proxy !== undefined ? options.proxy : readProxy();
  const launchArgs = [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-blink-features=AutomationControlled",
  ];
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
      logPosterSearch({ ...diagBase, result: "fail", reason: "network" });
      throw stopError("NETWORK", error.message);
    }
    const status = response?.status?.() || 0;
    if (status === 403) {
      logPosterSearch({ ...diagBase, result: "fail", reason: "403" });
      throw stopError("FORBIDDEN", "403");
    }
    await page.waitForTimeout(1800);
    const html = await page.content();
    const finalUrl = page.url();
    // 只认真实拦截页：/sorry/ 或明确 unusual traffic；避免普通页里的 recaptcha 脚本误判
    const blocked =
      /\/sorry\//i.test(finalUrl) ||
      /unusual traffic|detected unusual traffic/i.test(html) ||
      (status >= 400 && status !== 404);
    if (blocked) {
      const reason = status === 403 ? "403" : "google_captcha";
      logPosterSearch({ ...diagBase, result: "fail", reason });
      throw stopError(status === 403 ? "FORBIDDEN" : "CAPTCHA", "google blocked");
    }
    const seen = new Set();
    const urls = [];
    for (const url of await collectPageCandidateUrls(page)) {
      if (!url || seen.has(url) || isBannedCandidateUrl(url)) continue;
      seen.add(url);
      urls.push(url);
    }
    diagBase.candidateCount = urls.length;
    let rejected = "no_candidate";
    for (const sourceUrl of urls.slice(0, 10)) {
      let buffer;
      try {
        buffer = await download(sourceUrl);
      } catch (error) {
        if (error.code === "FORBIDDEN" || error.code === "CAPTCHA") {
          logPosterSearch({
            ...diagBase,
            result: "fail",
            reason: mapReason(error.code),
          });
          throw error;
        }
        rejected = "download_fail";
        continue;
      }
      const info = readImageSize(buffer);
      if (!isAcceptablePoster(info)) {
        rejected = info?.gif ? "quality_rejected" : "quality_rejected";
        continue;
      }
      logPosterSearch({
        ...diagBase,
        result: "success",
        reason: "",
        width: info.width,
        height: info.height,
      });
      return {
        buffer,
        width: info.width,
        height: info.height,
        type: info.type,
        sourceUrl,
        query,
        chromePath: chrome,
        candidateCount: urls.length,
      };
    }
    logPosterSearch({
      ...diagBase,
      result: "fail",
      reason: mapReason(rejected),
    });
    return {
      reason: rejected === "no_candidate" ? "no-candidate" : rejected === "quality_rejected" ? "quality" : rejected,
      query,
      candidateCount: urls.length,
      chromePath: chrome,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = {
  searchOfficialPoster,
  extractCandidateUrls,
  findChrome,
  chromeCandidates,
  mapReason,
  logPosterSearch,
};
