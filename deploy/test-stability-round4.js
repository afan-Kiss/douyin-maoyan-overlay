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

async function testStableHitsOnlyCountsRealExecutions() {
  const sessionCapPath = require.resolve("../lib/session-capability");
  const loginBrowserPath = require.resolve("../lib/login-browser");
  delete require.cache[sessionCapPath];
  delete require.cache[loginBrowserPath];

  const sessionCap = require("../lib/session-capability");
  const { runLoginVerifySingleflight, _resetLoginVerifyInflight, STABLE_LOGIN_HITS } = require("../lib/login-browser");

  let verifyCalls = 0;
  sessionCap.verifyCapabilitiesInContext = async () => {
    verifyCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { detailApiReady: true };
  };

  _resetLoginVerifyInflight();
  let stableHits = 0;
  const tasks = Array.from({ length: 10 }, async () => {
    const { result, reused } = await runLoginVerifySingleflight(() =>
      sessionCap.verifyCapabilitiesInContext({}),
    );
    if (result?.detailApiReady && !reused) stableHits += 1;
  });
  await Promise.all(tasks);
  assert.strictEqual(verifyCalls, 1, "10 polls must coalesce into 1 verify execution");
  assert.strictEqual(stableHits, 1, "single inflight reuse must only add 1 stable hit");

  _resetLoginVerifyInflight();
  stableHits = 0;
  for (let i = 0; i < STABLE_LOGIN_HITS; i++) {
    const { result, reused } = await runLoginVerifySingleflight(() =>
      sessionCap.verifyCapabilitiesInContext({}),
    );
    if (result?.detailApiReady && !reused) stableHits += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.strictEqual(verifyCalls, 3, "two sequential verifies should run after first coalesced batch");
  assert.strictEqual(stableHits, STABLE_LOGIN_HITS, "two independent successful verifies must reach stable threshold");

  delete require.cache[sessionCapPath];
  delete require.cache[loginBrowserPath];
  console.log("PASS stableHits only counts real verify executions");
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
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

  assert.strictEqual(maxConcurrent, 1, "server verify must not run concurrently");
  assert.strictEqual(runs, 2, "force callers must wait for initial + force rerun");
  assert.strictEqual(_getVerifyInflightState().verifyInflight, null);
  assert.strictEqual(r1.detailApiReady, true);
  assert.strictEqual(r2.detailApiReady, true);
  assert.strictEqual(r3.detailApiReady, true);

  sessionCap.verifyCapabilitiesInContext = original;
  sigManager.manager.fetchDashboardMovie = origFetch;
  sigManager.manager.launchBrowserContext = origLaunch;
  sigManager.manager.closeBrowserSession = origClose;
  _resetVerifyInflight();
  console.log("PASS force verify no concurrent (server)");
}

async function testSessionStatusForceRerun() {
  const {
    resetSessionStatus,
    mergeSessionStatus,
    scheduleBackgroundVerify,
    _resetVerifyState,
    _getVerifyState,
  } = require("../lib/session-status");

  resetSessionStatus();
  _resetVerifyState();
  mergeSessionStatus({ detailApiReady: true, lastVerifyAt: new Date().toISOString() });

  let httpCalls = 0;
  let maxConcurrent = 0;
  let concurrent = 0;
  const http = require("http");
  const originalGet = http.get;

  http.get = (url, opts, cb) => {
    const isVerify = String(url).includes("verify-capabilities");
    if (isVerify) {
      httpCalls += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
    }
    const res = {
      statusCode: 200,
      on(event, handler) {
        if (event === "data") {
          setTimeout(() => {
            handler(
              JSON.stringify({
                detailApiReady: true,
                lastVerifyAt: new Date().toISOString(),
              }),
            );
          }, isVerify ? 30 : 0);
        }
        if (event === "end") {
          setTimeout(() => {
            if (isVerify) concurrent -= 1;
            handler();
          }, isVerify ? 35 : 0);
        }
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
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.strictEqual(maxConcurrent, 1, "background verify must stay single-flight");
    assert.strictEqual(httpCalls, 2, "force rerun must execute verify twice");
  } finally {
    http.get = originalGet;
    resetSessionStatus();
    _resetVerifyState();
  }

  console.log("PASS session-status force rerun executes twice with maxConcurrent=1");
}

function test403RecoveryRestoresCapability() {
  const capPath = require.resolve("../server/lib/capability-state.js");
  delete require.cache[capPath];
  return import("../server/lib/capability-state.js").then((cap) => {
    cap.setLastCapabilityVerify({
      identityCookieExists: true,
      detailApiReady: true,
      signatureReady: true,
      browserSessionVerified: true,
      signatureCaptured: true,
      detailPayloadValid: true,
    });
    cap.applyApiErrorToCapability("upstream_403");
    let status = cap.getLastCapabilityVerify();
    assert.strictEqual(status.detailApiReady, false);
    assert.strictEqual(status.signatureReady, false);
    assert.strictEqual(status.identityCookieExists, true);
    assert.strictEqual(status.loginRequired, false);

    cap.markDetailApiSuccess({
      detailHttpStatus: 200,
      detailPayloadValid: true,
      verifyMovieId: "1462628",
    });
    status = cap.getLastCapabilityVerify();
    assert.strictEqual(status.signatureReady, true);
    assert.strictEqual(status.detailApiReady, true);
    assert.strictEqual(status.browserSessionVerified, true);
    assert.strictEqual(status.lastVerifyError, null);
    console.log("PASS 403 recovery restores capability success path");
  });
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
  assert.strictEqual(status.loginRequired, true);
  assert.strictEqual(status.identityCookieExists, true);
  console.log("PASS 401 invalidates detail capability and sets loginRequired");
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
  assert.strictEqual(status.loginRequired, false);
  assert.strictEqual(status.accountLoggedIn, true);
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
  await testStableHitsOnlyCountsRealExecutions();
  await testLoginVerifySingleflight();
  await testForceVerifyNoConcurrent();
  await testSessionStatusForceRerun();
  await test403RecoveryRestoresCapability();
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
