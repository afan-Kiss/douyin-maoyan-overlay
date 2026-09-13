/**
 * 登录/会话能力 integration test：node deploy/test-session-capability.js
 * CI 模式：无 Chrome/browser_state 时 SKIP。
 * 严格模式：CAPABILITY_STRICT=1，要求四项能力全部为 true。
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.MAOYAN_DATA_DIR || path.join(ROOT, "data");
const STORAGE_STATE = path.join(DATA_DIR, "browser_state.json");
const STRICT = process.env.CAPABILITY_STRICT === "1";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Bin\\chrome.exe",
  process.env.CHROME_PATH,
].filter(Boolean);

function resolveChrome() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p));
}

function readConfigPort() {
  const ini = path.join(DATA_DIR, "config.ini");
  if (!fs.existsSync(ini)) return 8765;
  const text = fs.readFileSync(ini, "utf-8");
  const m = text.match(/^\s*port\s*=\s*(\d+)\s*$/im);
  return m ? Number(m[1]) : 8765;
}

function fetchJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function main() {
  const {
    validateDetailApiPayload,
    validateDashboardPayload,
    verifyCapabilitiesInContext,
    pickVerifyMovieFromDashboard,
  } = require("../lib/session-capability");

  assert.strictEqual(typeof validateDetailApiPayload, "function");
  assert.strictEqual(typeof validateDashboardPayload, "function");
  assert.strictEqual(typeof pickVerifyMovieFromDashboard, "function");

  const chromePath = resolveChrome();
  const hasState = fs.existsSync(STORAGE_STATE);

  if (!chromePath || !hasState) {
    console.log("SKIP: Chrome or browser_state.json not available");
    process.exit(0);
  }

  process.env.MAOYAN_DATA_DIR = DATA_DIR;

  const port = readConfigPort();
  const apiBase = `http://127.0.0.1:${port}`;

  let serverUp = false;
  try {
    const health = await fetchJson(`${apiBase}/health`, 2000);
    serverUp = health.status === 200 && health.data?.ok === true;
  } catch {
    serverUp = false;
  }

  let browserResult = null;
  const { chromium } = require("playwright");
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext({ storageState: STORAGE_STATE, locale: "zh-CN" });
    browserResult = await verifyCapabilitiesInContext(context);
    await context.close();
  } finally {
    await browser.close();
  }

  let serverResult = null;
  if (serverUp) {
    try {
      const resp = await fetchJson(`${apiBase}/api/verify-capabilities?force=1`, 120000);
      serverResult = resp.data;
    } catch (error) {
      serverResult = { error: error.message };
    }
  }

  const summary = {
    dashboardAvailable: serverResult?.dashboardAvailable ?? browserResult?.dashboardAvailable ?? false,
    browserSessionVerified: serverResult?.browserSessionVerified ?? browserResult?.browserSessionVerified ?? false,
    signatureReady: serverResult?.signatureReady ?? browserResult?.signatureReady ?? false,
    detailApiReady: serverResult?.detailApiReady ?? browserResult?.detailApiReady ?? false,
    identityCookieExists: browserResult?.identityCookieExists ?? serverResult?.identityCookieExists ?? false,
    verifyMovieId: serverResult?.verifyMovieId ?? browserResult?.verifyMovieId ?? null,
    verifySource: serverResult?.verifySource ?? browserResult?.verifySource ?? null,
    signatureCaptured: serverResult?.signatureCaptured ?? browserResult?.signatureCaptured ?? false,
    detailHttpStatus: serverResult?.detailHttpStatus ?? browserResult?.detailHttpStatus ?? null,
    detailPayloadValid: serverResult?.detailPayloadValid ?? browserResult?.detailPayloadValid ?? false,
    serverUp,
  };

  console.log("Session capability summary:", JSON.stringify(summary, null, 2));

  assert.ok(typeof browserResult?.detailApiReady === "boolean");
  assert.ok(typeof browserResult?.dashboardAvailable === "boolean");

  const allReady =
    summary.dashboardAvailable === true &&
    summary.browserSessionVerified === true &&
    summary.signatureReady === true &&
    summary.detailApiReady === true;

  if (STRICT) {
    if (!allReady) {
      console.error("CAPABILITY NOT READY (strict mode)");
      process.exit(1);
    }
    console.log("LIVE CAPABILITY PASSED");
    process.exit(0);
  }

  if (!allReady) {
    console.log("CAPABILITY NOT READY");
    process.exit(0);
  }

  console.log("LIVE CAPABILITY PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
