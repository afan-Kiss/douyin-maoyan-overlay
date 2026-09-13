import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { DATA_DIR } from "./config.js";
import { manager } from "./sigManager.js";
import {
  getLastCapabilityVerify,
  setLastCapabilityVerify,
  getSignatureTTLStatus,
  isRecentDetailApiSuccess,
  isPersistedDetailSuccess,
  hydrateCapabilityFromDisk,
} from "./capability-state.js";

const require = createRequire(import.meta.url);
const {
  verifyCapabilitiesInContext,
  validateDashboardPayload,
  pickVerifyMovieFromDashboard,
} = require("../../lib/session-capability.js");

let activeRun = null;
let chainPromise = null;
let forceRerunRequested = false;

export function getLastCapabilityVerifyResult() {
  return getLastCapabilityVerify();
}

async function executeCapabilityVerify(options = {}) {
  const force = Boolean(options.force);
  hydrateCapabilityFromDisk(DATA_DIR);
  const base = getLastCapabilityVerify();
  const sigStatus = getSignatureTTLStatus(manager.hasFreshSignature());
  const result = {
    ...base,
    loginCookieReady: base.identityCookieExists,
    productionDetailReady: false,
    loginRequired: false,
    accountLoggedIn: base.identityCookieExists,
    sessionUsable: false,
    browserSessionReady: base.identityCookieExists,
    browserSessionVerified: false,
    signatureReady: sigStatus.signatureReady,
    detailApiReady: false,
    dashboardAvailable: false,
    verifyMovieId: null,
    verifyMovieName: null,
    verifySource: null,
    signatureCaptured: false,
    signatureSource: null,
    detailHttpStatus: null,
    detailPayloadValid: false,
    lastVerifyAt: new Date().toISOString(),
    lastVerifyError: null,
  };

  if (!base.storageStateExists) {
    result.lastVerifyError = "storage_state_missing";
    return setLastCapabilityVerify(result);
  }

  let dashboardData = null;
  let verifyPick = null;
  try {
    dashboardData = await manager.fetchDashboardMovie({}, { forceRefresh: false });
    result.dashboardAvailable = validateDashboardPayload(dashboardData);
    verifyPick = pickVerifyMovieFromDashboard(dashboardData);
  } catch {
    result.dashboardAvailable = false;
    dashboardData = null;
    verifyPick = null;
  }

  const persistedDetailOk = isPersistedDetailSuccess();
  const detailSuccessFresh =
    isRecentDetailApiSuccess() || persistedDetailOk;

  // cookie + 磁盘新鲜 mtgsig +（内存或本地持久化的）detail 成功 → 跳过浏览器验签
  if (
    !force &&
    base.identityCookieExists &&
    manager.hasFreshSignature() &&
    detailSuccessFresh &&
    (base.detailPayloadValid || persistedDetailOk)
  ) {
    result.signatureReady = true;
    result.detailApiReady = true;
    result.productionDetailReady = true;
    result.browserSessionVerified = Boolean(base.browserSessionVerified);
    result.sessionUsable = true;
    result.accountLoggedIn = true;
    result.loginCookieReady = true;
    result.detailPayloadValid = true;
    result.lastVerifyError = null;
    if (verifyPick?.verifyMovieId) {
      result.verifyMovieId = verifyPick.verifyMovieId;
      result.verifyMovieName = verifyPick.verifyMovieName;
      result.verifySource = verifyPick.verifySource || "fresh_signature_skip";
    } else {
      result.verifySource = "fresh_signature_skip";
    }
    return setLastCapabilityVerify(result);
  }

  let browser;
  let context;
  try {
    ({ browser, context } = await manager.launchBrowserContext());
    const verified = await verifyCapabilitiesInContext(context, {
      checkDashboard: !result.dashboardAvailable,
      dashboardData,
      movieId: verifyPick?.verifyMovieId,
      verifyMovieName: verifyPick?.verifyMovieName,
      verifySource: verifyPick?.verifySource,
    });
    Object.assign(result, verified);
    if (result.dashboardAvailable) {
      result.dashboardAvailable = true;
    }
  } catch (error) {
    result.detailApiReady = false;
    result.productionDetailReady = false;
    result.browserSessionVerified = false;
    result.signatureReady = false;
    result.sessionUsable = false;
    result.lastVerifyError = String(error?.message || error || "verify_failed");
  } finally {
    if (browser || context) {
      await manager.closeBrowserSession(browser, context);
    }
  }

  result.loginCookieReady = Boolean(result.identityCookieExists);
  result.productionDetailReady = Boolean(result.detailApiReady);
  result.accountLoggedIn = Boolean(result.identityCookieExists);
  if (result.loginRequired) {
    result.signatureReady = false;
    result.detailApiReady = false;
    result.productionDetailReady = false;
    result.sessionUsable = false;
  } else {
    result.sessionUsable = Boolean(
      result.identityCookieExists && result.detailApiReady && !result.loginRequired,
    );
  }
  if (!result.detailApiReady && !result.lastVerifyError) {
    result.lastVerifyError = "detail_api_unavailable";
  }

  return setLastCapabilityVerify(result);
}

function startVerifyChain(options = {}) {
  chainPromise = (async () => {
    let result;
    do {
      const force = Boolean(options.force) || forceRerunRequested;
      forceRerunRequested = false;
      activeRun = executeCapabilityVerify({ force });
      result = await activeRun;
    } while (forceRerunRequested);
    return result;
  })().finally(() => {
    activeRun = null;
    chainPromise = null;
  });

  return chainPromise;
}

export function runCapabilityVerify(options = {}) {
  const force = Boolean(options.force);

  if (chainPromise) {
    if (force) {
      forceRerunRequested = true;
      return chainPromise;
    }
    return activeRun || chainPromise;
  }

  return startVerifyChain(options);
}

export function isLoginInProgress() {
  try {
    return fs.existsSync(path.join(DATA_DIR, "login.lock"));
  } catch {
    return false;
  }
}

export function _resetVerifyInflight() {
  activeRun = null;
  chainPromise = null;
  forceRerunRequested = false;
}

export function _getVerifyInflightState() {
  return { verifyInflight: chainPromise, forceRerunRequested };
}
