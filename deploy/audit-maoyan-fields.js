/**
 * 猫眼 TOP5 字段真实审计 + 真实截图
 * node deploy/audit-maoyan-fields.js
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const UI_DIR = path.join(ROOT, "ui");
const OUT_PNG = path.join(UI_DIR, "1080x1920-top5.png");
const API_BASE = process.env.MAOYAN_API_BASE || "http://127.0.0.1:8765";

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
};

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

async function captureRealScreenshot(movies, nation, parsed) {
  const chromePath = resolveChrome();
  const launchOpts = { headless: true, args: ["--no-sandbox", "--disable-gpu"] };
  const browser = await chromium.launch(chromePath ? { ...launchOpts, executablePath: chromePath } : launchOpts);
  const { server, baseUrl } = await startStaticServer(UI_DIR);

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
            metricLabel: 23,
            metricValue: 30,
            metricValueRank1: 34,
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
    if (parsed?.fontStyle) {
      await page.evaluate((fontStyle) => {
        const css = String(fontStyle || "")
          .replace(/url\("\/\//g, 'url("https://')
          .replace(/url\('\/\//g, "url('https://")
          .replace(/url\(\/\//g, "url(https://");
        let el = document.getElementById("maoyan-font-style");
        if (!el) {
          el = document.createElement("style");
          el.id = "maoyan-font-style";
          document.head.appendChild(el);
        }
        el.textContent = css;
      }, parsed.fontStyle);
      await page.waitForTimeout(600);
    }
    await page.evaluate(
      ({ movies, nation, parsed }) => {
        const { renderList, updateNation, setStatus } = window.__racePreview;
        renderList(movies);
        updateNation(nation, parsed);
        setStatus("ok", "");
      },
      { movies, nation, parsed },
    );
    await page.waitForTimeout(500);
    await page.screenshot({ path: OUT_PNG, fullPage: false });
    console.log("\n【截图路径】", OUT_PNG);
  } finally {
    await browser.close();
    server.close();
  }
}

async function main() {
  process.env.MAOYAN_FIELD_AUDIT = "1";
  const apiPath = pathToFileURL(path.join(ROOT, "ui", "maoyan-api.js")).href;
  const {
    fetchDashboard,
    parseDashboard,
    enrichMovies,
    getExtraMetrics,
    getLastFieldAuditEntries,
    classifyFieldStability,
    recordFieldAuditRun,
    EXTRA_METRIC_FIELD_MAP,
  } = await import(apiPath);

  const raw = await fetchDashboard(API_BASE);
  const parsed = parseDashboard(raw, 5);
  const enriched = await enrichMovies(API_BASE, parsed.movies, {
    trendLimit: 5,
    enableExtraApis: true,
    todayStr: parsed.calendar?.today || "",
    concurrency: 2,
    enabled: true,
  });

  const entries = getLastFieldAuditEntries();
  recordFieldAuditRun(entries);
  const stability = classifyFieldStability(entries);

  console.log("\n【猫眼真实可用字段】");
  for (const entry of entries) {
    console.log(`\n# ${entry.name} (${entry.movieId})`);
    console.log("dashboard:", Object.keys(entry.dashboard).join(", ") || "(empty)");
    console.log("boxShow:", Object.keys(entry.boxShow).join(", ") || "(empty)");
    console.log("prediction:", Object.keys(entry.prediction).join(", ") || "(empty)");
    console.log("global:", Object.keys(entry.global).join(", ") || "(empty)");
    console.log("tech:", Object.keys(entry.tech).join(", ") || "(empty)");
    console.log("detail merged:", Object.keys(entry.detail).join(", ") || "(empty)");
  }

  console.log("\n【稳定有值】");
  for (const item of stability.stable) {
    console.log(`- ${item.label} (${item.key}) <- ${item.source}/${item.raw}`);
  }

  console.log("\n【偶尔有值】");
  for (const item of stability.occasional) {
    console.log(`- ${item.label} (${item.key})`);
  }

  console.log("\n【长期为空】");
  for (const item of stability.empty) {
    console.log(`- ${item.label} (${item.key})`);
  }

  console.log("\n【最终实际显示字段】");
  for (const movie of enriched) {
    const core = ["实时票房", "票房占比", "排片占比", "实时上座"];
    const extras = getExtraMetrics(movie).map((item) => item.label);
    console.log(`TOP${movie.rank} ${movie.name}: ${[...core, ...extras].join(" | ")}`);
  }

  console.log("\n【字段映射表】");
  for (const row of EXTRA_METRIC_FIELD_MAP) {
    console.log(`${row.label} | ${row.key} | ${row.source} | ${row.raw}`);
  }

  await captureRealScreenshot(enriched, parsed.nation, { ...parsed, fontStyle: raw.fontStyle });
  return { entries, enriched, stability };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
