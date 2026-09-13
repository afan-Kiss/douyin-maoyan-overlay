/**
 * 会话持久化回归：node deploy/test-session-persist.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-persist-"));
  const state = {
    cookies: [{ name: "passport_token", value: "tok", domain: ".maoyan.com", path: "/" }],
    origins: [],
  };
  fs.writeFileSync(path.join(dir, "browser_state.json"), JSON.stringify(state));
  return dir;
}

async function testServerSnapshotLifecycle() {
  const dir = makeDataDir();
  process.env.MAOYAN_DATA_DIR = dir;
  const {
    saveSessionCapability,
    isPersistedSessionUsable,
    loadSessionCapability,
  } = require("../lib/session-persist");
  const cap = await import("../server/lib/capability-state.js");

  cap._resetCapabilityStateForTest();
  cap.markDetailApiSuccess();
  assert.strictEqual(isPersistedSessionUsable(dir), true);

  cap.markSignatureFailure("sig failed");
  assert.strictEqual(isPersistedSessionUsable(dir), false);
  assert.strictEqual(cap.getLastCapabilityVerify().signatureReady, false);
  console.log("PASS markSignatureFailure clears persisted usable snapshot");

  saveSessionCapability(dir, {
    capability: {
      detailApiReady: true,
      detailPayloadValid: true,
      signatureReady: true,
      loginRequired: false,
    },
    lastDetailApiSuccessAt: new Date().toISOString(),
  });
  cap.applyApiErrorToCapability("upstream_403");
  assert.strictEqual(isPersistedSessionUsable(dir), false);
  assert.strictEqual(loadSessionCapability(dir), null);
  assert.strictEqual(cap.getLastCapabilityVerify().detailApiReady, false);
  console.log("PASS 403 clears server session_capability snapshot");
}

function test401ClearsWithoutPriorGetSessionStatus() {
  const dir = makeDataDir();
  process.env.MAOYAN_DATA_DIR = dir;
  const { saveSessionCapability, loadSessionCapability } = require("../lib/session-persist");
  const {
    resetSessionStatus,
    applySessionApiError,
    getSessionStatus,
  } = require("../lib/session-status");

  saveSessionCapability(dir, {
    capability: {
      detailApiReady: true,
      detailPayloadValid: true,
      signatureReady: true,
      loginRequired: false,
    },
    lastDetailApiSuccessAt: new Date().toISOString(),
  });
  resetSessionStatus();
  applySessionApiError("upstream_401");
  const status = getSessionStatus(dir);
  assert.strictEqual(status.loginRequired, true);
  assert.strictEqual(loadSessionCapability(dir), null);
  console.log("PASS 401 clears snapshot without prior getSessionStatus");
}

function testStartupVerifyNotSkippedByHydrate() {
  const dir = makeDataDir();
  const { saveSessionCapability } = require("../lib/session-persist");
  const {
    resetSessionStatus,
    getSessionStatus,
    scheduleBackgroundVerify,
    _getVerifyState,
  } = require("../lib/session-status");

  saveSessionCapability(dir, {
    capability: {
      detailApiReady: true,
      detailPayloadValid: true,
      signatureReady: true,
      loginRequired: false,
    },
    savedAt: new Date().toISOString(),
  });
  resetSessionStatus();
  getSessionStatus(dir);
  scheduleBackgroundVerify("http://127.0.0.1:1", dir, { startup: true });
  assert.strictEqual(_getVerifyState().verifyRunning, true);
  console.log("PASS startup verify runs despite hydrated 5min TTL");
}

function testEmptyFingerprintNoMatch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-fp-"));
  const { saveSessionCapability, loadSessionCapability } = require("../lib/session-persist");
  const { fingerprintMatches } = require("../lib/session-persist");
  saveSessionCapability(dir, {
    capability: { detailApiReady: true, detailPayloadValid: true, signatureReady: true },
    lastDetailApiSuccessAt: new Date().toISOString(),
  });
  const snap = loadSessionCapability(dir);
  assert.strictEqual(fingerprintMatches(dir, snap), false);
  console.log("PASS empty fingerprint does not match stale snapshot");
}

async function main() {
  await testServerSnapshotLifecycle();
  test401ClearsWithoutPriorGetSessionStatus();
  testStartupVerifyNotSkippedByHydrate();
  testEmptyFingerprintNoMatch();
  console.log("ALL PASSED (session persist)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
