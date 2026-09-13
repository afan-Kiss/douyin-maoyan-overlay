import fs from "fs";
import path from "path";
import { createRequire } from "module";
import {
  DATA_DIR,
  SESSION_CACHE_DIR,
  STORAGE_STATE,
  SIG_TTL_SECONDS,
  DETAIL_API_SUCCESS_TTL_MS,
} from "./config.js";

const require = createRequire(import.meta.url);
const { storageFileExists, storageFileLooksLoggedIn } = require("../../lib/storage-auth.js");
const {
  saveSessionCapability,
  loadSessionCapability,
  isPersistedSessionUsable,
  newestSignatureTimestamp,
  clearSessionCapability,
  fingerprintMatches,
  SESSION_PERSIST_TTL_MS,
} = require("../../lib/session-persist.js");

const EMPTY_VERIFY = {
  storageStateExists: false,
  identityCookieExists: false,
  loginCookieReady: false,
  productionDetailReady: false,
  loginRequired: false,
  accountLoggedIn: false,
  sessionUsable: false,
  browserSessionReady: false,
  browserSessionVerified: false,
  signatureReady: false,
  detailApiReady: false,
  dashboardAvailable: false,
  verifyMovieId: null,
  verifyMovieName: null,
  verifySource: null,
  signatureCaptured: false,
  signatureSource: null,
  detailHttpStatus: null,
  detailPayloadValid: false,
  lastVerifyAt: null,
  lastVerifyError: null,
};

let lastVerifyResult = { ...EMPTY_VERIFY };
let lastSignatureSuccessAt = null;
let lastSignatureError = null;
let lastDashboardSuccessAt = null;
let lastDetailApiSuccessAt = null;
let verifyGeneration = 0;
let diskHydrated = false;

function readFileFlags() {
  const identityCookieExists = storageFileLooksLoggedIn(STORAGE_STATE);
  return {
    storageStateExists: storageFileExists(STORAGE_STATE),
    identityCookieExists,
    loginCookieReady: identityCookieExists,
    accountLoggedIn: identityCookieExists,
  };
}

function deriveSessionFields(result, flags) {
  const identityCookieExists = Boolean(
    result.identityCookieExists ?? flags.identityCookieExists,
  );
  const detailApiReady = Boolean(result.detailApiReady);
  const loginRequired = Boolean(result.loginRequired);
  return {
    identityCookieExists,
    loginCookieReady: identityCookieExists,
    productionDetailReady: detailApiReady,
    loginRequired,
    accountLoggedIn: identityCookieExists,
    sessionUsable: identityCookieExists && detailApiReady && !loginRequired,
  };
}

function persistCapabilitySnapshot() {
  const status = getLastCapabilityVerify();
  if (!status.storageStateExists) return;
  if (status.loginRequired) {
    clearSessionCapability(DATA_DIR);
    return;
  }
  if (!status.detailApiReady && !status.signatureReady) {
    clearSessionCapability(DATA_DIR);
    return;
  }
  saveSessionCapability(DATA_DIR, {
    capability: status,
    lastSignatureSuccessAt,
    lastDetailApiSuccessAt,
    lastDashboardSuccessAt,
    savedAt: status.lastVerifyAt || new Date().toISOString(),
  });
}

export function hydrateCapabilityFromDisk(dataDir = DATA_DIR) {
  if (!dataDir || diskHydrated) return getLastCapabilityVerify();
  diskHydrated = true;

  const snapshot = loadSessionCapability(dataDir);
  if (snapshot && fingerprintMatches(dataDir, snapshot)) {
    if (snapshot.lastSignatureSuccessAt) {
      lastSignatureSuccessAt = snapshot.lastSignatureSuccessAt;
    }
    if (snapshot.lastDetailApiSuccessAt) {
      lastDetailApiSuccessAt = snapshot.lastDetailApiSuccessAt;
    }
    if (snapshot.lastDashboardSuccessAt) {
      lastDashboardSuccessAt = snapshot.lastDashboardSuccessAt;
    }
    const cap = snapshot.capability || {};
    if (
      cap.detailApiReady &&
      cap.detailPayloadValid &&
      cap.signatureReady &&
      !cap.loginRequired
    ) {
      lastVerifyResult = {
        ...EMPTY_VERIFY,
        ...cap,
        lastVerifyAt: snapshot.savedAt || cap.lastVerifyAt || null,
      };
    }
  }

  if (!lastSignatureSuccessAt) {
    const fromCache = newestSignatureTimestamp(
      path.join(dataDir, "session_cache"),
    );
    if (fromCache) lastSignatureSuccessAt = fromCache;
  }
  if (!lastSignatureSuccessAt && SESSION_CACHE_DIR) {
    const fromCache = newestSignatureTimestamp(SESSION_CACHE_DIR);
    if (fromCache) lastSignatureSuccessAt = fromCache;
  }

  return getLastCapabilityVerify();
}

export function getLastCapabilityVerify() {
  if (!diskHydrated) hydrateCapabilityFromDisk();
  const flags = readFileFlags();
  const derived = deriveSessionFields(lastVerifyResult, flags);
  return {
    ...lastVerifyResult,
    ...flags,
    ...derived,
  };
}

