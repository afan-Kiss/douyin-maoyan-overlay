/**
 * 猫眼启动 UX / 主榜与登录解耦回归
 * node deploy/test-maoyan-startup-ux.js
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

async function loadStatusMod() {
  const href = pathToFileURL(path.join(__dirname, "..", "ui", "maoyan-startup-status.js")).href;
  return import(href);
}

async function main() {
  const mod = await loadStatusMod();
  const {
    isLoginRequiredStatus,
    isSignatureIssueStatus,
    shouldShowLoginButton,
    buildStartupTimeoutMessage,
    buildPipelineLoadingMessage,
  } = mod;

  // 1) login_required 时登录按钮必须可见
  assert.strictEqual(
    shouldShowLoginButton({ loginRequired: true, lastVerifyError: "login_required" }),
    true,
    "login_required must show login button",
  );

  // 2) 非 login 错误不能提示点击登录
  const serviceTimeout = buildStartupTimeoutMessage({
    hasDisplayedData: false,
    apiReady: false,
    apiError: "票房服务启动超时",
    session: { loginRequired: false },
  });
  assert.ok(!/点击.*登录/.test(serviceTimeout), `service fail must not blame login: ${serviceTimeout}`);
  assert.ok(/票房服务/.test(serviceTimeout), serviceTimeout);

  const networkTimeout = buildStartupTimeoutMessage({
    hasDisplayedData: false,
    apiReady: true,
    pipelineReason: "fetch_error",
    session: { loginRequired: false },
  });
  assert.ok(!/点击.*登录/.test(networkTimeout), networkTimeout);
  assert.ok(/请求失败|重试/.test(networkTimeout), networkTimeout);

  const decodeTimeout = buildStartupTimeoutMessage({
    hasDisplayedData: false,
    apiReady: true,
    pipelineReason: "map_not_ready",
    session: { loginRequired: false },
  });
  assert.ok(!/点击.*登录/.test(decodeTimeout), decodeTimeout);
  assert.ok(/字体|解码/.test(decodeTimeout), decodeTimeout);

  // 3) 明确需要登录时必须提示登录
  const loginTimeout = buildStartupTimeoutMessage({
    hasDisplayedData: false,
    apiReady: true,
    session: { loginRequired: true, lastVerifyError: "login_required" },
  });
  assert.ok(/登录/.test(loginTimeout), loginTimeout);
  assert.strictEqual(shouldShowLoginButton({ loginRequired: true }), true);

  // 4) 签名问题显示登录按钮，但与 login_required 区分
  const sig = {
    identityCookieExists: true,
    detailApiReady: true,
    signatureReady: false,
    loginRequired: false,
    lastVerifyError: "sig_capture_failed",
  };
  assert.strictEqual(isLoginRequiredStatus(sig), false);
  assert.strictEqual(isSignatureIssueStatus(sig), true);
  assert.strictEqual(shouldShowLoginButton(sig), true);
  const sigMsg = buildStartupTimeoutMessage({
    hasDisplayedData: false,
    apiReady: true,
    session: sig,
  });
  assert.ok(/签名/.test(sigMsg), sigMsg);

  // 5) 主接口成功后不得因 detail 失败假装需要登录
  assert.strictEqual(
    isLoginRequiredStatus({
      loginRequired: false,
      detailApiReady: false,
      signatureReady: false,
      lastVerifyError: null,
      sessionUsable: false,
    }),
    false,
  );
  assert.strictEqual(
    shouldShowLoginButton({
      loginRequired: false,
      detailApiReady: false,
      signatureReady: true,
      sessionUsable: true,
      lastVerifyError: null,
    }),
    false,
  );

  // 6) pipeline 文案：detail/校验失败不甩锅登录
  assert.ok(!/登录/.test(buildPipelineLoadingMessage("inferred_crosscheck_failed")));
  assert.ok(!/登录/.test(buildPipelineLoadingMessage("partial_box_decode")));
  assert.ok(/服务断开|自动恢复/.test(buildPipelineLoadingMessage("x", false)));

  // 7) LiveAssistant 离线不影响主榜判定（纯状态模块不读互动服务）
  const offlineCtx = buildStartupTimeoutMessage({
    hasDisplayedData: true,
    apiReady: true,
    session: { loginRequired: false },
  });
  assert.strictEqual(offlineCtx, "", "already displayed data => no timeout message");

  // 8) 主接口成功时不应再提示登录超时
  const afterOk = buildStartupTimeoutMessage({
    hasDisplayedData: true,
    apiReady: true,
    pipelineReason: "",
    session: { loginRequired: false },
  });
  assert.strictEqual(afterOk, "");

  console.log("\nALL PASSED (maoyan startup ux)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
