/**
 * 登录态识别与按钮状态回归：node deploy/test-login-session-status.js
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");
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

async function testUiLoginRequiredHeuristic() {
  const href = pathToFileURL(path.join(__dirname, "..", "ui", "maoyan-startup-status.js")).href;
  const {
    isLoginRequiredStatus,
    isSignatureIssueStatus,
    shouldShowLoginButton,
    buildStartupTimeoutMessage,
  } = await import(href);

  const expired = {
    identityCookieExists: true,
    detailApiReady: false,
    signatureReady: false,
    loginRequired: false,
    lastVerifyError: "sig_capture_failed",
  };
  assert.strictEqual(isLoginRequiredStatus(expired), true);
  assert.strictEqual(isSignatureIssueStatus(expired), false);
  assert.strictEqual(shouldShowLoginButton(expired), true);

  const sigOnly = {
    identityCookieExists: true,
    detailApiReady: true,
    signatureReady: false,
    loginRequired: false,
    lastVerifyError: "sig_capture_failed",
  };
  assert.strictEqual(isLoginRequiredStatus(sigOnly), false);
  assert.strictEqual(isSignatureIssueStatus(sigOnly), true);
  assert.strictEqual(shouldShowLoginButton(sigOnly), true);

  const loginRedirect = {
    identityCookieExists: true,
    detailApiReady: false,
    loginRequired: true,
    lastVerifyError: "login_required",
  };
  assert.strictEqual(isLoginRequiredStatus(loginRedirect), true);
  assert.strictEqual(isSignatureIssueStatus(loginRedirect), false);

  const noLoginBlame = buildStartupTimeoutMessage({
    apiReady: false,
    apiError: "票房服务启动失败",
    session: { loginRequired: false },
  });
  assert.ok(!/点击.*登录/.test(noLoginBlame), noLoginBlame);

  console.log("PASS UI login vs signature button heuristics");
}

async function main() {
  testLoginRedirectDetection();
  testExpiredSessionMapsToLoginRequired();
  await testUiLoginRequiredHeuristic();
  console.log("\nALL PASSED (login session status)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