export function setLastCapabilityVerify(result) {
  const flags = readFileFlags();
  verifyGeneration += 1;
  lastVerifyResult = {
    ...EMPTY_VERIFY,
    ...result,
    ...flags,
    ...deriveSessionFields(result, flags),
    lastVerifyAt: result.lastVerifyAt || new Date().toISOString(),
    _generation: verifyGeneration,
  };
  persistCapabilitySnapshot();
  return getLastCapabilityVerify();
}

export function getCapabilityVerifyGeneration() {
  return verifyGeneration;
}

export function applyCapabilitySuccess(patch = {}) {
  const current = getLastCapabilityVerify();
  return setLastCapabilityVerify({
    ...current,
    ...patch,
    loginRequired: false,
    lastVerifyError: null,
    lastVerifyAt: new Date().toISOString(),
  });
}

export function markSignatureSuccess(detail = "") {
  lastSignatureSuccessAt = new Date().toISOString();
  lastSignatureError = null;
  applyCapabilitySuccess({ signatureReady: true, signatureCaptured: true });
}

export function markDetailApiSuccess(patch = {}) {
  lastDetailApiSuccessAt = new Date().toISOString();
  applyCapabilitySuccess({
    signatureReady: true,
    detailApiReady: true,
    browserSessionVerified: true,
    signatureCaptured: true,
    productionDetailReady: true,
    detailPayloadValid: true,
    ...patch,
  });
}

export function getLastDetailApiSuccessAt() {
  return lastDetailApiSuccessAt;
}

export function isRecentDetailApiSuccess(maxAgeMs = DETAIL_API_SUCCESS_TTL_MS) {
  if (!lastDetailApiSuccessAt) return false;
  const age = Date.now() - new Date(lastDetailApiSuccessAt).getTime();
  return age >= 0 && age < maxAgeMs;
}

export function isPersistedDetailSuccess(maxAgeMs = SESSION_PERSIST_TTL_MS) {
  return isPersistedSessionUsable(DATA_DIR, maxAgeMs);
}

export function markSignatureFailure(detail = "") {
  lastSignatureError = detail || "签名更新失败";
  clearSessionCapability(DATA_DIR);
  const current = getLastCapabilityVerify();
  setLastCapabilityVerify({
    ...current,
    signatureReady: false,
    detailPayloadValid: false,
    lastVerifyError: detail || current.lastVerifyError,
  });
}

export function markDashboardSuccess() {
  lastDashboardSuccessAt = new Date().toISOString();
  persistCapabilitySnapshot();
}

export function getLastSignatureSuccessAt() {
  return lastSignatureSuccessAt;
}

export function getLastSignatureError() {
  return lastSignatureError;
}

export function getLastDashboardSuccessAt() {
  return lastDashboardSuccessAt;
}

export function getSignatureTTLStatus(hasFreshSignature = false) {
  const lastAt = lastSignatureSuccessAt;
  if (!lastAt) {
    return { signatureReady: Boolean(hasFreshSignature), ageSeconds: null, withinTtl: false };
  }
  const ageSeconds = Math.round((Date.now() - new Date(lastAt).getTime()) / 1000);
  const withinTtl = ageSeconds >= 0 && ageSeconds < SIG_TTL_SECONDS;
  return {
    signatureReady: withinTtl || Boolean(hasFreshSignature),
    ageSeconds,
    withinTtl,
  };
}

const LOGIN_ERROR_CODES = new Set([
  "login_required",
  "upstream_401",
  "401",
  "detail_http_401",
]);

const SIGNATURE_ERROR_CODES = new Set([
  "upstream_403",
  "sig_capture_failed",
  "403",
  "detail_http_403",
]);

export function applyApiErrorToCapability(code) {
  const normalized = String(code || "").trim();
  if (!normalized) return getLastCapabilityVerify();

  const current = getLastCapabilityVerify();
  const patch = { lastVerifyAt: new Date().toISOString() };

  if (LOGIN_ERROR_CODES.has(normalized)) {
    patch.loginRequired = true;
    patch.detailApiReady = false;
    patch.productionDetailReady = false;
    patch.browserSessionVerified = false;
    patch.signatureReady = false;
    patch.sessionUsable = false;
    patch.lastVerifyError = normalized;
    clearSessionCapability(DATA_DIR);
  } else if (SIGNATURE_ERROR_CODES.has(normalized)) {
    patch.loginRequired = false;
    patch.signatureReady = false;
    patch.detailApiReady = false;
    patch.productionDetailReady = false;
    patch.detailPayloadValid = false;
    patch.sessionUsable = false;
    patch.lastVerifyError = normalized;
    clearSessionCapability(DATA_DIR);
  } else {
    return current;
  }

  return setLastCapabilityVerify({ ...current, ...patch });
}

export function _resetCapabilityStateForTest() {
  diskHydrated = false;
  lastVerifyResult = { ...EMPTY_VERIFY };
  lastSignatureSuccessAt = null;
  lastSignatureError = null;
  lastDashboardSuccessAt = null;
  lastDetailApiSuccessAt = null;
  verifyGeneration = 0;
}
