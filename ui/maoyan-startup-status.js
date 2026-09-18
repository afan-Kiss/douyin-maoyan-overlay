/**
 * 猫眼启动态文案 / 登录按钮判定（纯函数，便于回归）。
 * 主榜与登录/明细解耦：只有明确 login_required 才逼登录。
 */

export function isLoginRequiredStatus(status) {
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
}

export function isSignatureIssueStatus(status) {
  if (isLoginRequiredStatus(status)) return false;
  const err = String(status?.lastVerifyError || "");
  if (
    /^(detail_http_403|upstream_403|403|mtgsig_not_captured|getboxshow_request_not_seen|sig_capture_failed)$/.test(
      err,
    ) || /mtgsig/i.test(err)
  ) {
    return true;
  }
  if (
    status?.identityCookieExists &&
    status?.signatureReady === false &&
    status?.sessionUsable === false
  ) {
    return true;
  }
  return false;
}

/** 右上角登录按钮是否应可见 */
export function shouldShowLoginButton(status, forceShow = false) {
  if (forceShow) return true;
  return isLoginRequiredStatus(status) || isSignatureIssueStatus(status);
}

/**
 * 60s 超时文案：按真实失败态生成，禁止一律甩锅登录。
 * @param {{
 *   hasDisplayedData?: boolean,
 *   apiReady?: boolean,
 *   apiError?: string,
 *   pipelineReason?: string,
 *   session?: object,
 * }} ctx
 */
export function buildStartupTimeoutMessage(ctx = {}) {
  if (ctx.hasDisplayedData) return "";

  const session = ctx.session || {};
  const reason = String(ctx.pipelineReason || "");
  const apiError = String(ctx.apiError || "");

  if (isLoginRequiredStatus(session)) {
    return "猫眼登录已失效，请点击右上角「登录」后自动刷新票房";
  }

  if (ctx.apiReady === false) {
    if (/chrome|edge|浏览器/i.test(apiError)) {
      return "票房服务启动失败：请安装 Google Chrome 或 Edge 后重启软件";
    }
    return apiError
      ? `票房服务启动失败：${apiError}`
      : "票房服务启动失败，正在自动恢复…";
  }

  if (isSignatureIssueStatus(session) || /signature|mtgsig|403/i.test(reason)) {
    return "猫眼签名不可用，请点击右上角「登录」刷新签名";
  }

  if (reason === "map_not_ready" || reason === "font_error") {
    return "票房字体解码较慢，正在重试；若持续失败请重启软件";
  }

  if (reason === "fetch_error" || /timeout|network|Failed to fetch/i.test(apiError)) {
    return "猫眼数据请求失败，正在重试…";
  }

  if (reason === "no_movies") {
    return "已连接票房服务，但暂无榜单数据，正在重试…";
  }

  if (
    reason === "partial_box_decode" ||
    reason === "inferred_crosscheck_failed" ||
    reason === "partial_movie_list"
  ) {
    return "票房数据校验未通过，正在重试解码…";
  }

  if (apiError) return `加载超时：${apiError}`;
  return "加载超时：票房主榜尚未就绪，正在自动恢复；请稍后或重启软件";
}

/** pipeline 失败时的加载态文案（非超时） */
export function buildPipelineLoadingMessage(reason, apiReady = true) {
  const r = String(reason || "");
  if (!apiReady) return "票房服务断开，正在自动恢复…";
  if (r === "no_movies") return "等待票房数据…";
  if (r === "map_not_ready" || r === "font_error") return "正在解码票房字体…";
  if (r === "fetch_error") return "票房服务响应超时，正在自动恢复…";
  if (r === "partial_box_decode" || r === "inferred_crosscheck_failed") {
    return "正在校验票房数据…";
  }
  if (r === "overlap_skip") return "";
  return r ? `票房更新中（${r}）…` : "正在拉取票房数据…";
}
