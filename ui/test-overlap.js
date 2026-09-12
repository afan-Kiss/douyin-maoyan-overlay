import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Bin\\chrome.exe";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const filePath = path.normalize(path.join(root, urlPath === "/" ? "index.html" : urlPath));
      if (!filePath.startsWith(root)) return res.writeHead(403).end();
      fs.readFile(filePath, (err, data) => {
        if (err) return res.writeHead(404).end();
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const baseMovies = [
  { movieId: 1, rank: 1, name: "欢迎来龙餐馆", todayBox: 1079.36, todayUnit: "万", boxRate: "50.8", showCountRate: "28.2", avgSeatView: "13.1", dynamicForecast: "1032.40万" },
  { movieId: 2, rank: 2, name: "功夫女足", todayBox: 312.4, todayUnit: "万", boxRate: "14.7", showCountRate: "18.5", avgSeatView: "9.2", dynamicForecast: "26.80万" },
  { movieId: 3, rank: 3, name: "八仙", todayBox: 212.4, todayUnit: "万", boxRate: "10.0", showCountRate: "15.1", avgSeatView: "8.4", dynamicForecast: "432.90万" },
  { movieId: 4, rank: 4, name: "奥德赛", todayBox: 188.2, todayUnit: "万", boxRate: "8.8", showCountRate: "12.3", avgSeatView: "7.1" },
  { movieId: 5, rank: 5, name: "星际迷行：重启之门超长片名测试", todayBox: 155.6, todayUnit: "万", boxRate: "7.3", showCountRate: "10.2", avgSeatView: "6.5" },
  { movieId: 6, rank: 6, name: "城市边缘3", todayBox: 132.1, todayUnit: "万", boxRate: "6.2", showCountRate: "9.1", avgSeatView: "5.8" },
  { movieId: 7, rank: 7, name: "破市盐·天能", todayBox: 118.5, todayUnit: "万", boxRate: "5.6", showCountRate: "8.4", avgSeatView: "5.2" },
  { movieId: 8, rank: 8, name: "深海回声", todayBox: 98.2, todayUnit: "万", boxRate: "4.6", showCountRate: "7.2", avgSeatView: "4.8" },
  { movieId: 9, rank: 9, name: "火线救援", todayBox: 86.4, todayUnit: "万", boxRate: "4.1", showCountRate: "6.5", avgSeatView: "4.2" },
  { movieId: 10, rank: 10, name: "夏庆漫长", todayBox: 72.8, todayUnit: "万", boxRate: "3.4", showCountRate: "5.8", avgSeatView: "3.9" },
];

const SCENARIOS = [
  { name: "normal", status: "ok", nationDelta: "" },
  { name: "status-loading", status: "loading", nationDelta: "" },
  { name: "large-delta", status: "ok", nationDelta: "+21.7万" },
  { name: "long-top1", status: "ok", nationDelta: "", patch: (m) => { m[0].name = "欢迎来到龙餐馆之超长片名测试一二三四五六"; } },
  { name: "trailer-empty", status: "ok", nationDelta: "", trailerEmpty: true },
];

const VIEWPORTS = [
  { name: "1080x1920", width: 1080, height: 1920 },
  { name: "525x1080", width: 525, height: 1080 },
];

function overlapArea(a, b) {
  const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return x * y;
}

async function main() {
  const { server, url } = await serve(__dirname);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const allIssues = [];

  for (const vp of VIEWPORTS) {
    for (const scenario of SCENARIOS) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      await page.addInitScript(() => {
        window.overlay = {
          getConfig: async () => ({ apiBase: "", pollIntervalMs: 60000, topCount: 10 }),
          getOverlaySettings: async () => null,
          onSettingsChanged: () => () => {},
          getApiStatus: async () => ({ ready: false }),
          ensureApi: async () => ({ ready: false }),
          isLoggedIn: async () => true,
          startLogin: async () => {},
          onApiReady: () => () => {},
        };
      });
      await page.goto(`${url}/index.html`);

      const movies = JSON.parse(JSON.stringify(baseMovies));
      scenario.patch?.(movies);

      await page.evaluate(
        async ({ movies, nationDelta, status, trailerEmpty }) => {
          const { renderDashboard } = await import("./dashboard-view.js");
          renderDashboard(
            movies,
            {
              todayBox: 2126.8,
              todayBoxHtml: null,
              todayUnit: "万",
              viewCountDesc: "33.0万",
              showCountDesc: "6880",
            },
            { updateTimeText: "2026-09-11 18:14:32" }
          );
          const statusEl = document.getElementById("status");
          if (statusEl) {
            statusEl.className = `status status--${status}`;
            statusEl.style.display = status === "ok" ? "none" : "block";
            statusEl.textContent = status === "loading" ? "正在启动票房服务…" : "";
          }
          const delta = document.getElementById("nation-delta");
          if (delta && nationDelta) {
            delta.textContent = nationDelta;
            delta.classList.add("has-rise");
          }
          document.querySelectorAll(".rank-row").forEach((row) => {
            const round = row.querySelector(".rank-row__round");
            if (round) {
              round.textContent = "+0.12万";
              round.classList.add("has-rise");
            }
          });
          if (trailerEmpty) {
            const { initTrailerPlayer } = await import("./trailer-player.js");
            initTrailerPlayer();
          }
        },
        { movies, nationDelta: scenario.nationDelta, status: scenario.status, trailerEmpty: scenario.trailerEmpty }
      );

      await page.waitForTimeout(400);

      const report = await page.evaluate(() => {
        function overlapArea(a, b) {
          const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
          const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          return x * y;
        }

        const viewport = document.getElementById("viewport");
        const vRect = viewport.getBoundingClientRect();
        const issues = [];

        const sectionSelectors = [
          ".live-zone--top",
          ".live-zone--main",
          ".live-zone--trailer",
        ];

        const sections = sectionSelectors
          .map((sel) => {
            const el = document.querySelector(sel);
            if (!el || el.hidden || getComputedStyle(el).display === "none") return null;
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) return null;
            return { sel, top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height };
          })
          .filter(Boolean);

        for (let i = 0; i < sections.length - 1; i++) {
          const a = sections[i];
          const b = sections[i + 1];
          const gap = b.top - a.bottom;
          if (gap < -2) {
            issues.push({
              type: "section-overlap",
              detail: `${a.sel} 与 ${b.sel} 重叠 ${Math.round(-gap)}px`,
              gap,
            });
          }
        }

        const last = sections[sections.length - 1];
        if (last && last.bottom > vRect.bottom + 2) {
          issues.push({
            type: "viewport-overflow",
            detail: `底部内容超出 viewport ${Math.round(last.bottom - vRect.bottom)}px`,
            overflow: last.bottom - vRect.bottom,
          });
        }

        if (sections[0] && sections[0].top < vRect.top - 2) {
          issues.push({
            type: "viewport-overflow-top",
            detail: `顶部内容超出 viewport ${Math.round(vRect.top - sections[0].top)}px`,
          });
        }

        function isAncestor(a, b) {
          return a.contains(b) || b.contains(a);
        }

        const checkPairs = [
          [".live-header__left", ".live-header__center"],
          [".live-header__center", ".live-header__right"],
          [".live-header__title", ".live-header__time"],
          [".trailer-section__copy", ".trailer-section__slogan"],
          [".trailer-section__movie", ".trailer-section__slogan"],
          [".podium-card__badge", ".podium-card__name"],
          [".podium-card--r1", ".podium-card--r2"],
          [".podium-card--r2", ".podium-card--r3"],
        ];

        for (const [selA, selB] of checkPairs) {
          document.querySelectorAll(selA).forEach((a) => {
            const card = a.closest(".podium-card");
            const b = card?.querySelector(selB.split(" ").pop()) || document.querySelector(selB);
            if (!b || isAncestor(a, b)) return;
            if (card && b.closest(".podium-card") !== card) return;
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            if (!ra.width || !ra.height || !rb.width || !rb.height) return;
            const area = overlapArea(ra, rb);
            const minArea = Math.min(ra.width * ra.height, rb.width * rb.height);
            if (area > minArea * 0.12 && area > 80) {
              issues.push({
                type: "element-overlap",
                detail: `${selA} 与 ${selB} 重叠面积约 ${Math.round(area)}px²`,
                area,
              });
            }
          });
        }

        const trailerFrame = document.getElementById("trailer-frame");
        if (trailerFrame?.classList.contains("trailer-section__main--empty")) {
          const slogan = document.querySelector(".trailer-section__slogan");
          const empty = document.getElementById("trailer-empty");
          if (slogan && empty && !empty.hidden) {
            const sr = slogan.getBoundingClientRect();
            const er = empty.getBoundingClientRect();
            if (overlapArea(sr, er) > 20) {
              issues.push({
                type: "trailer-empty-slogan-overlap",
                detail: "预告空态与 slogan 重叠",
              });
            }
          }
          const overlay = document.querySelector(".trailer-section__overlay");
          if (overlay && getComputedStyle(overlay).display !== "none") {
            issues.push({
              type: "trailer-empty-overlay-visible",
              detail: "预告空态时 overlay 仍可见",
            });
          }
        }

        const r1Name = document.querySelector(".podium-card--r1 .podium-card__name");
        const r1Box = document.querySelector(".podium-card--r1 .podium-card__box-val");
        if (r1Name && r1Box) {
          const nr = r1Name.getBoundingClientRect();
          const br = r1Box.getBoundingClientRect();
          if (nr.bottom > br.top + 4) {
            issues.push({
              type: "podium-r1-name-box-overlap",
              detail: `TOP1 片名与票房数字重叠 ${Math.round(nr.bottom - br.top)}px`,
            });
          }
        }

        const rows = [...document.querySelectorAll(".rank-row")];
        for (let i = 0; i < rows.length - 1; i++) {
          const ra = rows[i].getBoundingClientRect();
          const rb = rows[i + 1].getBoundingClientRect();
          if (rb.top - ra.bottom < -1) {
            issues.push({
              type: "rank-row-overlap",
              detail: `排行榜第 ${i + 4} 与 ${i + 5} 行重叠`,
            });
          }
        }

        const clipped = [];
        document.querySelectorAll(".rank-row__name, .podium-card__name, .summary-bar__value-row").forEach((el) => {
          const r = el.getBoundingClientRect();
          const parent = el.parentElement?.getBoundingClientRect();
          if (!parent) return;
          if (r.right > parent.right + 4 || r.left < parent.left - 4) {
            clipped.push(el.className);
          }
        });

        if (clipped.length) {
          issues.push({ type: "text-overflow-parent", detail: clipped.slice(0, 5).join(", ") });
        }

        const totalContentH = sections.reduce((sum, s) => sum + s.h, 0);
        const available = vRect.height;

        return {
          viewportH: vRect.height,
          contentTotalH: Math.round(totalContentH),
          sectionHeights: sections.map((s) => ({ sel: s.sel, h: Math.round(s.h) })),
          issues,
          rankRowCount: rows.length,
          podiumHeights: [...document.querySelectorAll(".podium-card")].map((c) => c.offsetHeight),
        };
      });

      if (report.issues.length) {
        allIssues.push({ viewport: vp.name, scenario: scenario.name, ...report });
      } else {
        allIssues.push({ viewport: vp.name, scenario: scenario.name, ok: true, rankRowCount: report.rankRowCount });
      }

      await page.close();
    }
  }

  await browser.close();
  server.close();

  const failures = allIssues.filter((r) => r.issues?.length);
  console.log(JSON.stringify({ total: allIssues.length, failures: failures.length, results: allIssues }, null, 2));
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
