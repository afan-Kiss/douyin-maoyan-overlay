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

function dailyTable(rank) {
  return ["今日", "明日", "后天"].map((label, i) => ({
    label,
    box: i === 0 ? `${800 + rank * 20}.00万` : "--",
    forecast: i === 0 ? `${900 + rank * 15}.00万` : "--",
    boxRate: i === 0 ? `${(27.4 - rank * 1.2).toFixed(1)}%` : "--",
    showCountRate: i === 0 ? `${(26.0 - rank * 0.9).toFixed(1)}%` : "--",
    avgSeatView: i === 0 ? `${(1.2 + rank * 0.3).toFixed(1)}%` : "--",
  }));
}

function richMovie(rank, withExtras = true) {
  const todayBox = rank === 1 ? 852.22 : 312.4 + rank * 41.2;
  const base = {
    movieId: 1000 + rank,
    rank,
    name: rank === 1 ? LONG_NAME : rank === 2 ? `${LONG_NAME}续集` : `测试电影第${rank}名`,
    todayBox,
    todayUnit: "万",
    todayBoxText: rank === 1 ? "852.22" : todayBox.toFixed(2),
    boxRate: `${(27.4 - rank * 1.2).toFixed(1)}%`,
    showCountRate: `${(26.0 - rank * 0.9).toFixed(1)}%`,
    avgSeatView: `${(1.2 + rank * 0.3).toFixed(1)}%`,
    avgShowView: rank === 1 ? "35" : `${28 - rank * 2}`,
    sumBoxDesc: rank === 1 ? "21.53亿" : `${(8 + rank).toFixed(2)}亿`,
    mainlandBox: rank === 1 ? "21.53亿" : `${(8 + rank).toFixed(2)}亿`,
    dailyIncrease: `${todayBox.toFixed(2)}万`,
    dailyTable: dailyTable(rank),
  };
  if (!withExtras) return base;
  return {
    ...base,
    dynamicForecast: rank === 1 ? "1537.58万" : `${(400 + rank * 50).toFixed(2)}万`,
    endDate: rank === 1 ? "2026-10-12" : `2026-10-${String(10 + rank).padStart(2, "0")}`,
    remainingDays: String(20 + rank),
    releaseInfo: `上映${10 + rank}天`,
  };
}

function mockMoviesRich() {
  return [1, 2, 3, 4, 5].map((rank) => richMovie(rank, true));
}

