/**
 * Google 图片搜索电影官方海报。
 * 使用独立浏览器 context，禁止复用猫眼登录 Profile / Cookie。
 */
const fs = require("fs");
const http = require("http");
const https = require("https");
const { isAcceptablePoster, readImageSize } = require("./poster-resolver");

const CHROME_CANDIDATES = [
  "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Bin\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

function findChrome() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) || "";
}

function stopError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
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
    if (/gstatic|googleusercontent|google\.com|ggpht|favicon|logo|sprite|qrcode|avatar/i.test(url)) return;
    if (/\.gif(\?|$)/i.test(url)) return;
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

async function searchOfficialPoster(movieName, options = {}) {
  const name = String(movieName || "").trim();
  if (!name) return { stopped: false, reason: "empty-name" };
  const chrome = findChrome();
  if (!chrome) throw stopError("NETWORK", "chrome missing");
  let chromium;
  try {
    chromium = require("playwright").chromium;
  } catch (error) {
    throw stopError("NETWORK", error.message);
  }

  const query = `${name} 电影 官方海报`;
  const searchUrl = `https://www.google.com/search?tbm=isch&hl=zh-CN&gbv=1&q=${encodeURIComponent(query)}`;
  const browser = await chromium.launch({
    headless: true,
    executablePath: chrome,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  try {
    const context = await browser.newContext({
      locale: "zh-CN",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    let response;
    try {
      response = await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    } catch (error) {
      throw stopError("NETWORK", error.message);
    }
    const status = response?.status?.() || 0;
    if (status === 403) throw stopError("FORBIDDEN", "403");
    const html = await page.content();
    const finalUrl = page.url();
    if (status >= 400 || /sorry\/index|unusual traffic|detected unusual|captcha|recaptcha/i.test(`${finalUrl}\n${html}`)) {
      throw stopError(status === 403 ? "FORBIDDEN" : "CAPTCHA", "google blocked");
    }
    const urls = extractCandidateUrls(html);
    let rejected = "no-candidate";
    for (const sourceUrl of urls.slice(0, 6)) {
      let buffer;
      try {
        buffer = await download(sourceUrl);
      } catch (error) {
        if (error.code === "FORBIDDEN" || error.code === "CAPTCHA") throw error;
        rejected = error.code || "download";
        continue;
      }
      const info = readImageSize(buffer);
      if (!isAcceptablePoster(info)) {
        rejected = info?.gif ? "gif" : "quality";
        continue;
      }
      return {
        buffer,
        width: info.width,
        height: info.height,
        type: info.type,
        sourceUrl,
        query,
      };
    }
    return { reason: rejected, query };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = {
  searchOfficialPoster,
  extractCandidateUrls,
  findChrome,
};
