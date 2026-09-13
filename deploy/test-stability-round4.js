/**
 * 第四轮稳定性回归：node deploy/test-stability-round4.js
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-stability-"));
}

async function testBrowserStateRecheckFailureKeepsOld() {
  const dir = tempDir();
  const storagePath = path.join(dir, "browser_state.json");
  const oldContent = JSON.stringify({
    cookies: [
      { name: "passport_token", value: "old-token", domain: ".maoyan.com" },
      { name: "csrfToken", value: "abc", domain: ".maoyan.com" },
    ],
    origins: [],
  });
  fs.writeFileSync(storagePath, oldContent);
  const oldHash = sha256File(storagePath);

  const sessionCapPath = require.resolve("../lib/session-capability");
  const loginBrowserPath = require.resolve("../lib/login-browser");
  delete require.cache[sessionCapPath];
  delete require.cache[loginBrowserPath];

  const sessionCap = require("../lib/session-capability");
  let verifyCalls = 0;
  const originalVerify = sessionCap.verifyCapabilitiesInContext;
  sessionCap.verifyCapabilitiesInContext = async () => {
    verifyCalls += 1;
    if (verifyCalls === 1) return { detailApiReady: true };
    return { detailApiReady: false, lastVerifyError: "detail_api_unavailable" };
  };

  const { persistLoginState } = require("../lib/login-browser");
  const mockContext = {
    storageState: async (opts) => {
      if (opts?.path) {
        fs.writeFileSync(
          opts.path,
          JSON.stringify({
            cookies: [
              { name: "passport_token", value: "new-token", domain: ".maoyan.com" },
              { name: "csrfToken", value: "abc", domain: ".maoyan.com" },
            ],
            origins: [],
          }),
        );
      }
      return JSON.parse(fs.readFileSync(storagePath, "utf-8"));
    },
  };

  await assert.rejects(() => persistLoginState(mockContext, storagePath), /detail_api_not_ready/);
  assert.strictEqual(sha256File(storagePath), oldHash, "official browser_state must stay unchanged");
  assert.ok(!fs.existsSync(path.join(dir, "browser_state.pending.json")));

  sessionCap.verifyCapabilitiesInContext = originalVerify;
  delete require.cache[loginBrowserPath];
  console.log("PASS browser_state recheck failure keeps old SHA256");
}

function testPendingCommitRollback() {
  const dir = tempDir();
  const storagePath = path.join(dir, "browser_state.json");
  const oldContent = JSON.stringify({ cookies: [{ name: "passport_token", value: "keep", domain: ".maoyan.com" }] });
  fs.writeFileSync(storagePath, oldContent);
  const oldHash = sha256File(storagePath);

  const {
    pendingStoragePath,
    commitPendingStorageState,
  } = require("../lib/login-browser");

  const pendingPath = pendingStoragePath(storagePath);
  fs.writeFileSync(pendingPath, JSON.stringify({ cookies: [{ name: "passport_token", value: "new", domain: ".maoyan.com" }] }));

  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(from).endsWith(".pending.json") && String(to).endsWith("browser_state.json")) {
      throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    }
    return originalRename(from, to);
  };

  try {
    assert.throws(() => commitPendingStorageState(storagePath), /EBUSY/);
  } finally {
    fs.renameSync = originalRename;
  }

  assert.strictEqual(sha256File(storagePath), oldHash, "rollback must restore old official state");
  console.log("PASS pending rename failure rollback");
}

async function testLoginVerifySingleflight() {
  const sessionCapPath = require.resolve("../lib/session-capability");
  const loginBrowserPath = require.resolve("../lib/login-browser");
  delete require.cache[sessionCapPath];
  delete require.cache[loginBrowserPath];

  const sessionCap = require("../lib/session-capability");
  const {
    runLoginVerifySingleflight,
    _resetLoginVerifyInflight,
    _getLoginVerifyInflight,
  } = require("../lib/login-browser");

  let concurrent = 0;
  let maxConcurrent = 0;
  let verifyCalls = 0;

  sessionCap.verifyCapabilitiesInContext = async () => {
    verifyCalls += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 120));
    concurrent -= 1;
    return { detailApiReady: true };
  };

  _resetLoginVerifyInflight();
  const tasks = Array.from({ length: 10 }, () =>
    runLoginVerifySingleflight(() => sessionCap.verifyCapabilitiesInContext({})),
  );
  await Promise.all(tasks);

  assert.strictEqual(maxConcurrent, 1, "verifyCapabilitiesInContext must not run concurrently");
  assert.strictEqual(verifyCalls, 1, "singleflight should coalesce 10 calls into 1 verify");
  assert.strictEqual(_getLoginVerifyInflight(), null);

  delete require.cache[sessionCapPath];
  delete require.cache[loginBrowserPath];
  console.log("PASS login verify singleflight");
}

async function testForceVerifyNoConcurrent() {
  const dir = tempDir();
  process.env.MAOYAN_DATA_DIR = dir;
  fs.writeFileSync(
    path.join(dir, "browser_state.json"),
    JSON.stringify({
      cookies: [
        { name: "passport_token", value: "test", domain: ".maoyan.com" },
        { name: "csrfToken", value: "csrf", domain: ".maoyan.com" },
      ],
      origins: [],
    }),
  );
  fs.writeFileSync(path.join(dir, "config.ini"), "port=8765\nchromePath=\n");

  const sessionCapPath = require.resolve("../lib/session-capability");
  delete require.cache[sessionCapPath];
  const sessionCap = require("../lib/session-capability");
  const original = sessionCap.verifyCapabilitiesInContext;
  let concurrent = 0;
  let maxConcurrent = 0;
  let runs = 0;
  sessionCap.verifyCapabilitiesInContext = async () => {
    runs += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 80));
    concurrent -= 1;
    return {
      detailApiReady: true,
      identityCookieExists: true,
      signatureReady: true,
      browserSessionVerified: true,
      dashboardAvailable: true,
      signatureCaptured: true,
      detailPayloadValid: true,
    };
  };

  const sigManager = await import("../server/lib/sigManager.js");
  const origFetch = sigManager.manager.fetchDashboardMovie;
  sigManager.manager.fetchDashboardMovie = async () => ({
    movieList: { list: [{ movieId: 1, movieName: "测试" }] },
  });
  const origLaunch = sigManager.manager.launchBrowserContext;
  sigManager.manager.launchBrowserContext = async () => ({
    browser: { close: async () => {} },
    context: { close: async () => {}, pages: () => [] },
  });
  const origClose = sigManager.manager.closeBrowserSession;
  sigManager.manager.closeBrowserSession = async () => {};

  const { _resetVerifyInflight, _getVerifyInflightState, runCapabilityVerify } = await import(
    "../server/lib/capability-verify.js"
  );
  _resetVerifyInflight();

  const p1 = runCapabilityVerify({ force: true });
  const p2 = runCapabilityVerify({ force: true });
  const p3 = runCapabilityVerify({ force: true });
  assert.strictEqual(p1 === p2 && p2 === p3, true, "concurrent calls must share one inflight promise reference");
  await Promise.all([p1, p2, p3]);
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.strictEqual(maxConcurrent, 1, "server verify must not run concurrently");
  assert.ok(runs <= 2, `expected at most 2 verify runs (initial + rerun), got ${runs}`);
  assert.strictEqual(_getVerifyInflightState().verifyInflight, null);

  sessionCap.verifyCapabilitiesInContext = original;
  sigManager.manager.fetchDashboardMovie = origFetch;
  sigManager.manager.launchBrowserContext = origLaunch;
  sigManager.manager.closeBrowserSession = origClose;
  _resetVerifyInflight();
  console.log("PASS force verify no concurrent (server)");
}

function testSessionStatusForceRerun() {
  const {
    resetSessionStatus,
    mergeSessionStatus,
    scheduleBackgroundVerify,
    getSessionStatus,
    _resetVerifyState,
    _getVerifyState,
  } = require("../lib/session-status");

  resetSessionStatus();
  _resetVerifyState();
  mergeSessionStatus({ detailApiReady: true, lastVerifyAt: new Date().toISOString() });

  let httpCalls = 0;
  const http = require("http");
  const originalGet = http.get;
  http.get = (url, opts, cb) => {
    httpCalls += 1;
    const res = {
      statusCode: 200,
      on(event, handler) {
        if (event === "data") handler(JSON.stringify({ detailApiReady: true, lastVerifyAt: new Date().toISOString() }));
        if (event === "end") handler();
      },
    };
    if (typeof opts === "function") {
      opts(res);
      return { on() {}, destroy() {} };
    }
    cb(res);
    return { on() {}, setTimeout() {}, destroy() {} };
  };

  try {
    scheduleBackgroundVerify("http://127.0.0.1:8765", null, { force: true });
    scheduleBackgroundVerify("http://127.0.0.1:8765", null, { force: true });
    assert.strictEqual(_getVerifyState().forceRerunRequested, true);
    assert.strictEqual(_getVerifyState().verifyRunning, true);
  } finally {
    http.get = originalGet;
    resetSessionStatus();
  }

  console.log("PASS session-status force sets rerun without concurrent start");
}

function test401ElectronSessionInvalidation() {
  const { resetSessionStatus, mergeSessionStatus, applySessionApiError, getSessionStatus } = require("../lib/session-status");
  resetSessionStatus();
  mergeSessionStatus({
    detailApiReady: true,
    browserSessionVerified: true,
    signatureReady: true,
    identityCookieExists: true,
    accountLoggedIn: true,
  });

  applySessionApiError("upstream_401");
  const status = getSessionStatus();
  assert.strictEqual(status.detailApiReady, false);
  assert.strictEqual(status.browserSessionVerified, false);
  assert.strictEqual(status.signatureReady, false);
  assert.strictEqual(status.accountLoggedIn, false);
  console.log("PASS 401 invalidates Electron session immediately");
}

function test403SignatureInvalidationKeepsIdentity() {
  const { resetSessionStatus, mergeSessionStatus, applySessionApiError, getSessionStatus } = require("../lib/session-status");
  resetSessionStatus();
  mergeSessionStatus({
    detailApiReady: true,
    signatureReady: true,
    identityCookieExists: true,
    accountLoggedIn: true,
  });

  applySessionApiError("upstream_403");
  const status = getSessionStatus();
  assert.strictEqual(status.signatureReady, false);
  assert.strictEqual(status.detailApiReady, false);
  assert.strictEqual(status.identityCookieExists, true);
  console.log("PASS 403 invalidates signature/detail but keeps identityCookieExists");
}

function testGetBoxShowUrlMatching() {
  const { matchesGetBoxShowRequest } = require("../lib/session-capability");
  const movieId = "1462628";
  const boxLevel = "1";
  const urls = [
    `https://piaofang.maoyan.com/i/api/movie/getBoxShow?movieId=${movieId}&boxLevel=${boxLevel}`,
    `https://piaofang.maoyan.com/i/api/movie/getBoxShow?boxLevel=${boxLevel}&movieId=${movieId}`,
    `https://piaofang.maoyan.com/i/api/movie/getBoxShow?movieId=${movieId}&foo=x&boxLevel=${boxLevel}`,
  ];
  for (const url of urls) {
    assert.ok(matchesGetBoxShowRequest(url, movieId, boxLevel), `should match ${url}`);
  }
  assert.ok(
    !matchesGetBoxShowRequest(
      `https://piaofang.maoyan.com/i/api/movie/getBoxShow?movieId=999&boxLevel=${boxLevel}`,
      movieId,
      boxLevel,
    ),
  );
  console.log("PASS getBoxShow URL param order matching");
}

function testLiveOutputSettingsSave() {
  const { saveSettings, loadSettings, SETTINGS_PATH } = require("../lib/settings");
  const backup = fs.existsSync(SETTINGS_PATH) ? fs.readFileSync(SETTINGS_PATH, "utf-8") : null;
  try {
    saveSettings({ window: { liveOutput: true } });
    const loaded = loadSettings();
    assert.strictEqual(loaded.window.liveOutput, true);
    saveSettings({ window: { liveOutput: false } });
    assert.strictEqual(loadSettings().window.liveOutput, false);
  } finally {
    if (backup !== null) fs.writeFileSync(SETTINGS_PATH, backup);
    else if (fs.existsSync(SETTINGS_PATH)) fs.unlinkSync(SETTINGS_PATH);
  }
  console.log("PASS liveOutput settings save and load");
}

function testLoginBrowserNoDirectOfficialWrite() {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "login-browser.js"), "utf-8");
  assert.ok(!source.includes("SAVE_INTERVAL_MS"), "saveInterval should be removed");
  assert.ok(!source.match(/storageState\(\{\s*path:\s*storageStatePath\s*\}\)/), "must not write official state during login poll");
  console.log("PASS login-browser does not write official browser_state during poll");
}

async function main() {
  await testBrowserStateRecheckFailureKeepsOld();
  testPendingCommitRollback();
  await testLoginVerifySingleflight();
  await testForceVerifyNoConcurrent();
  testSessionStatusForceRerun();
  test401ElectronSessionInvalidation();
  test403SignatureInvalidationKeepsIdentity();
  testGetBoxShowUrlMatching();
  testLiveOutputSettingsSave();
  testLoginBrowserNoDirectOfficialWrite();
  console.log("ALL PASSED (stability round 4)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
