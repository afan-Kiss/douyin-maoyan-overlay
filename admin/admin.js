const EDIT_TARGETS = {
  heroTitle: {
    label: "主标题",
    desc: "顶部「电影实时票房榜」标题与渐变配色",
    fields: [
      { path: "fonts.heroTitle", type: "number", label: "字号（px）", min: 16, max: 96 },
      { path: "colors.titleGradientStart", type: "color", label: "渐变起始色" },
      { path: "colors.titleGradientMid", type: "color", label: "渐变中间色" },
      { path: "colors.titleGradientEnd", type: "color", label: "渐变结束色" },
    ],
  },
  heroSubtitle: {
    label: "副标题",
    desc: "「今日大盘 · 实时排行」副标题",
    fields: [
      { path: "fonts.heroSubtitle", type: "number", label: "字号（px）", min: 12, max: 48 },
      { path: "colors.accentSoft", type: "color", label: "装饰线 / 柔和强调色" },
    ],
  },
  liveBadge: {
    label: "LIVE 徽章",
    desc: "左上角直播状态标识",
    fields: [
      { path: "colors.accent", type: "color", label: "强调色" },
      { path: "colors.accentSoft", type: "color", label: "柔和强调色" },
    ],
  },
  nationValue: {
    label: "大盘数字",
    desc: "实时票房主数字",
    fields: [
      { path: "fonts.nationBox", type: "number", label: "字号（px）", min: 20, max: 96 },
      { path: "colors.nationValue", type: "color", label: "数字颜色" },
      { path: "colors.metricValue", type: "rgba", label: "次要指标数值色" },
    ],
  },
  nationLabel: {
    label: "指标标签",
    desc: "「实时票房」「观影人次」等标签",
    fields: [
      { path: "fonts.nationLabel", type: "number", label: "字号（px）", min: 12, max: 48 },
      { path: "fonts.metricLabel", type: "number", label: "指标标签字号（px）", min: 10, max: 36 },
      { path: "fonts.metricValue", type: "number", label: "指标数值字号（px）", min: 10, max: 48 },
    ],
  },
  summaryCard: {
    label: "大盘卡片",
    desc: "顶部玻璃面板背景与边框",
    fields: [
      { path: "colors.cardBg", type: "rgba", label: "卡片背景" },
      { path: "colors.cardBorder", type: "rgba", label: "卡片边框" },
    ],
  },
  podiumCard: {
    label: "榜首电影卡",
    desc: "前三名电影卡片标题与数字",
    fields: [
      { path: "fonts.movieTitle", type: "number", label: "电影名字号（px）", min: 16, max: 72 },
      { path: "fonts.movieRank", type: "number", label: "排名徽章字号（px）", min: 12, max: 48 },
      { path: "colors.accent", type: "color", label: "强调色" },
    ],
  },
  rankSection: {
    label: "排行榜列表",
    desc: "第 4–10 名表格区域",
    fields: [
      { path: "fonts.table", type: "number", label: "表格字号（px）", min: 14, max: 48 },
      { path: "fonts.region", type: "number", label: "区域字号（px）", min: 10, max: 40 },
      { path: "colors.cardBg", type: "rgba", label: "行背景" },
      { path: "colors.cardBorder", type: "rgba", label: "行边框" },
    ],
  },
  footer: {
    label: "页脚",
    desc: "底部数据来源说明",
    fields: [{ path: "fonts.footer", type: "number", label: "字号（px）", min: 8, max: 24 }],
  },
  bubble: {
    label: "上涨气泡",
    desc: "票房上涨时弹出的浮动气泡",
    fields: [
      { path: "bubble.enabled", type: "checkbox", label: "启用气泡" },
      { path: "bubble.color", type: "color", label: "文字颜色" },
      { path: "bubble.bgStart", type: "rgba", label: "背景起始色" },
      { path: "bubble.bgEnd", type: "rgba", label: "背景结束色" },
      { path: "bubble.borderColor", type: "rgba", label: "边框颜色" },
      { path: "bubble.fontSize", type: "number", label: "字号（px）", min: 8, max: 32 },
      { path: "bubble.durationMs", type: "number", label: "动画时长（ms）", min: 500, max: 5000, step: 100 },
      { path: "bubble.floatHeight", type: "number", label: "上浮高度（px）", min: 20, max: 120 },
      { path: "bubble.minDelta", type: "number", label: "最小触发增量（万）", min: 0, max: 100, step: 0.01 },
    ],
    demo: "bubble",
  },
};