function mockMoviesSparse() {
  return [1, 2, 3, 4, 5].map((rank) => richMovie(rank, rank <= 2));
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

async function launchBrowser() {
  const chromePath = resolveChrome();
  const launchOpts = { headless: true, args: ["--no-sandbox", "--disable-gpu"] };
  if (chromePath) {
    return chromium.launch({ ...launchOpts, executablePath: chromePath });
  }
  try {
    return await chromium.launch(launchOpts);
  } catch (error) {
    console.log(`SKIP: Chrome not found for layout test (${error.message || error})`);
    process.exit(2);
  }
}

function rectContains(outer, inner, pad = 0) {
  return (
    inner.left >= outer.left - pad &&
    inner.top >= outer.top - pad &&
    inner.right <= outer.right + pad &&
    inner.bottom <= outer.bottom + pad
  );
}

async function renderAndInspect(page, movies, nation) {
  await page.evaluate(
    ({ movies, nation }) => {
      const { renderList, refitAllRaceCards, updateNation, setStatus, pulseInlineDelta } =
        window.__racePreview;
      renderList(movies);
      refitAllRaceCards?.();
      updateNation(nation, { updateTimeText: "2026-09-13 12:00:00", calendar: { today: "2026-09-13" } });
      setStatus("ok", "");
      for (const movie of movies) {
        const card = document.querySelector(`.race-card[data-movie-id="${movie.movieId}"]`);
        const bubble = card?.querySelector(".race-card__delta-float");
        if (bubble) pulseInlineDelta(bubble, 10 + movie.rank, `test-${movie.movieId}`);
      }
      const nationBubble = document.getElementById("nation-delta");
      if (nationBubble) pulseInlineDelta(nationBubble, 981.1, "test-nation");
    },
    {
      movies,
      nation: {
        todayBox: 2092.2,
        todayUnit: "万",
        todayBoxText: "2092.2",
        viewCountDesc: "999.9万",
        showCountDesc: "99999",
        seatValue: "5.6%",
      },
    },
  );

  await page.waitForTimeout(400);

  return page.evaluate(() => {
    const rectContains = (outer, inner, pad = 0) =>
      inner.left >= outer.left - pad &&
      inner.top >= outer.top - pad &&
      inner.right <= outer.right + pad &&
      inner.bottom <= outer.bottom + pad;

    const raceList = document.getElementById("race-list");
    const hero = document.querySelector(".hero");
    const items = [...(raceList?.querySelectorAll(".race-card") || [])];
    const issues = [];
    const fonts = {};

    if (items.length !== 5) {
      issues.push(`race-list 应有 5 项，实际 ${items.length}`);
    }

    const heroBottom = hero?.getBoundingClientRect().bottom || 0;
    const firstTop = items[0]?.getBoundingClientRect().top || 0;
    const heroGap = firstTop - heroBottom;
    if (heroGap > 48) {
      issues.push(`顶部空白过大: hero→TOP1 间距 ${heroGap.toFixed(1)}px`);
    }
    if (hero && hero.getBoundingClientRect().height > 360) {
      issues.push(`顶部区域过高: ${hero.getBoundingClientRect().height.toFixed(1)}px`);
    }

    const nationBubble = document.getElementById("nation-delta");
    const nationPill = document.querySelector(".nation-pill--main");
    if (nationBubble?.classList.contains("is-visible") && nationPill) {
      if (!rectContains(nationPill.getBoundingClientRect(), nationBubble.getBoundingClientRect(), 4)) {
        issues.push("全国大盘涨幅气泡不在今日大盘胶囊内");
      }
    }

    for (const item of items) {
      const rank = Number(item.dataset.rank);
      const rect = item.getBoundingClientRect();
      if (rect.top < -1 || rect.bottom > 1921) {
        issues.push(`第 ${rank} 名纵向越界: top=${rect.top.toFixed(1)} bottom=${rect.bottom.toFixed(1)}`);
      }
      if (rect.right > 1081 || rect.left < -1) {
        issues.push(`第 ${rank} 名横向越界`);
      }

      if (item.querySelector(".race-card__medal")) {
        issues.push(`第 ${rank} 名仍保留左侧排名徽章`);
      }
      if (item.querySelector(".race-card__corner")) {
        issues.push(`第 ${rank} 名仍使用右上角 NO.x 角标`);
      }
      if (item.querySelector(".race-card__daily-trend")) {
        issues.push(`第 ${rank} 名不应显示 daily-trend 区块`);
      }
      if (item.querySelector(".race-card__core-stats")) {
        issues.push(`第 ${rank} 名不应显示 core-stats 区块`);
      }

      const table = item.querySelector(".race-card__table");
      if (!table) {
        issues.push(`第 ${rank} 名缺少日榜表格`);
      } else {
        const rows = table.querySelectorAll("tbody tr");
        if (rows.length !== 3) {
          issues.push(`第 ${rank} 名表格应为 3 行，实际 ${rows.length}`);
        } else {
          const lastRow = rows[rows.length - 1];
          const wrap = item.querySelector(".race-card__table-wrap");
          const lastRect = lastRow.getBoundingClientRect();
          const wrapRect = wrap?.getBoundingClientRect();
          const cardRect = item.getBoundingClientRect();
          if (wrapRect && lastRect.bottom > wrapRect.bottom + 1) {
            issues.push(`第 ${rank} 名「后天」行被表格容器裁切`);
          }
          if (lastRect.bottom > cardRect.bottom + 1) {
            issues.push(`第 ${rank} 名「后天」行被卡片裁切`);
          }
          if (lastRect.height < 12) {
            issues.push(`第 ${rank} 名「后天」行高度异常: ${lastRect.height.toFixed(1)}`);
          }
        }
        const headers = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
        const expected = ["日期", "票房(含分账)", "预测", "票房%", "排片%", "上座率"];
        if (headers.join("|") !== expected.join("|")) {
          issues.push(`第 ${rank} 名表头不匹配: ${headers.join("|")}`);
        }
      }

      const bubble = item.querySelector(".race-card__delta-float");
      if (bubble?.classList.contains("is-visible")) {
        if (!rectContains(rect, bubble.getBoundingClientRect(), 2)) {
          issues.push(`第 ${rank} 名涨幅气泡漂出卡片`);
        }
      }

      const title = item.querySelector(".race-card__title");
      const rankBadge = item.querySelector(".race-card__rank");
      const mainland = item.querySelector(".js-mainland");
      const summary = item.querySelector(".race-card__summary");
      const metrics = item.querySelectorAll(".race-card__summary .metric");

      if (!title?.textContent?.trim()) {
        issues.push(`第 ${rank} 名缺少电影名`);
      }
      if (!rankBadge?.textContent?.includes("NO.")) {
        issues.push(`第 ${rank} 名缺少 NO.x 标签`);
      }
      if (!mainland?.textContent?.trim()) {
        issues.push(`第 ${rank} 名缺少中国内地累计`);
      }
      if (!summary) {
        issues.push(`第 ${rank} 名缺少摘要区`);
      }
      if (metrics.length < 7) {
        issues.push(`第 ${rank} 名摘要指标至少 7 项，实际 ${metrics.length}`);
      }

      const metricLabels = [...metrics].map((el) => el.querySelector(".metric__label")?.textContent?.trim());
      const coreLabels = ["动态预测", "下映日期", "上映", "实时票房", "票房占比", "场均人次", "排片占比"];
      for (const label of coreLabels) {
        if (!metricLabels.includes(label)) {
          issues.push(`第 ${rank} 名缺少核心摘要字段: ${label}`);
        }
      }

      if (item.scrollHeight > item.clientHeight + 2) {
        issues.push(`第 ${rank} 名卡片内容溢出`);
      }
    }

    const tableBoxTexts = items.map((item) => {
      const cell = item.querySelector(".race-card__table tbody tr:first-child td:nth-child(2)");
      return cell?.textContent?.trim() || "";
    }).filter(Boolean);
    if (tableBoxTexts.length >= 2 && new Set(tableBoxTexts).size < tableBoxTexts.length) {
      issues.push(`表格今日票房重复: ${tableBoxTexts.join(" | ")}`);
    }

    const last = items[items.length - 1];
    const lastBottom = last?.getBoundingClientRect().bottom || 0;
    const gapToBottom = 1920 - lastBottom;
    if (lastBottom < 1860) {
      issues.push(`TOP5 未铺满底部: lastBottom=${lastBottom.toFixed(1)}px (<1860)`);
    }
    if (lastBottom > 1920.5) {
      issues.push(`第 5 名 bottom=${lastBottom.toFixed(1)} 超出 1920`);
    }
    if (gapToBottom > 50) {
      issues.push(`底部空白过大: ${gapToBottom.toFixed(1)}px`);
    }

    if (document.documentElement.scrollWidth > 1081) {
      issues.push(`scrollWidth=${document.documentElement.scrollWidth}`);
    }

    const stage = document.querySelector(".stage");
    if (stage && stage.scrollHeight > stage.clientHeight + 2) {
      issues.push("stage 产生纵向滚动");
    }

    const rank1 = items.find((el) => el.dataset.rank === "1");
    const follow = items.filter((el) => Number(el.dataset.rank) > 1);

    const sample = (el, key) => {
      if (!el) return;
      fonts[key] = parseFloat(getComputedStyle(el).fontSize);
    };

    sample(document.querySelector(".hero__title"), "heroTitle");
    sample(document.querySelector(".hero__date"), "heroDate");
    sample(document.querySelector(".nation-pill__label"), "nationLabel");
    sample(document.querySelector(".nation-pill__value"), "nationValue");
    sample(document.getElementById("nation-delta"), "nationDelta");
    sample(rank1?.querySelector(".race-card__title"), "rank1Title");
    sample(rank1?.querySelector(".js-mainland"), "rank1Mainland");
    sample(follow[0]?.querySelector(".race-card__title"), "followTitle");
    sample(follow[0]?.querySelector(".metric__label"), "label");
    sample(follow[0]?.querySelector(".metric__value"), "value");
    sample(follow[0]?.querySelector(".race-card__table"), "table");

    const bubbleHeights = {};
    for (const item of items) {
      const rank = item.dataset.rank;
      const bubble = item.querySelector(".race-card__delta-bubble.is-visible");
      if (bubble) {
        bubbleHeights[rank] = bubble.getBoundingClientRect().height;
        sample(bubble, rank === "1" ? "rank1Bubble" : "followBubble");
      }
    }

    return {
      itemCount: items.length,
      scrollWidth: document.documentElement.scrollWidth,
      lastBottom,
      gapToBottom,
      heroGap,
      heroHeight: hero?.getBoundingClientRect().height || 0,
      rank1Height: rank1?.getBoundingClientRect().height || 0,
      followHeights: follow.map((el) => el.getBoundingClientRect().height),
      fonts,
      bubbleHeights,
      issues,
    };
  });
}

async function main() {
  const { server, baseUrl } = await startStaticServer(UI_DIR);
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
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

    const reportRich = await renderAndInspect(page, mockMoviesRich());
    await page.screenshot({ path: OUT_PNG, fullPage: false });

    const reportSparse = await renderAndInspect(page, mockMoviesSparse());

    assert.strictEqual(reportRich.itemCount, 5, "race-list 应有 5 项");
    assert.ok(reportRich.lastBottom >= 1860, `第 5 名 bottom=${reportRich.lastBottom} (<1860)`);
    assert.ok(reportRich.lastBottom <= 1920.5, `第 5 名 bottom=${reportRich.lastBottom}`);
    assert.ok(reportRich.scrollWidth <= 1081, `scrollWidth=${reportRich.scrollWidth}`);
    assert.ok(reportRich.gapToBottom <= 50, `bottom gap=${reportRich.gapToBottom}`);
    assert.ok(reportRich.heroGap <= 48, `hero gap=${reportRich.heroGap}`);
    assert.ok(reportRich.heroHeight <= 360, `hero height=${reportRich.heroHeight}`);
    assert.strictEqual(reportRich.issues.length, 0, reportRich.issues.join("; "));
    assert.strictEqual(reportSparse.issues.length, 0, `sparse: ${reportSparse.issues.join("; ")}`);

    const f = reportRich.fonts;
    assert.ok(f.heroTitle >= 68, `heroTitle=${f.heroTitle}`);
    assert.ok(f.heroDate >= 26, `heroDate=${f.heroDate}`);
    assert.ok(f.nationLabel >= 22, `nationLabel=${f.nationLabel}`);
    assert.ok(f.nationValue >= 36, `nationValue=${f.nationValue}`);
    assert.ok((f.nationDelta || 24) >= 22, `nationDelta=${f.nationDelta}`);
    assert.ok(f.rank1Mainland >= 28, `rank1Mainland=${f.rank1Mainland}`);
    assert.ok(f.rank1Title >= 28, `rank1Title=${f.rank1Title}`);
    assert.ok(f.followTitle >= 24, `followTitle=${f.followTitle}`);
    assert.ok(f.label >= 22, `metricLabel=${f.label}`);
    assert.ok(f.value >= 24, `metricValue=${f.value}`);
    assert.ok((f.table || 14) >= 12, `table=${f.table}`);
    assert.ok((f.rank1Bubble || 0) >= 18, `rank1Bubble=${f.rank1Bubble}`);

    const wanDisplay = await page.evaluate(() => {
      const { renderList, updateNation } = window.__racePreview;
      renderList([
        {
          movieId: 9001,
          rank: 1,
          name: "万亿测试",
          todayBox: 12300,
          todayUnit: "亿",
          mainlandBox: "1.23亿",
          dailyTable: [
            {
              label: "今日",
              box: "1.23亿",
              forecast: "1.30亿",
              boxRate: "30%",
              showCountRate: "25%",
              avgSeatView: "5%",
            },
            { label: "明日", box: "--", forecast: "--", boxRate: "--", showCountRate: "--", avgSeatView: "--" },
            { label: "后天", box: "--", forecast: "--", boxRate: "--", showCountRate: "--", avgSeatView: "--" },
          ],
        },
      ]);
      updateNation(
        {
          todayBox: 12300,
          todayUnit: "亿",
          showCountDesc: "1",
          viewCountDesc: "1",
        },
        { updateTimeText: "2026-09-13 12:00:00" },
      );
      const mainland = document.querySelector('.race-card[data-rank="1"] .js-mainland')?.textContent || "";
      const nationText =
        `${document.getElementById("nation-box")?.textContent || ""}${document.querySelector(".js-nation-unit")?.textContent || ""}`;
      const champText =
        `${document.getElementById("champ-box")?.textContent || ""}${document.getElementById("champ-box-unit")?.textContent || ""}`;
      return { mainland, nationText, champText };
    });
    assert.strictEqual(wanDisplay.mainland, "¥1.23亿");
    assert.strictEqual(wanDisplay.nationText, "1.23亿");
    assert.strictEqual(wanDisplay.champText, "1.23亿");

    console.log("TOP5 layout OK");
    console.log("Screenshot:", OUT_PNG);
    console.log("Layout:", {
      items: reportRich.itemCount,
      heroHeight: reportRich.heroHeight,
      heroGap: reportRich.heroGap,
      rank1Height: reportRich.rank1Height,
      followHeights: reportRich.followHeights,
      lastBottom: reportRich.lastBottom,
      gapToBottom: reportRich.gapToBottom,
      scrollWidth: reportRich.scrollWidth,
      fonts: reportRich.fonts,
      bubbleHeights: reportRich.bubbleHeights,
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
