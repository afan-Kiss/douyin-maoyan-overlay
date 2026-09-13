/**
 * TOP5 真实 DOM 布局回归：node deploy/test-layout-top5.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const UI_DIR = path.join(ROOT, "ui");
const OUT_PNG = path.join(UI_DIR, "1080x1920-top5.png");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Bin\\chrome.exe",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

const LONG_NAME =
  "中华人民共和国北京市朝阳区电影发行放映有限责任公司年度巨制动作冒险科幻史诗";

function mockMovies() {
  return Array.from({ length: 5 }, (_, i) => {
    const rank = i + 1;
    const hasAll = true;
    return {
      movieId: 1000 + rank,
      rank,
      name: rank === 1 ? LONG_NAME : rank === 2 ? `${LONG_NAME}续集` : `测试电影第${rank}名超长中文片名验证`,
      todayBox: rank === 1 ? 99999.99 : 1234.56 + rank * 111.11,
      todayUnit: "万",
      todayBoxText: rank === 1 ? "99999.99" : String((1234.56 + rank * 111.11).toFixed(2)),
      boxRate: `${(50 - rank).toFixed(1)}%`,
      showCountRate: `${(30 - rank * 0.8).toFixed(1)}%`,
      avgSeatView: `${(15 - rank * 0.5).toFixed(1)}%`,
      sumBoxDesc: rank === 1 ? "￥12亿8888.88万" : "--",
      dynamicForecast: rank === 1 ? "8888.88万" : "--",
    };
  });
}

function startStaticServer(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const filePath = path.normalize(path.join(root, urlPath === "/" ? "index.html" : urlPath));
      if (!filePath.startsWith(root)) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404).end();
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function resolveChrome() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p));
}

function parsePx(value) {
  const n = parseFloat(String(value || "0"));
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const chromePath = resolveChrome();
  if (!chromePath) {
    console.log("SKIP: Chrome not found for layout test");
    process.exit(0);
  }

  const { server, baseUrl } = await startStaticServer(UI_DIR);
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await page.addInitScript(() => {
      window.overlay = {
        getConfig: async () => ({ apiBase: "http://127.0.0.1:8765", pollIntervalMs: 60000, topCount: 5 }),
        getOverlaySettings: async () => null,
        onSettingsChanged: () => () => {},
        getApiStatus: async () => ({ ready: false }),
        ensureApi: async () => ({ ready: false }),
        isLoggedIn: async () => false,
        getSessionStatus: async () => ({ detailApiReady: false, identityCookieExists: false }),
        startLogin: async () => {},
        onApiReady: () => () => {},
      };
    });

    await page.goto(`${baseUrl}/index.html?preview=1`);
    await page.waitForFunction(() => Boolean(window.__racePreview));

    const movies = mockMovies();
    await page.evaluate(
      ({ movies, nation }) => {
        const { renderList, updateNation, setStatus } = window.__racePreview;
        renderList(movies);
        updateNation(nation, { updateTimeText: "2026-09-13 12:00:00", calendar: { today: "2026-09-13" } });
        setStatus("ok", "");
      },
      {
        movies,
        nation: {
          todayBox: 99999.99,
          todayUnit: "万",
          todayBoxText: "99999.99",
          viewCountDesc: "999.9万",
          showCountDesc: "99999",
        },
      },
    );

    await page.waitForTimeout(900);

    const report = await page.evaluate(() => {
      const raceList = document.getElementById("race-list");
      const footer = document.getElementById("stage-footer");
      const items = [...(raceList?.querySelectorAll(".race-card") || [])];
      const issues = [];
      const fonts = {};

      if (items.length !== 5) {
        issues.push(`race-list 应有 5 项，实际 ${items.length}`);
      }

      const rank1 = items.find((el) => el.dataset.rank === "1");
      const follow = items.filter((el) => Number(el.dataset.rank) > 1);

      for (const item of items) {
        const rect = item.getBoundingClientRect();
        if (rect.top < -1 || rect.bottom > 1921) {
          issues.push(`第 ${item.dataset.rank} 名纵向越界: top=${rect.top.toFixed(1)} bottom=${rect.bottom.toFixed(1)}`);
        }
        if (rect.right > 1081 || rect.left < -1) {
          issues.push(`第 ${item.dataset.rank} 名横向越界`);
        }
      }

      const last = items[items.length - 1];
      const lastBottom = last?.getBoundingClientRect().bottom || 0;
      const footerTop = footer?.getBoundingClientRect().top || 1920;
      const gapToFooter = footerTop - lastBottom;
      if (gapToFooter > 80) {
        issues.push(`最后一张卡片距 footer 空白过大: ${gapToFooter.toFixed(1)}px`);
      }
      if (lastBottom > 1920.5) {
        issues.push(`第 5 名 bottom=${lastBottom.toFixed(1)} 超出 1920`);
      }

      if (document.documentElement.scrollWidth > 1081) {
        issues.push(`scrollWidth=${document.documentElement.scrollWidth}`);
      }

      const stage = document.querySelector(".stage");
      if (stage && stage.scrollHeight > stage.clientHeight + 2) {
        issues.push("stage 产生纵向滚动");
      }

      const sample = (el, key) => {
        if (!el) return;
        fonts[key] = parseFloat(getComputedStyle(el).fontSize);
      };

      sample(rank1?.querySelector(".race-card__title"), "rank1Title");
      sample(rank1?.querySelector(".js-day-box"), "rank1Box");
      sample(follow[0]?.querySelector(".race-card__title"), "followTitle");
      sample(follow[0]?.querySelector(".js-day-box"), "followBox");
      sample(follow[0]?.querySelector(".race-stat em"), "label");
      sample(follow[0]?.querySelector(".race-stat strong"), "value");

      if (fonts.rank1Title < 46) issues.push(`TOP1 电影名 ${fonts.rank1Title}px < 46px`);
      if (fonts.rank1Box < 42) issues.push(`TOP1 票房 ${fonts.rank1Box}px < 42px`);
      if (fonts.followTitle < 34) issues.push(`TOP2~5 电影名 ${fonts.followTitle}px < 34px`);
      if (fonts.followBox < 30) issues.push(`TOP2~5 票房 ${fonts.followBox}px < 30px`);
      if (fonts.label < 20) issues.push(`label ${fonts.label}px < 20px`);
      if (fonts.value < 24) issues.push(`value ${fonts.value}px < 24px`);

      const rank1Height = rank1?.getBoundingClientRect().height || 0;
      const moviesTop = items[0]?.getBoundingClientRect().top || 0;
      const moviesBottom = lastBottom;
      const moviesRegionHeight = moviesBottom - moviesTop;

      return {
        itemCount: items.length,
        scrollWidth: document.documentElement.scrollWidth,
        lastBottom,
        gapToFooter,
        rank1Height,
        followHeights: follow.map((el) => el.getBoundingClientRect().height),
        moviesRegionHeight,
        fonts,
        issues,
      };
    });

    await page.screenshot({ path: OUT_PNG, fullPage: false });

    assert.strictEqual(report.itemCount, 5, "race-list 应有 5 项");
    assert.ok(report.lastBottom <= 1920.5, `第 5 名 bottom=${report.lastBottom}`);
    assert.ok(report.scrollWidth <= 1081, `scrollWidth=${report.scrollWidth}`);
    assert.ok(report.gapToFooter <= 80, `footer gap=${report.gapToFooter}`);
    assert.strictEqual(report.issues.length, 0, report.issues.join("; "));

    console.log("TOP5 layout OK");
    console.log("Screenshot:", OUT_PNG);
    console.log("Layout:", {
      items: report.itemCount,
      rank1Height: report.rank1Height,
      followHeights: report.followHeights,
      moviesRegionHeight: report.moviesRegionHeight,
      lastBottom: report.lastBottom,
      gapToFooter: report.gapToFooter,
      scrollWidth: report.scrollWidth,
      fonts: report.fonts,
    });
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
