import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { STORAGE_STATE, SIG_TTL_SECONDS } from "./config.js";

const require = createRequire(import.meta.url);
const { storageFileExists, storageFileLooksLoggedIn } = require("../../lib/storage-auth.js");

const EMPTY_VERIFY = {
  storageStateExists: false,
  identityCookieExists: false,
  accountLoggedIn: false,
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

function readFileFlags() {
  return {
    storageStateExists: storageFileExists(STORAGE_STATE),
    identityCookieExists: storageFileLooksLoggedIn(STORAGE_STATE),
  };
}

export function getLastCapabilityVerify() {
  const flags = readFileFlags();
  return {
    ...lastVerifyResult,
    ...flags,
    accountLoggedIn: Boolean(flags.identityCookieExists && lastVerifyResult.detailApiReady),
  };
}

export function setLastCapabilityVerify(result) {
  const flags = readFileFlags();
  lastVerifyResult = {
    ...EMPTY_VERIFY,
    ...result,
    ...flags,
    accountLoggedIn: Boolean(flags.identityCookieExists && result.detailApiReady),
    lastVerifyAt: result.lastVerifyAt || new Date().toISOString(),
  };
  return getLastCapabilityVerify();
}

export function markSignatureSuccess(detail = "") {
  lastSignatureSuccessAt = new Date().toISOString();
  lastSignatureError = null;
  const current = getLastCapabilityVerify();
  if (current.detailApiReady) {
    setLastCapabilityVerify({ ...current, signatureReady: true });
  }
}

export function markSignatureFailure(detail = "") {
  lastSignatureError = detail || "签名更新失败";
  const current = getLastCapabilityVerify();
  setLastCapabilityVerify({
    ...current,
    signatureReady: false,
    lastVerifyError: detail || current.lastVerifyError,
  });
}

export function markDashboardSuccess() {
  lastDashboardSuccessAt = new Date().toISOString();
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
]);

const SIGNATURE_ERROR_CODES = new Set([
  "upstream_403",
  "sig_capture_failed",
  "403",
]);

export function applyApiErrorToCapability(code) {
  const normalized = String(code || "").trim();
  if (!normalized) return getLastCapabilityVerify();

  const current = getLastCapabilityVerify();
  const patch = { lastVerifyAt: new Date().toISOString() };

  if (LOGIN_ERROR_CODES.has(normalized)) {
    patch.detailApiReady = false;
    patch.browserSessionVerified = false;
    patch.signatureReady = false;
    patch.accountLoggedIn = false;
    patch.lastVerifyError = normalized;
  } else if (SIGNATURE_ERROR_CODES.has(normalized)) {
    patch.signatureReady = false;
    patch.detailApiReady = false;
    patch.lastVerifyError = normalized;
  } else {
    return current;
  }

  return setLastCapabilityVerify({ ...current, ...patch });
}
