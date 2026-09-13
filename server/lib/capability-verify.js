import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { DATA_DIR } from "./config.js";
import { manager } from "./sigManager.js";
import {
  getLastCapabilityVerify,
  setLastCapabilityVerify,
  getSignatureTTLStatus,
} from "./capability-state.js";

const require = createRequire(import.meta.url);
const {
  verifyCapabilitiesInContext,
  validateDashboardPayload,
  pickVerifyMovieFromDashboard,
} = require("../../lib/session-capability.js");

let verifyInflight = null;

export function getLastCapabilityVerifyResult() {
  return getLastCapabilityVerify();
}

export async function runCapabilityVerify(options = {}) {
  if (verifyInflight && !options.force) return verifyInflight;

  verifyInflight = (async () => {
    const base = getLastCapabilityVerify();
    const sigStatus = getSignatureTTLStatus(manager.hasFreshSignature());
    const result = {
      ...base,
      accountLoggedIn: false,
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
      result.browserSessionVerified = false;
      result.signatureReady = false;
      result.lastVerifyError = String(error?.message || error || "verify_failed");
    } finally {
      if (browser || context) {
        await manager.closeBrowserSession(browser, context);
      }
    }

    result.accountLoggedIn = Boolean(result.identityCookieExists && result.detailApiReady);
    if (!result.detailApiReady && !result.lastVerifyError) {
      result.lastVerifyError = "detail_api_unavailable";
    }

    return setLastCapabilityVerify(result);
  })().finally(() => {
    verifyInflight = null;
  });

  return verifyInflight;
}

export function isLoginInProgress() {
  try {
    return fs.existsSync(path.join(DATA_DIR, "login.lock"));
  } catch {
    return false;
  }
}
