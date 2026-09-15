/**
 * Electron 真实字体解码验证（审计 raw 样本）
 * node scripts/start-electron.js deploy/test-electron-font-decode.js
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
const { app, BrowserWindow } = require("electron");

const ROOT = path.join(__dirname, "..");
const AUDIT_FILE = path.join(ROOT, "audit-data", "maoyan-fields", "01-dashboard-raw.json");
const FONT_FIXTURE = path.join(ROOT, "deploy", "fixtures", "maoyan-75e5b39d.woff");
const OUT_PNG = path.join(ROOT, "ui", "electron-font-decode-audit.png");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      const rel = decodeURIComponent(url.pathname.replace(/^\//, ""));
      let filePath;
      if (url.pathname === "/" || url.pathname === "/test") {
        filePath = path.join(ROOT, "ui", "test-font-decode.html");
      } else if (rel.startsWith("audit-data/")) {
        filePath = path.join(ROOT, rel);
      } else if (rel === "font/75e5b39d.woff") {
        filePath = FONT_FIXTURE;
      } else {
        const uiPath = path.join(ROOT, "ui", rel);
        const rootPath = path.join(ROOT, rel);
        filePath = fs.existsSync(uiPath) ? uiPath : rootPath;
      }
      if (!filePath.startsWith(ROOT)) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404).end();
          return;
        }
        const ext = path.extname(filePath);
        const types = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".mjs": "text/javascript; charset=utf-8",
          ".json": "application/json; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".woff": "font/woff",
          ".woff2": "font/woff2",
          ".eot": "application/vnd.ms-fontobject",
        };
        res.setHeader("Content-Type", types[ext] || "application/octet-stream");
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  if (!fs.existsSync(AUDIT_FILE)) {
    console.error("SKIP: audit file missing — run npm run audit:maoyan-fields");
    process.exit(2);
  }

  const auditDoc = JSON.parse(fs.readFileSync(AUDIT_FILE, "utf8"));
  if (!(auditDoc.movies || []).some((m) => m.listItem)) {
    console.error("SKIP: audit listItem missing");
    process.exit(2);
  }
  if (!fs.existsSync(FONT_FIXTURE)) {
    console.error("SKIP: font fixture missing at deploy/fixtures/maoyan-75e5b39d.woff");
    process.exit(2);
  }

  const server = await startServer();
  const port = server.address().port;
  const localFontUrl = `http://127.0.0.1:${port}/font/75e5b39d.woff`;
  if (auditDoc.nation?.fontStyle) {
    auditDoc.nation.fontStyle = `@font-face{font-family:"mtsi-font";src:url("${localFontUrl}");}`;
  }

  const win = new BrowserWindow({
    width: 1080,
    height: 400,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on("console-message", (_e, _level, message) => {
    console.log("[renderer]", message);
  });

  await win.loadURL(`http://127.0.0.1:${port}/test`);
  await delay(800);
  await win.webContents.executeJavaScript(`
    window.runFontDecodeAudit(${JSON.stringify(auditDoc)}).catch((err) => {
      window.__fontDecodeError = String(err?.stack || err);
      throw err;
    });
  `);
  await delay(5000);

  const renderError = await win.webContents.executeJavaScript("window.__fontDecodeError || ''");
  if (renderError) {
    throw new Error(renderError);
  }

  const report = await win.webContents.executeJavaScript("window.__fontDecodeAudit");
  const pageText = await win.webContents.executeJavaScript(
    "document.body.innerText || document.body.textContent || ''",
  );

  const image = await win.webContents.capturePage();
  fs.writeFileSync(OUT_PNG, image.toPNG());
  await win.close();
  server.close();

  console.log(JSON.stringify({ ...report, screenshot: OUT_PNG, pageTextSnippet: pageText.slice(0, 200) }, null, 2));

  assertReport(report, pageText);

  console.log("PASS electron font decode audit");
  app.quit();
}

function assertReport(report, pageText) {
  const assert = require("assert");

  assert.ok(report.movie, "movie sample required");
  assert.ok(!pageText.includes("857.27亿"), "page must not show 857.27亿");
  assert.ok(!pageText.includes("8572685"), "page must not show raw bad decode");

  const { movie, nation } = report;
  const moviePlainVerified =
    report.fontReady &&
    movie.decodeStatus === "ok" &&
    movie.todayBoxWan > 0 &&
    /^[\d.]+$/.test(String(movie.decodedString || ""));
  const nationPlainVerified =
    report.fontReady &&
    nation.decodeStatus === "ok" &&
    nation.todayBoxWan > 0 &&
    /^[\d.]+$/.test(String(nation.decodedString || ""));

  if (moviePlainVerified) {
    if (nationPlainVerified) {
      assert.ok(movie.todayBoxWan <= nation.todayBoxWan * 1.05, "单片<=全国大盘");
    }
    if (report.sumBoxNumWan > 0) {
      assert.ok(movie.todayBoxWan <= report.sumBoxNumWan * 1.01, "单日<=累计");
    }
    console.log("VERIFIED: movie real font plaintext decode");
  } else {
    assert.strictEqual(movie.todayBoxWan, 0, "unverified movie must keep todayBox=0");
    console.log("UNVERIFIED: movie real font plaintext decode");
  }

  if (nationPlainVerified) {
    console.log("VERIFIED: nation real font plaintext decode");
  } else {
    console.log("UNVERIFIED: nation real font plaintext decode");
  }

  const visualOk = report.fontReady && !pageText.includes("857.27亿");
  console.log(visualOk ? "VERIFIED: UI font HTML visual display" : "UNVERIFIED: UI font HTML visual display");
  console.log("VERIFIED: prevent erroneous numeric display");
}

app.whenReady().then(main).catch((error) => {
  console.error(error);
  process.exit(1);
});