const FONT_PATH_KEYS = {
  "fonts.heroTitle": "heroTitle",
  "fonts.heroSubtitle": "heroSubtitle",
  "fonts.nationBox": "nationBox",
  "fonts.nationLabel": "nationLabel",
  "fonts.movieTitle": "movieTitle",
  "fonts.movieRank": "movieRank",
  "fonts.region": "region",
  "fonts.metricLabel": "metricLabel",
  "fonts.metricValue": "metricValue",
  "fonts.table": "table",
  "fonts.footer": "footer",
};

let current = null;
let selectedTarget = null;
let previewReady = false;

async function loadFontRanges() {
  try {
    const resp = await fetch("/api/settings/font-ranges");
    if (!resp.ok) return;
    const ranges = await resp.json();
    for (const meta of Object.values(EDIT_TARGETS)) {
      for (const field of meta.fields) {
        const key = FONT_PATH_KEYS[field.path];
        if (key && ranges[key]) {
          field.min = ranges[key][0];
          field.max = ranges[key][1];
        }
      }
    }
  } catch {
    /* 使用 EDIT_TARGETS 内置 fallback */
  }
}

function $(id) {
  return document.getElementById(id);
}

function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast${isError ? " toast--error" : ""}`;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 2800);
}

function getByPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setByPath(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function toHex(color, fallback = "#ffffff") {
  if (!color) return fallback;
  if (color.startsWith("#") && color.length >= 7) return color.slice(0, 7);
  return fallback;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function pushPreviewSettings() {
  const frame = $("preview-frame");
  if (!frame?.contentWindow || !current) return;
  frame.contentWindow.postMessage({ type: "preview-settings", settings: current }, "*");
}

function highlightPreview(target) {
  const frame = $("preview-frame");
  if (!frame?.contentWindow) return;
  frame.contentWindow.postMessage({ type: "preview-highlight", target }, "*");
}

function updateOutputStatus(settings) {
  const el = $("window-output-status");
  if (!el) return;
  const live = settings?.window?.liveOutput === true;
  const w = live ? 1080 : Number(settings?.window?.width) || 540;
  const h = live ? 1920 : Number(settings?.window?.height) || 960;
  const mode = live ? "直播输出 1080×1920" : `桌面预览 ${w}×${h}`;
  const scale = live
    ? "1.0（原生）"
    : `${Math.min(w / 1080, h / 1920).toFixed(3)}（CSS 缩放）`;
  el.textContent = `输出模式：${mode} · contentSize ${w}×${h} · viewport scale ${scale}`;
}

function fillAdvancedFields(settings) {
  $("pollIntervalMs").value = settings.pollIntervalMs;
  $("topCount").value = settings.topCount;
  $("enrich-fullIntervalMs").value = settings.enrich.fullIntervalMs;
  $("enrich-trendLimit").value = settings.enrich.trendLimit;
  $("window-width").value = settings.window.width;
  $("window-height").value = settings.window.height;
  $("window-liveOutput").checked = settings.window.liveOutput === true;
  $("window-alwaysOnTop").checked = settings.window.alwaysOnTop;
  $("admin-port").value = settings.admin.port;
  updateOutputStatus(settings);
}

function fillForm(settings) {
  current = deepClone(settings);
  fillAdvancedFields(settings);
  pushPreviewSettings();
  if (selectedTarget) renderInspector(selectedTarget);
  updateQuickChips();
}

function readAdvancedFields() {
  const patch = {
    pollIntervalMs: Number($("pollIntervalMs").value),
    topCount: Number($("topCount").value),
    enrich: {
      fullIntervalMs: Number($("enrich-fullIntervalMs").value),
      trendLimit: Number($("enrich-trendLimit").value),
    },
    window: {
      width: Number($("window-width").value),
      height: Number($("window-height").value),
      liveOutput: $("window-liveOutput").checked,
      alwaysOnTop: $("window-alwaysOnTop").checked,
    },
    admin: {
      port: Number($("admin-port").value),
    },
  };
  const newPwd = $("admin-password").value.trim();
  if (newPwd) patch.admin.password = newPwd;
  return patch;
}

function readForm() {
  const base = deepClone(current || {});
  const advanced = readAdvancedFields();
  return {
    ...base,
    ...advanced,
    enrich: { ...base.enrich, ...advanced.enrich },
    window: { ...base.window, ...advanced.window },
    admin: { ...base.admin, ...advanced.admin },
  };
}

function fieldId(path) {
  return `field-${path.replace(/\./g, "-")}`;
}

function renderInspector(target) {
  selectedTarget = target;
  const meta = EDIT_TARGETS[target];
  const container = $("inspector-fields");
  if (!meta || !container) return;

  $("inspector-title").textContent = meta.label;
  $("inspector-desc").textContent = meta.desc;

  container.innerHTML = "";
  for (const field of meta.fields) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const val = getByPath(current, field.path);
    const id = fieldId(field.path);

    if (field.type === "checkbox") {
      wrap.classList.add("field--row");
      wrap.innerHTML = `
        <label for="${id}">${field.label}</label>
        <input type="checkbox" id="${id}" data-path="${field.path}" data-type="checkbox" ${val ? "checked" : ""} />
      `;
    } else if (field.type === "color") {
      wrap.innerHTML = `
        <label for="${id}">${field.label}</label>
        <input type="color" id="${id}" data-path="${field.path}" data-type="color" value="${toHex(val)}" />
      `;
    } else if (field.type === "rgba") {
      wrap.innerHTML = `
        <label for="${id}">${field.label}</label>
        <input type="text" id="${id}" data-path="${field.path}" data-type="rgba" value="${val ?? ""}" placeholder="rgba(255,255,255,0.5)" />
      `;
    } else {
      wrap.innerHTML = `
        <label for="${id}">${field.label}</label>
        <input
          type="number"
          id="${id}"
          data-path="${field.path}"
          data-type="number"
          value="${val ?? ""}"
          min="${field.min ?? ""}"
          max="${field.max ?? ""}"
          step="${field.step ?? 1}"
        />
      `;
    }
    container.appendChild(wrap);
  }

  if (meta.demo === "bubble") {
    const demoBtn = document.createElement("button");
    demoBtn.type = "button";
    demoBtn.className = "btn btn--block";
    demoBtn.textContent = "预览气泡动画";
    demoBtn.style.marginTop = "8px";
    demoBtn.addEventListener("click", () => {
      $("preview-frame")?.contentWindow?.postMessage({ type: "preview-demo-bubble" }, "*");
    });
    container.appendChild(demoBtn);
  }

  container.querySelectorAll("[data-path]").forEach((input) => {
    input.addEventListener("input", onFieldChange);
    input.addEventListener("change", onFieldChange);
  });

  updateQuickChips();
}

function onFieldChange(e) {
  const el = e.target;
  const path = el.dataset.path;
  const type = el.dataset.type;
  let value;
  if (type === "checkbox") value = el.checked;
  else if (type === "number") value = Number(el.value);
  else value = el.value;

  setByPath(current, path, value);
  pushPreviewSettings();

  if (path.startsWith("bubble.") && EDIT_TARGETS.bubble) {
    $("preview-frame")?.contentWindow?.postMessage({ type: "preview-demo-bubble" }, "*");
  }
}

function buildQuickChips() {
  const row = $("quick-targets");
  if (!row) return;
  row.innerHTML = "";
  for (const [key, meta] of Object.entries(EDIT_TARGETS)) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.target = key;
    chip.textContent = meta.label;
    chip.addEventListener("click", () => {
      renderInspector(key);
      highlightPreview(key);
    });
    row.appendChild(chip);
  }
}

function updateQuickChips() {
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.classList.toggle("chip--active", chip.dataset.target === selectedTarget);
  });
}

async function loadSettings() {
  const resp = await fetch("api/settings");
  const data = await resp.json();
  fillForm(data);
}

async function saveSettings() {
  const token = $("admin-token").value;
  const body = readForm();
  const resp = await fetch("api/settings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": token,
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    toast(data.detail || "保存失败", true);
    return;
  }
  fillForm(data.settings);
  toast("保存成功，直播窗口将自动更新");
}

async function resetSettings() {
  const resp = await fetch("api/settings/defaults");
  const defaults = await resp.json();
  fillForm(defaults);
  toast("已恢复默认值，请点击保存生效");
}

async function loadUpdateStatus() {
  const resp = await fetch("api/update/status");
  if (!resp.ok) return;
  const data = await resp.json();
  const cmd = data.command || {};
  const el = $("update-command-status");
  if (!el) return;
  if (!cmd.commandId) {
    el.textContent = "暂无待推送指令";
    return;
  }
  el.textContent = `${cmd.type} · ${cmd.commandId} · ${new Date(cmd.issuedAt || 0).toLocaleString("zh-CN")}`;
}

async function pushUpdate() {
  const token = $("admin-token").value;
  const resp = await fetch("api/update/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": token,
    },
    body: JSON.stringify({ message: "管理员推送更新" }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    toast(data.detail || "推送失败", true);
    return;
  }
  await loadUpdateStatus();
  toast(data.message || "已推送更新指令");
}

function formatLogEntry(entry) {
  const time = new Date(Number(entry.ts) || Date.now()).toLocaleString("zh-CN");
  const level = String(entry.level || "info").toUpperCase().padEnd(5, " ");
  const tag = String(entry.tag || "app");
  const message = String(entry.message || "");
  return `[${time}] ${level} ${tag} · ${message}`;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadLogDevices() {
  const token = $("admin-token").value;
  const resp = await fetch("api/logs/devices", {
    headers: { "X-Admin-Token": token },
  });
  const data = await resp.json().catch(() => ({}));
  const select = $("log-device-select");
  if (!select) return;
  if (!resp.ok) {
    select.innerHTML = `<option value="">${data.detail || "加载失败，请先填写管理密码"}</option>`;
    return;
  }

  const devices = data.devices || [];
  if (devices.length === 0) {
    select.innerHTML = `<option value="">暂无客户端上报</option>`;
    return;
  }

  const current = select.value;
  select.innerHTML = devices
    .map((device) => {
      const label = `${device.hostname || "未知电脑"} · v${device.appVersion || "?"} · ${device.deviceId}`;
      return `<option value="${escapeHtml(device.deviceId)}">${escapeHtml(label)}</option>`;
    })
    .join("");

  if (current && devices.some((d) => d.deviceId === current)) {
    select.value = current;
  }
}

async function loadClientLogs() {
  const token = $("admin-token").value;
  const deviceId = $("log-device-select")?.value || "";
  const viewer = $("log-viewer");
  if (!viewer) return;
  if (!deviceId) {
    viewer.textContent = "暂无客户端上报";
    return;
  }

  const level = $("log-level-filter")?.value || "";
  const limit = Number($("log-limit")?.value) || 200;
  const params = new URLSearchParams({
    deviceId,
    limit: String(limit),
  });
  if (level) params.set("level", level);

  const resp = await fetch(`api/logs?${params.toString()}`, {
    headers: { "X-Admin-Token": token },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    viewer.textContent = data.detail || "读取日志失败，请确认管理密码";
    return;
  }

  const entries = data.entries || [];
  if (entries.length === 0) {
    viewer.textContent = "该设备暂无日志";
    return;
  }
  viewer.textContent = entries.map(formatLogEntry).join("\n");
  viewer.scrollTop = viewer.scrollHeight;
}

async function clearClientLogs() {
  const token = $("admin-token").value;
  const deviceId = $("log-device-select")?.value || "";
  if (!deviceId) {
    toast("请先选择设备", true);
    return;
  }
  if (!window.confirm("确定清空该设备的远程日志吗？")) return;

  const resp = await fetch(`api/logs?deviceId=${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
    headers: { "X-Admin-Token": token },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    toast(data.detail || "清空失败", true);
    return;
  }
  await loadLogDevices();
  await loadClientLogs();
  toast("已清空该设备日志");
}

