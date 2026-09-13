import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { STORAGE_STATE, SIG_TTL_SECONDS } from "./config.js";

const require = createRequire(import.meta.url);
const { storageFileExists, storageFileLooksLoggedIn } = require("../../lib/storage-auth.js");

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
let verifyGeneration = 0;

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

export function getLastCapabilityVerify() {
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
  applyCapabilitySuccess({ signatureReady: true });
}

export function markDetailApiSuccess(patch = {}) {
  applyCapabilitySuccess({
    signatureReady: true,
    detailApiReady: true,
    browserSessionVerified: true,
    signatureCaptured: true,
    productionDetailReady: true,
    ...patch,
  });
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
  } else if (SIGNATURE_ERROR_CODES.has(normalized)) {
    patch.loginRequired = false;
    patch.signatureReady = false;
    patch.detailApiReady = false;
    patch.productionDetailReady = false;
    patch.sessionUsable = false;
    patch.lastVerifyError = normalized;
  } else {
    return current;
  }

  return setLastCapabilityVerify({ ...current, ...patch });
}
