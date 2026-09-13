import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { STORAGE_STATE, SIG_TTL_SECONDS, DATA_DIR } from "./config.js";
import { manager } from "./sigManager.js";
import { log, getLastSignatureSuccessAt } from "./logger.js";

const require = createRequire(import.meta.url);
const {
  storageFileExists,
  storageFileLooksLoggedIn,
  validateDetailApiPayload,
  validateDashboardPayload,
  VERIFY_MOVIE_ID,
} = require("../../lib/session-capability.js");

let lastVerifyResult = {
  storageStateExists: false,
  identityCookieExists: false,
  accountLoggedIn: false,
  browserSessionReady: false,
  browserSessionVerified: false,
  signatureReady: false,
  detailApiReady: false,
  dashboardAvailable: false,
  lastVerifyAt: null,
  lastVerifyError: null,
};

let verifyInflight = null;

function readFileFlags() {
  return {
    storageStateExists: storageFileExists(STORAGE_STATE),
    identityCookieExists: storageFileLooksLoggedIn(STORAGE_STATE),
  };
}

export function getSignatureTTLStatus() {
  const lastAt = getLastSignatureSuccessAt();
  if (!lastAt) {
    return { signatureReady: manager.hasFreshSignature(), ageSeconds: null };
  }
  const ageSeconds = Math.round((Date.now() - new Date(lastAt).getTime()) / 1000);
  const withinTtl = ageSeconds >= 0 && ageSeconds < SIG_TTL_SECONDS;
  return {
    signatureReady: withinTtl || manager.hasFreshSignature(),
    ageSeconds,
    withinTtl,
  };
}

export function getLastCapabilityVerify() {
  return { ...lastVerifyResult, ...readFileFlags() };
}

export async function runCapabilityVerify(options = {}) {
  if (verifyInflight && !options.force) return verifyInflight;

  verifyInflight = (async () => {
    const flags = readFileFlags();
    const sigStatus = getSignatureTTLStatus();
    const result = {
      ...flags,
      accountLoggedIn: false,
      browserSessionReady: flags.identityCookieExists,
      browserSessionVerified: false,
      signatureReady: sigStatus.signatureReady,
      detailApiReady: false,
      dashboardAvailable: false,
      lastVerifyAt: new Date().toISOString(),
      lastVerifyError: null,
    };

    if (!flags.storageStateExists) {
      result.lastVerifyError = "storage_state_missing";
      lastVerifyResult = result;
      return result;
    }

    try {
      const detailRaw = await manager.fetch(VERIFY_MOVIE_ID, 1, { forceRefresh: false });
      result.detailApiReady = validateDetailApiPayload(detailRaw);
      result.browserSessionVerified = result.detailApiReady;
      if (result.detailApiReady) {
        result.signatureReady = true;
        result.browserSessionReady = true;
      }
    } catch (error) {
      result.detailApiReady = false;
      result.browserSessionVerified = false;
      result.lastVerifyError = String(error?.message || error || "detail_api_failed");
    }

    try {
      const dashRaw = await manager.fetchDashboardMovie({}, { forceRefresh: false });
      result.dashboardAvailable = validateDashboardPayload(dashRaw);
      if (result.dashboardAvailable && !result.browserSessionReady) {
        result.browserSessionReady = true;
      }
    } catch {
      result.dashboardAvailable = false;
    }

    result.accountLoggedIn = Boolean(flags.identityCookieExists && result.detailApiReady);
    if (!result.detailApiReady && !result.lastVerifyError) {
      result.lastVerifyError = "detail_api_unavailable";
    }

    lastVerifyResult = result;
    return result;
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
