/**
 * TOP10 真实 DOM 布局回归：node deploy/test-layout-top10.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const UI_DIR = path.join(ROOT, "ui");
const OUT_PNG = path.join(UI_DIR, "1080x1920-top10.png");

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
  return Array.from({ length: 10 }, (_, i) => {
    const rank = i + 1;
    const hasAll = rank <= 7;
    const hasPartial = rank === 8;
    return {
      movieId: 1000 + rank,
      rank,
      name: rank === 1 ? LONG_NAME : rank === 2 ? `${LONG_NAME}续集` : `测试电影第${rank}名超长中文片名验证`,
      todayBox: rank === 1 ? 99999.99 : 1234.56 + rank * 111.11,
      todayUnit: "万",
      todayBoxText: rank === 1 ? "99999.99" : String((1234.56 + rank * 111.11).toFixed(2)),
      boxRate: hasAll || hasPartial ? `${(50 - rank).toFixed(1)}%` : "--",
      showCountRate: hasAll ? `${(30 - rank * 0.8).toFixed(1)}%` : hasPartial ? "12.3%" : "--",
      avgSeatView: hasAll ? `${(15 - rank * 0.5).toFixed(1)}%` : "--",
      mainlandBox: rank <= 3 ? "￥12亿8888.88万" : "--",
      hmtBox: rank <= 3 ? "￥888.8万" : "--",
      overseasBox: rank <= 3 ? "￥666.6万" : "--",
      dynamicForecast: rank <= 3 ? "8888.88万" : "--",
      dailyTable:
        rank <= 3
          ? [
              {
                label: "今日",
                box: "888.88万",
                forecast: "999.99万",
                boxRate: "24.7%",
                showCountRate: "25.7%",
                avgSeatView: "2.7%",
              },
              { label: "明日", box: "79.83万", forecast: "1915.50万", boxRate: "9.5%", showCountRate: "26.3%", avgSeatView: "0.1%" },
              { label: "后天", box: "6.35万", forecast: "632.10万", boxRate: "1.8%", showCountRate: "27.8%", avgSeatView: "<0.1%" },
            ]
          : [],
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
        getConfig: async () => ({ apiBase: "http://127.0.0.1:8765", pollIntervalMs: 60000, topCount: 10 }),
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
      const viewport = document.getElementById("viewport");
      const raceList = document.getElementById("race-list");
      const items = [...(raceList?.querySelectorAll(".race-card") || [])];
      const issues = [];
      const fontSamples = [];

      if (items.length !== 10) {
        issues.push(`race-list 应有 10 项，实际 ${items.length}`);
      }

      for (const item of items) {
        const rect = item.getBoundingClientRect();
        if (rect.top < -1 || rect.bottom > 1921) {
          issues.push(`第 ${item.dataset.rank} 名纵向越界: top=${rect.top.toFixed(1)} bottom=${rect.bottom.toFixed(1)}`);
        }
        if (rect.right > 1081 || rect.left < -1) {
          issues.push(`第 ${item.dataset.rank} 名横向越界: left=${rect.left.toFixed(1)} right=${rect.right.toFixed(1)}`);
        }
      }

      const last = items[items.length - 1];
      if (last) {
        const bottom = last.getBoundingClientRect().bottom;
        if (bottom > 1920.5) {
          issues.push(`第 10 名 bottom=${bottom.toFixed(1)} 超出 1920`);
        }
      }

      if (document.documentElement.scrollWidth > 1081) {
        issues.push(`scrollWidth=${document.documentElement.scrollWidth} 超出设计宽度`);
      }

      const stage = document.querySelector(".stage");
      if (stage && stage.scrollHeight > stage.clientHeight + 2) {
        issues.push("stage 产生纵向滚动/裁切风险");
      }

      const rowRectOf = (el, container) => {
        const r = el.getBoundingClientRect();
        const c = container.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cLeft: c.left, cRight: c.right, cTop: c.top, cBottom: c.bottom };
      };

      for (const row of items.slice(3)) {
        const rowRect = row.getBoundingClientRect();
        for (const em of row.querySelectorAll(".race-row__metric em")) {
          const size = parseFloat(getComputedStyle(em).fontSize);
          fontSamples.push({ rank: row.dataset.rank, role: "label", px: size });
          if (size < 18) issues.push(`TOP${row.dataset.rank} label=${size}px < 18px`);
          const box = rowRectOf(em, row);
          if (box.right > box.cRight + 1 || box.left < box.cLeft - 1) {
            issues.push(`TOP${row.dataset.rank} label 横向溢出 row`);
          }
        }
        for (const strong of row.querySelectorAll(".race-row__metric strong")) {
          const size = parseFloat(getComputedStyle(strong).fontSize);
          fontSamples.push({ rank: row.dataset.rank, role: "value", px: size });
          if (size < 24) issues.push(`TOP${row.dataset.rank} value=${size}px < 24px`);
          const strongOverflow = strong.scrollWidth > strong.clientWidth + 1;
          const strongStyle = getComputedStyle(strong);
          if (strongOverflow && strongStyle.textOverflow !== "ellipsis") {
            issues.push(`TOP${row.dataset.rank} value 文本被裁切 scroll>${strong.clientWidth}`);
          }
          const box = rowRectOf(strong, row);
          if (box.right > box.cRight + 1) issues.push(`TOP${row.dataset.rank} value 横向溢出 row`);
        }
        const title = row.querySelector(".race-row__title");
        if (title) {
          const size = parseFloat(getComputedStyle(title).fontSize);
          fontSamples.push({ rank: row.dataset.rank, role: "title", px: size });
          if (size < 26) issues.push(`TOP${row.dataset.rank} title=${size}px < 26px`);
          const titleOverflow = title.scrollWidth > title.clientWidth + 1;
          const titleStyle = getComputedStyle(title);
          if (titleOverflow && titleStyle.textOverflow !== "ellipsis" && titleStyle.overflow !== "hidden") {
            issues.push(`TOP${row.dataset.rank} title 文本被裁切`);
          }
          const box = rowRectOf(title, row);
          if (box.right > box.cRight + 1 || box.left < box.cLeft - 1) {
            issues.push(`TOP${row.dataset.rank} title 横向溢出 row`);
          }
        }
        const metrics = row.querySelector(".race-row__metrics");
        if (metrics && metrics.scrollWidth > metrics.clientWidth + 1) {
          issues.push(`TOP${row.dataset.rank} metrics 区域被裁切`);
        }
        if (rowRect.bottom > 1920.5 || rowRect.top < -1) {
          issues.push(`TOP${row.dataset.rank} row 外壳越界`);
        }
      }

      return {
        itemCount: items.length,
        scrollWidth: document.documentElement.scrollWidth,
        lastBottom: last?.getBoundingClientRect().bottom || 0,
        viewportRect: viewport?.getBoundingClientRect(),
        fontSamples,
        issues,
      };
    });

    await page.screenshot({ path: OUT_PNG, fullPage: false });

    assert.strictEqual(report.itemCount, 10, "race-list 应有 10 项");
    assert.ok(report.lastBottom <= 1920.5, `第 10 名 bottom=${report.lastBottom}`);
    assert.ok(report.scrollWidth <= 1081, `scrollWidth=${report.scrollWidth}`);
    assert.strictEqual(report.issues.length, 0, report.issues.join("; "));

    const minFonts = report.fontSamples.reduce(
      (acc, s) => {
        acc[s.role] = acc[s.role] == null ? s.px : Math.min(acc[s.role], s.px);
        return acc;
      },
      {},
    );

    console.log("TOP10 layout OK");
    console.log("Screenshot:", OUT_PNG);
    console.log("Min fonts (TOP4-10):", JSON.stringify(minFonts));
    console.log("Bounding:", {
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
