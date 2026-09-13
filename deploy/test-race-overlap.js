/**
 * 票房赛马榜 UI 重叠/越界检测：node deploy/test-race-overlap.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const UI_DIR = path.join(ROOT, "ui");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Bin\\chrome.exe",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const LONG_NAME =
  "中华人民共和国北京市朝阳区电影发行放映有限责任公司年度巨制动作冒险科幻史诗";

function dailyTable(rank) {
  return ["今日", "明日", "后天"].map((label, i) => ({
    label,
    box: i === 0 ? `${800 + rank * 20}.00万` : `${400 + rank * 10}.00万`,
    forecast: `${900 + rank * 15}.00万`,
    boxRate: `${(27.4 - rank * 1.2).toFixed(1)}%`,
    showCountRate: `${(26.0 - rank * 0.9).toFixed(1)}%`,
    avgSeatView: `${(1.2 + rank * 0.3).toFixed(1)}%`,
  }));
}

function richMovie(rank, extra = {}) {
  const todayBox = rank === 1 ? 852.22 : 312.4 + rank * 41.2;
  return {
    movieId: 1000 + rank,
    rank,
    name: rank === 1 ? LONG_NAME : rank === 2 ? `${LONG_NAME}续集` : `测试电影第${rank}名`,
    todayBox,
    todayUnit: "万",
    todayBoxText: rank === 1 ? "852.22" : todayBox.toFixed(2),
    boxRate: `${(27.4 - rank * 1.2).toFixed(1)}%`,
    showCountRate: `${(26.0 - rank * 0.9).toFixed(1)}%`,
    avgSeatView: `${(1.2 + rank * 0.3).toFixed(1)}%`,
    sumBoxDesc: rank === 1 ? "21.53亿" : `${(8 + rank).toFixed(2)}亿`,
    mainlandBox: rank === 1 ? "¥21.53亿" : `¥${(8 + rank).toFixed(2)}亿`,
    dailyIncrease: `${todayBox.toFixed(2)}万`,
    dynamicForecast: rank === 1 ? "1537.58万" : `${(400 + rank * 50).toFixed(2)}万`,
    hourSpeedText: rank === 1 ? "128.5万/h" : `${(20 + rank * 3).toFixed(1)}万/h`,
    totalForecast: rank === 1 ? "21.53亿" : `${(8 + rank).toFixed(2)}亿`,
    yesterdayTotal: "587.90万",
    yesterdaySamePeriodText: "102.45万",
    totalViews: "0.44亿",
    showCountDesc: "9.6万场",
    avgShowView: "3.9",
    sumSplitBoxDesc: "19.27亿",
    splitBoxRate: "26.0%",
    dailyTable: dailyTable(rank),
    ...extra,
  };
}

const SCENARIOS = [
  { name: "rich-top5", movies: () => [1, 2, 3, 4, 5].map((r) => richMovie(r)) },
  {
    name: "max-extra-metrics",
    movies: () =>
      [1, 2, 3, 4, 5].map((r) =>
        richMovie(r, {
          hmtBox: "1.23亿",
          overseasBox: "8888.88万",
          endDate: "2026-11-10",
          remainingDays: "58",
        }),
      ),
  },
  {
    name: "huge-mainland",
    movies: () =>
      [1, 2, 3, 4, 5].map((r) =>
        richMovie(r, { mainlandBox: "¥123456.78亿", sumBoxDesc: "123456.78亿" }),
      ),
  },
];

const VIEWPORTS = [
  { name: "1080x1920", width: 1080, height: 1920 },
  { name: "525x1080", width: 525, height: 1080 },
];

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

async function launchBrowser() {
  const chromePath = resolveChrome();
  const launchOpts = { headless: true, args: ["--no-sandbox", "--disable-gpu"] };
  if (chromePath) return chromium.launch({ ...launchOpts, executablePath: chromePath });
  return chromium.launch(launchOpts);
}

function overlapArea(a, b) {
  const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return x * y;
}

function rectContains(outer, inner, pad = 0) {
  return (
    inner.left >= outer.left - pad &&
    inner.top >= outer.top - pad &&
    inner.right <= outer.right + pad &&
    inner.bottom <= outer.bottom + pad
  );
}

async function inspect(page) {
  return page.evaluate(() => {
    function overlapArea(a, b) {
      const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return x * y;
    }
    function rectContains(outer, inner, pad = 0) {
      return (
        inner.left >= outer.left - pad &&
        inner.top >= outer.top - pad &&
        inner.right <= outer.right + pad &&
        inner.bottom <= outer.bottom + pad
      );
    }
    function isVisible(el) {
      if (!el) return false;
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function reportOverlap(a, b, label, issues, minRatio = 0.08, minArea = 40) {
      if (!isVisible(a) || !isVisible(b)) return;
      if (a.contains(b) || b.contains(a)) return;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const area = overlapArea(ra, rb);
      const minBox = Math.min(ra.width * ra.height, rb.width * rb.height);
      if (area > Math.max(minArea, minBox * minRatio)) {
        issues.push(`${label} overlap ${Math.round(area)}px²`);
      }
    }

    const viewport = document.getElementById("viewport");
    const vRect = viewport?.getBoundingClientRect() || { left: 0, top: 0, right: 1080, bottom: 1920 };
    const issues = [];
    const cards = [...document.querySelectorAll(".race-card")];

    if (document.documentElement.scrollWidth > vRect.width + 2) {
      issues.push(`横向滚动 scrollWidth=${document.documentElement.scrollWidth}`);
    }

    const stage = document.querySelector(".stage");
    if (stage && stage.scrollHeight > stage.clientHeight + 2) {
      issues.push(`stage 纵向滚动 scrollH=${stage.scrollHeight}`);
    }

    const hero = document.querySelector(".hero");
    const raceList = document.getElementById("race-list");
    if (hero && raceList) {
      reportOverlap(hero, raceList, "hero/race-list", issues, 0.02, 20);
    }

    const trophy = document.querySelector(".hero__trophy");
    const title = document.querySelector(".hero__title");
    reportOverlap(trophy, title, "hero trophy/title", issues, 0.05, 30);

    const nationPills = [...document.querySelectorAll(".nation-pill")];
    for (let i = 0; i < nationPills.length - 1; i++) {
      reportOverlap(nationPills[i], nationPills[i + 1], `nation-pill ${i + 1}/${i + 2}`, issues, 0.05, 20);
    }

    const nationBubble = document.getElementById("nation-delta");
    const nationMain = document.querySelector(".nation-pill--main");
    if (nationBubble?.classList.contains("is-visible") && nationMain) {
      if (!rectContains(nationMain.getBoundingClientRect(), nationBubble.getBoundingClientRect(), 6)) {
        issues.push("全国涨幅气泡越出今日大盘胶囊");
      }
    }

    for (let i = 0; i < cards.length - 1; i++) {
      const a = cards[i].getBoundingClientRect();
      const b = cards[i + 1].getBoundingClientRect();
      if (b.top < a.bottom - 2) {
        issues.push(`卡片 ${i + 1}/${i + 2} 纵向重叠 ${Math.round(a.bottom - b.top)}px`);
      }
    }

    for (const card of cards) {
      const rank = card.dataset.rank || "?";
      const rect = card.getBoundingClientRect();
      if (rect.left < vRect.left - 2 || rect.right > vRect.right + 2) {
        issues.push(`第 ${rank} 名卡片横向越界`);
      }
      if (rect.bottom > vRect.bottom + 2) {
        issues.push(`第 ${rank} 名卡片底部越界 ${Math.round(rect.bottom - vRect.bottom)}px`);
      }
      if (card.scrollHeight > card.clientHeight + 4) {
        issues.push(`第 ${rank} 名卡片内容溢出 scrollH=${card.scrollHeight} clientH=${card.clientHeight}`);
      }

      const head = card.querySelector(".race-card__head");
      const rankBadge = card.querySelector(".race-card__rank");
      const movieTitle = card.querySelector(".race-card__title");
      const mainland = card.querySelector(".race-card__mainland");
      const bubble = card.querySelector(".race-card__delta-float.is-visible");

      reportOverlap(rankBadge, movieTitle, `rank${rank} badge/title`, issues);
      reportOverlap(movieTitle, mainland, `rank${rank} title/mainland`, issues);
      reportOverlap(bubble, mainland, `rank${rank} bubble/mainland`, issues, 0.12, 24);
      reportOverlap(bubble, movieTitle, `rank${rank} bubble/title`, issues, 0.12, 24);

      if (head) {
        const hr = head.getBoundingClientRect();
        head.querySelectorAll("*").forEach((child) => {
          if (!isVisible(child)) return;
          const cr = child.getBoundingClientRect();
          if (cr.right > hr.right + 3 || cr.left < hr.left - 3) {
            issues.push(`第 ${rank} 名头部子元素横向越界: ${child.className}`);
          }
        });
      }

      const summaryBounds = card.querySelector(".race-card__summary-wrap")?.getBoundingClientRect() || rect;
      card.querySelectorAll(".metric").forEach((metric) => {
        const mr = metric.getBoundingClientRect();
        if (!rectContains(summaryBounds, mr, 2)) {
          issues.push(`第 ${rank} 名摘要指标越出摘要区`);
        }
        const val = metric.querySelector(".metric__value");
        if (val && val.scrollWidth > val.clientWidth + 2) {
          const text = val.textContent?.trim();
          if (text && text.length > 4) {
            issues.push(`第 ${rank} 名指标值未截断溢出: ${text.slice(0, 12)}`);
          }
        }
      });

      const tableWrap = card.querySelector(".race-card__table-wrap");
      const tableScaler = card.querySelector(".race-card__table-scaler");
      const table = card.querySelector(".race-card__table");
      if (tableWrap && table) {
        const tableBounds = tableScaler?.getBoundingClientRect() || tableWrap.getBoundingClientRect();
        const layoutOverflow = table.scrollHeight > tableWrap.clientHeight + 4;
        const visualOverflow =
          tableBounds.height > tableWrap.getBoundingClientRect().height + 4;
        if (layoutOverflow && visualOverflow) {
          issues.push(
            `第 ${rank} 名表格高度溢出: table=${table.scrollHeight} wrap=${tableWrap.clientHeight}`,
          );
        }
        card.querySelectorAll(".race-card__table td, .race-card__table th").forEach((cell) => {
          if (cell.scrollWidth > cell.clientWidth + 3) {
            issues.push(`第 ${rank} 名表格单元横向溢出: ${cell.textContent?.trim()?.slice(0, 10)}`);
          }
          const cr = cell.getBoundingClientRect();
          if (
            cr.bottom > tableBounds.bottom + 3 ||
            cr.top < tableBounds.top - 3 ||
            cr.right > tableBounds.right + 3 ||
            cr.left < tableBounds.left - 3
          ) {
            issues.push(`第 ${rank} 名表格绘制越界`);
          }
        });
      }
    }

    const last = cards[cards.length - 1];
    if (last) {
      const gap = vRect.bottom - last.getBoundingClientRect().bottom;
      if (last.getBoundingClientRect().bottom > vRect.bottom + 2) {
        issues.push(`末卡超出 viewport 底部 ${Math.round(last.getBoundingClientRect().bottom - vRect.bottom)}px`);
      }
    }

    return { issueCount: issues.length, issues: [...new Set(issues)] };
  });
}

async function renderScenario(page, movies) {
  await page.evaluate(
    ({ movies }) => {
      const { renderList, refitAllRaceCards, updateNation, setStatus, pulseInlineDelta } =
        window.__racePreview;
      renderList(movies);
      refitAllRaceCards?.();
      updateNation(
        {
          todayBox: 2092.2,
          todayUnit: "万",
          todayBoxText: "2092.2",
          viewCountDesc: "999.9万",
          showCountDesc: "99999",
          seatValue: "5.6%",
        },
        { updateTimeText: "2026-09-13 12:00:00", calendar: { today: "2026-09-13" } },
      );
      setStatus("ok", "");
      for (const movie of movies) {
        const card = document.querySelector(`.race-card[data-movie-id="${movie.movieId}"]`);
        const bubble = card?.querySelector(".race-card__delta-float");
        if (bubble) pulseInlineDelta(bubble, 88.88 + movie.rank, `test-${movie.movieId}`);
      }
      const nationBubble = document.getElementById("nation-delta");
      if (nationBubble) pulseInlineDelta(nationBubble, 981.1, "test-nation");
    },
    { movies },
  );
  await page.waitForTimeout(900);
}

async function main() {
  const { server, baseUrl } = await startStaticServer(UI_DIR);
  const browser = await launchBrowser();
  const allFailures = [];

  try {
    for (const vp of VIEWPORTS) {
      for (const scenario of SCENARIOS) {
        const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
        await page.addInitScript(() => {
          window.overlay = {
            getConfig: async () => ({ apiBase: "http://127.0.0.1:8765", pollIntervalMs: 60000, topCount: 5 }),
            getOverlaySettings: async () => ({
              bubble: { enabled: true, minDelta: 0.001, fontSize: 26, durationMs: 3000, floatHeight: 44 },
              fonts: {
                heroTitle: 72,
                heroSubtitle: 28,
                nationBox: 38,
                nationLabel: 24,
                movieTitle: 48,
                movieTitleFollow: 39,
                movieBoxRank1: 54,
                movieBoxFollow: 43,
                movieRank: 26,
                metricLabel: 23,
                metricValue: 30,
                metricValueRank1: 34,
                table: 19,
              },
            }),
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
        await renderScenario(page, scenario.movies());
        const report = await inspect(page);
        await page.close();

        if (report.issueCount) {
          allFailures.push({ viewport: vp.name, scenario: scenario.name, ...report });
        } else {
          console.log(`OK ${vp.name} / ${scenario.name}`);
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  if (allFailures.length) {
    console.error("OVERLAP FAILURES:\n", JSON.stringify(allFailures, null, 2));
    process.exit(1);
  }

  console.log("ALL OVERLAP CHECKS PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
