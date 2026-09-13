const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { verifyCapabilitiesInContext } = require("./session-capability");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

function readChromePath(dataDir) {
  const configFile = path.join(dataDir, "config.ini");
  if (!fs.existsSync(configFile)) return "";
  try {
    const text = fs.readFileSync(configFile, "utf-8");
    const match =
      text.match(/^\s*path\s*=\s*(.+)\s*$/m) ||
      text.match(/^\s*路径\s*=\s*(.+)\s*$/m);
    const manual = match ? match[1].trim() : "";
    if (manual && fs.existsSync(manual)) return manual;
  } catch {
    /* noop */
  }
  const local = process.env.LOCALAPPDATA || "";
  const candidates = [
    path.join(local, "Google", "Chrome", "Bin", "chrome.exe"),
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return "";
}

async function launchProductionContext(storageStatePath, options = {}) {
  const dataDir = options.dataDir || path.dirname(storageStatePath);
  const chromePath = readChromePath(dataDir);
  if (!chromePath || !fs.existsSync(chromePath)) {
    throw new Error("chrome_not_found");
  }

  const headless = options.headless !== false;
  const browser = await chromium.launch({
    headless,
    executablePath: chromePath,
    args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox"],
  });

  const ctxOpts = { userAgent: USER_AGENT, locale: "zh-CN" };
  if (fs.existsSync(storageStatePath)) {
    ctxOpts.storageState = storageStatePath;
  }
  const context = await browser.newContext(ctxOpts);
  return { browser, context, chromePath, headless };
}

async function verifyProductionCapabilities(storageStatePath, options = {}) {
  let browser;
  let context;
  try {
    ({ browser, context } = await launchProductionContext(storageStatePath, options));
    const result = await verifyCapabilitiesInContext(context, {
      checkDashboard: true,
      verifySource: "production-path",
    });
    return {
      ...result,
      loginCookieReady: Boolean(result.identityCookieExists),
      productionDetailReady: Boolean(result.detailApiReady),
      loginRequired: result.lastVerifyError === "detail_http_401",
      sessionUsable: Boolean(result.identityCookieExists && result.detailApiReady),
      accountLoggedIn: Boolean(result.identityCookieExists),
    };
  } catch (error) {
    return {
      identityCookieExists: false,
      loginCookieReady: false,
      productionDetailReady: false,
      detailApiReady: false,
      loginRequired: false,
      sessionUsable: false,
      accountLoggedIn: false,
      lastVerifyError: String(error?.message || error || "production_verify_failed"),
    };
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

async function runHeadlessHeadedDiagnostic(storageStatePath, options = {}) {
  const movieId = String(options.movieId || "1462628");
  const modes = [
    { mode: "headless", headless: true },
    { mode: "headed", headless: false },
  ];
  const results = [];

  for (const { mode, headless } of modes) {
    let browser;
    let context;
    let page;
    const captured = {
      mode,
      dashboardLoaded: false,
      boxPageLoaded: false,
      finalUrlHost: "",
      finalPath: "",
      getBoxShowRequestSeen: false,
      signatureCaptured: false,
      detailHttpStatus: null,
      detailPayloadValid: false,
      lastVerifyError: null,
    };

    try {
      ({ browser, context } = await launchProductionContext(storageStatePath, {
        ...options,
        headless,
      }));
      page = await context.newPage();

      const { matchesGetBoxShowRequest, validateDetailApiPayload } = require("./session-capability");
      const BOX_PAGE = (id) =>
        `https://piaofang.maoyan.com/i/imovie/${id}/box?barTheme=592828`;

      page.on("response", async (resp) => {
        const url = resp.url();
        if (!matchesGetBoxShowRequest(url, movieId, "1")) return;
        captured.getBoxShowRequestSeen = true;
        captured.detailHttpStatus = resp.status();
        try {
          const text = await resp.text();
          const data = JSON.parse(text);
          captured.detailPayloadValid = validateDetailApiPayload(data);
        } catch {
          captured.detailPayloadValid = false;
        }
        const req = resp.request();
        const headers = req.headers();
        if (headers.mtgsig) captured.signatureCaptured = true;
      });

      await page.goto("https://piaofang.maoyan.com/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });
      await page.waitForTimeout(1000);
      try {
        captured.dashboardLoaded = await page.evaluate(() =>
          location.hostname.includes("piaofang"),
        );
      } catch {
        captured.dashboardLoaded = false;
      }

      await page.goto(BOX_PAGE(movieId), { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForTimeout(1500);

      try {
        const loc = await page.evaluate(() => ({
          host: location.hostname,
          path: location.pathname,
        }));
        captured.finalUrlHost = loc.host;
        captured.finalPath = loc.path;
        captured.boxPageLoaded =
          loc.host.includes("piaofang") &&
          (loc.path.includes(`/imovie/${movieId}/box`) || loc.path.includes("/box"));
      } catch {
        captured.boxPageLoaded = false;
      }

      if (!captured.boxPageLoaded) captured.lastVerifyError = "box_page_not_loaded";
      else if (!captured.getBoxShowRequestSeen) captured.lastVerifyError = "getboxshow_request_not_seen";
      else if (!captured.signatureCaptured) captured.lastVerifyError = "mtgsig_not_captured";
      else if (!(captured.detailHttpStatus >= 200 && captured.detailHttpStatus < 300)) {
        captured.lastVerifyError = `detail_http_${captured.detailHttpStatus || 0}`;
      } else if (!captured.detailPayloadValid) {
        captured.lastVerifyError = "detail_payload_invalid";
      }
    } catch (error) {
      captured.lastVerifyError = String(error?.message || error || "diagnostic_failed");
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }

    results.push(captured);
  }

  const headlessResult = results.find((r) => r.mode === "headless");
  const headedResult = results.find((r) => r.mode === "headed");
  const headedOk =
    headedResult?.signatureCaptured &&
    headedResult?.detailHttpStatus >= 200 &&
    headedResult?.detailHttpStatus < 300 &&
    headedResult?.detailPayloadValid;
  const headlessOk =
    headlessResult?.signatureCaptured &&
    headlessResult?.detailHttpStatus >= 200 &&
    headlessResult?.detailHttpStatus < 300 &&
    headlessResult?.detailPayloadValid;

  return {
    results,
    diagnosis:
      headedOk && !headlessOk
        ? "HEADLESS_PATH_INCOMPATIBLE"
        : headedOk && headlessOk
          ? "BOTH_OK"
          : !headedOk && !headlessOk
            ? "BOTH_FAIL"
            : "HEADED_FAIL_HEADLESS_OK",
  };
}

module.exports = {
  launchProductionContext,
  verifyProductionCapabilities,
  runHeadlessHeadedDiagnostic,
};
