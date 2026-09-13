/**
 * 登录/会话能力 integration test：node deploy/test-session-capability.js
 * 无 Chrome 或 browser_state 时自动 SKIP，不让 CI 失败。
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.MAOYAN_DATA_DIR || path.join(ROOT, "data");
const STORAGE_STATE = path.join(DATA_DIR, "browser_state.json");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Bin\\chrome.exe",
];

function resolveChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
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
  } = require("../lib/session-capability");

  assert.strictEqual(typeof validateDetailApiPayload, "function");
  assert.strictEqual(typeof validateDashboardPayload, "function");

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
      const resp = await fetchJson(`${apiBase}/api/verify-capabilities`, 60000);
      serverResult = resp.data;
    } catch (error) {
      serverResult = { error: error.message };
    }
  }

  const summary = {
    dashboardAvailable: serverResult?.dashboardAvailable ?? browserResult?.dashboardAvailable ?? false,
    browserSessionVerified: browserResult?.browserSessionVerified ?? false,
    signatureReady: serverResult?.signatureReady ?? browserResult?.signatureReady ?? false,
    detailApiReady: serverResult?.detailApiReady ?? browserResult?.detailApiReady ?? false,
    identityCookieExists: browserResult?.identityCookieExists ?? false,
    serverUp,
  };

  console.log("Session capability summary:", JSON.stringify(summary, null, 2));

  assert.ok(typeof browserResult?.detailApiReady === "boolean");
  assert.ok(typeof browserResult?.dashboardAvailable === "boolean");
  console.log("ALL PASSED (session capability integration)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
