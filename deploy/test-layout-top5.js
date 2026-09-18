/**
 * 电影互动榜正式布局回归：node deploy/test-layout-top5.js
 * （历史文件名保留，断言已切到 TOP10 统一互动榜）
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
  "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Bin\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const LONG_NAME =
  "中华人民共和国北京市朝阳区电影发行放映有限责任公司年度巨制动作冒险科幻史诗";

function richMovie(rank) {
  const todayBox = rank === 1 ? 852.22 : 312.4 + rank * 41.2;
  return {
    movieId: 1000 + rank,
    rank,
    name: rank === 1 ? LONG_NAME : rank === 2 ? `${LONG_NAME}续集` : `测试电影第${rank}名`,
    todayBox,
    todayUnit: "万",
    todayBoxText: rank === 1 ? "852.22" : todayBox.toFixed(2),
    displayBoxWan: todayBox,
    boxRate: `${(27.4 - rank * 1.2).toFixed(1)}%`,
    showCountRate: `${(26.0 - rank * 0.9).toFixed(1)}%`,
    avgShowView: rank === 1 ? "35" : `${28 - rank * 2}`,
    sumBoxDesc: rank === 1 ? "21.53亿" : `${(8 + rank).toFixed(2)}亿`,
  };
}

function mockMovies(count = 10) {
  return Array.from({ length: count }, (_, i) => richMovie(i + 1));
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

async function renderAndInspect(page, movies) {
  await page.evaluate(({ movies }) => {
    const { renderList, updateNation, setStatus, pulseInlineDelta } = window.__racePreview;
    renderList(movies);
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
      if (bubble) pulseInlineDelta(bubble, 10 + movie.rank, `test-${movie.movieId}`);
    }
  }, { movies });

  await page.waitForTimeout(400);

  return page.evaluate(() => {
    const raceList = document.getElementById("race-list");
    const items = [...(raceList?.querySelectorAll(".race-card:not(.race-card--skeleton)") || [])];
    const issues = [];
    const bodyText = document.body.innerText || "";

    if (items.length !== 10) issues.push(`race-list 应有 10 项，实际 ${items.length}`);

    const title = document.querySelector(".ix-title")?.textContent?.trim() || "";
    if (title !== "电影互动榜") issues.push(`标题应为电影互动榜，实际 ${title}`);
    if (/票房赛马榜|好电影互动榜|数据来源/.test(bodyText)) {
      issues.push("出现禁止副标题/旧标题");
    }
    if (/好看推荐|不好看啊/.test(bodyText)) issues.push("仍存在旧评分字段");
    if (!/直播间评分/.test(bodyText)) issues.push("缺少直播间评分");
    if (!/互动方式/.test(bodyText)) issues.push("缺少互动方式");
    if (!/1钻\s*=\s*10分|1钻 = 10分/.test(bodyText.replace(/\s+/g, ""))) {
      issues.push("缺少 1钻=10分");
    }
    if (!/3分钟/.test(bodyText)) issues.push("缺少 3分钟");
    if (!/好评/.test(bodyText) || !/差评/.test(bodyText)) issues.push("缺少好评/差评指令");
    if (!/仅供娱乐/.test(bodyText)) issues.push("缺少免责声明");
    if (!document.getElementById("ix-word-cloud")) issues.push("缺少弹幕球");
    if (document.querySelector(".race-card__medal") || document.querySelector(".podium-card")) {
      issues.push("仍使用领奖台/特殊大卡结构");
    }

    const head = [...document.querySelectorAll(".ix-board__head .ix-col")].map((el) =>
      el.textContent.trim(),
    );
    const expected = ["排名", "影片名称", "实时票房", "票房占比", "排片占比", "好看", "不好看", "直播间评分"];
    if (head.join("|") !== expected.join("|")) {
      issues.push(`表头不匹配: ${head.join("|")}`);
    }

    for (const item of items) {
      const rank = Number(item.dataset.rank);
      const rect = item.getBoundingClientRect();
      if (rect.top < -1 || rect.bottom > 1921) {
        issues.push(`第 ${rank} 名纵向越界: top=${rect.top.toFixed(1)} bottom=${rect.bottom.toFixed(1)}`);
      }
      if (rect.right > 1081 || rect.left < -1) issues.push(`第 ${rank} 名横向越界`);
      if (!item.querySelector(".race-card__title")?.textContent?.trim()) {
        issues.push(`第 ${rank} 名缺少电影名`);
      }
      if (!item.querySelector('[data-metric="dailyBox"]')) {
        issues.push(`第 ${rank} 名缺少实时票房`);
      }
      if (!item.querySelector("[data-live-score]")) {
        issues.push(`第 ${rank} 名缺少直播间评分`);
      }
      if (item.querySelector(".race-card__table")) {
        issues.push(`第 ${rank} 名不应再有日榜表格`);
      }
      const titleEl = item.querySelector(".race-card__title");
      if (titleEl && titleEl.scrollHeight > titleEl.clientHeight + 4) {
        issues.push(`第 ${rank} 名电影名未单行省略`);
      }
    }

    const last = items[items.length - 1];
    const lastBottom = last?.getBoundingClientRect().bottom || 0;
    if (lastBottom > 1920.5) issues.push(`第 10 名 bottom=${lastBottom.toFixed(1)} 超出 1920`);

    const guide = document.getElementById("ix-guide")?.getBoundingClientRect();
    const cloud = document.getElementById("ix-word-cloud")?.getBoundingClientRect();
    if (guide && guide.bottom > 1920.5) issues.push("互动方式被裁切");
    if (cloud && cloud.bottom > 1920.5) issues.push("弹幕球被裁切");

    if (document.documentElement.scrollWidth > 1081) {
      issues.push(`scrollWidth=${document.documentElement.scrollWidth}`);
    }
    const stage = document.querySelector(".stage");
    if (stage && stage.scrollHeight > stage.clientHeight + 2) {
      issues.push("stage 产生纵向滚动");
    }
    if (document.documentElement.scrollHeight > 1921) {
      issues.push(`页面纵向滚动 scrollHeight=${document.documentElement.scrollHeight}`);
    }

    return {
      itemCount: items.length,
      lastBottom,
      scrollWidth: document.documentElement.scrollWidth,
      issues,
      hasFakeDanmaku: [...document.querySelectorAll(".ix-cloud__item")].some((el) =>
        /demo-boot|等待弹幕/.test(el.textContent || ""),
      ),
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
        getConfig: async () => ({ apiBase: "http://127.0.0.1:8765", pollIntervalMs: 60000, topCount: 10 }),
        getOverlaySettings: async () => ({
          bubble: { enabled: true, minDelta: 0.001, fontSize: 26, durationMs: 3000, floatHeight: 44 },
          fonts: {},
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

    const report = await renderAndInspect(page, mockMovies(10));
    await page.screenshot({ path: OUT_PNG, fullPage: false });

    assert.strictEqual(report.itemCount, 10, "race-list 应有 10 项");
    assert.ok(report.scrollWidth <= 1081, `scrollWidth=${report.scrollWidth}`);
    assert.strictEqual(report.issues.length, 0, report.issues.join("; "));
    assert.strictEqual(report.hasFakeDanmaku, false, "正常模式不应出现假弹幕");

    const starCheck = await page.evaluate(() => {
      const html = document.documentElement.outerHTML;
      return {
        hasStar: !/★★★★★|9\.8分|星级/.test(document.body.innerText || ""),
        noOldCols: !/好看推荐|不好看啊/.test(html),
      };
    });
    assert.ok(starCheck.hasStar, "不应出现星级评分");
    assert.ok(starCheck.noOldCols, "不应保留旧评分列");

    console.log("Interaction leaderboard layout OK");
    console.log("Screenshot:", OUT_PNG);
    console.log("Layout:", {
      items: report.itemCount,
      lastBottom: report.lastBottom,
      scrollWidth: report.scrollWidth,
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
