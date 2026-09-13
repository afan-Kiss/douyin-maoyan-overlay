/**
 * 登录态识别与按钮状态回归：node deploy/test-login-session-status.js
 */
const assert = require("assert");
const cap = require("../lib/session-capability");
const { applySessionApiError } = require("../lib/session-status");

function testLoginRedirectDetection() {
  assert.strictEqual(
    cap.isMaoyanLoginRedirect("passport.maoyan.com", "/ipromobile/blogin"),
    true,
  );
  assert.strictEqual(cap.isMaoyanLoginRedirect("piaofang.maoyan.com", "/dashboard"), false);
  assert.strictEqual(cap.isMaoyanLoginRedirect("passport.meituan.com", "/account/login"), true);
  console.log("PASS isMaoyanLoginRedirect");
}

function testExpiredSessionMapsToLoginRequired() {
  const status = applySessionApiError("sig_capture_failed");
  assert.strictEqual(status.loginRequired, false);
  assert.strictEqual(status.signatureReady, false);

  const loginStatus = applySessionApiError("login_required");
  assert.strictEqual(loginStatus.loginRequired, true);
  assert.strictEqual(loginStatus.detailApiReady, false);
  assert.strictEqual(loginStatus.sessionUsable, false);
  console.log("PASS applySessionApiError login_required");
}

function testUiLoginRequiredHeuristic() {
  const isLoginRequiredStatus = (status) => {
    if (status?.loginRequired) return true;
    const err = String(status?.lastVerifyError || "");
    if (/^(login_required|detail_http_401|upstream_401|session_expired)$/.test(err)) return true;
    if (
      err === "sig_capture_failed" &&
      status?.identityCookieExists &&
      !status?.detailApiReady &&
      !status?.signatureReady
    ) {
      return true;
    }
    if (err === "box_page_not_loaded" && status?.identityCookieExists && !status?.detailApiReady) {
      return true;
    }
    return false;
  };

  const isSignatureIssueStatus = (status) => {
    if (isLoginRequiredStatus(status)) return false;
    const err = String(status?.lastVerifyError || "");
    return (
      /^(detail_http_403|upstream_403|403|mtgsig_not_captured|getboxshow_request_not_seen|sig_capture_failed)$/.test(
        err,
      ) || /mtgsig/i.test(err)
    );
  };

  const expired = {
    identityCookieExists: true,
    detailApiReady: false,
    signatureReady: false,
    loginRequired: false,
    lastVerifyError: "sig_capture_failed",
  };
  assert.strictEqual(isLoginRequiredStatus(expired), true);
  assert.strictEqual(isSignatureIssueStatus(expired), false);

  const sigOnly = {
    identityCookieExists: true,
    detailApiReady: true,
    signatureReady: false,
    loginRequired: false,
    lastVerifyError: "sig_capture_failed",
  };
  assert.strictEqual(isLoginRequiredStatus(sigOnly), false);
  assert.strictEqual(isSignatureIssueStatus(sigOnly), true);

  const loginRedirect = {
    identityCookieExists: true,
    detailApiReady: false,
    loginRequired: true,
    lastVerifyError: "login_required",
  };
  assert.strictEqual(isLoginRequiredStatus(loginRedirect), true);
  assert.strictEqual(isSignatureIssueStatus(loginRedirect), false);
  console.log("PASS UI login vs signature button heuristics");
}

function main() {
  testLoginRedirectDetection();
  testExpiredSessionMapsToLoginRequired();
  testUiLoginRequiredHeuristic();
  console.log("\nALL PASSED (login session status)");
}

main();