window.addEventListener("message", (e) => {
  const msg = e.data || {};
  if (msg.type === "preview-ready") {
    previewReady = true;
    pushPreviewSettings();
  }
  if (msg.type === "preview-select" && msg.target && EDIT_TARGETS[msg.target]) {
    renderInspector(msg.target);
    highlightPreview(msg.target);
  }
});

[
  "pollIntervalMs",
  "topCount",
  "enrich-fullIntervalMs",
  "enrich-trendLimit",
  "window-width",
  "window-height",
  "window-liveOutput",
  "window-alwaysOnTop",
  "admin-port",
].forEach((id) => {
  const el = document.getElementById(id);
  el?.addEventListener("change", () => {
    if (!current) return;
    const patch = readAdvancedFields();
    Object.assign(current, patch);
    current.enrich = { ...current.enrich, ...patch.enrich };
    current.window = { ...current.window, ...patch.window };
    current.admin = { ...current.admin, ...patch.admin };
    updateOutputStatus(current);
  });
});

$("btn-save")?.addEventListener("click", saveSettings);
$("btn-reset")?.addEventListener("click", resetSettings);
$("btn-push-update")?.addEventListener("click", pushUpdate);
$("btn-refresh-logs")?.addEventListener("click", async () => {
  await loadLogDevices();
  await loadClientLogs();
});
$("btn-clear-logs")?.addEventListener("click", clearClientLogs);
$("log-device-select")?.addEventListener("change", loadClientLogs);
$("log-level-filter")?.addEventListener("change", loadClientLogs);
$("log-limit")?.addEventListener("change", loadClientLogs);
$("admin-token")?.addEventListener("input", () => {
  loadLogDevices().then(loadClientLogs).catch(() => {});
});
$("admin-token")?.addEventListener("change", () => {
  loadLogDevices().then(loadClientLogs).catch(() => {});
});

buildQuickChips();

loadFontRanges()
  .then(() => loadSettings())
  .then(() => loadUpdateStatus())
  .then(() => loadLogDevices())
  .then(() => loadClientLogs())
  .catch(() => toast("加载设置失败", true));

setInterval(() => {
  if (!$("admin-token")?.value) return;
  loadLogDevices().then(loadClientLogs).catch(() => {});
}, 15000);
