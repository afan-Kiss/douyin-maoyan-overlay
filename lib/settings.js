const fs = require("fs");
const path = require("path");

const SETTINGS_PATH = path.join(__dirname, "..", "overlay-settings.json");

const DEFAULT_SETTINGS = {
  pollIntervalMs: 5000,
  topCount: 5,
  bubble: {
    enabled: true,
    color: "#ffd27a",
    bgStart: "rgba(60, 12, 18, 0.94)",
    bgEnd: "rgba(90, 18, 24, 0.9)",
    borderColor: "rgba(255, 196, 110, 0.55)",
    shadowColor: "rgba(255, 170, 60, 0.35)",
    glowColor: "rgba(255, 200, 100, 0.25)",
    fontSize: 18,
    durationMs: 1600,
    floatHeight: 44,
    minDelta: 0.001,
  },
  fonts: {
    heroTitle: 56,
    heroSubtitle: 17,
    nationBox: 28,
    nationLabel: 20,
    movieTitle: 50,
    movieRank: 32,
    region: 18,
    metricLabel: 22,
    metricValue: 26,
    table: 19,
    footer: 17,
  },
  colors: {
    accent: "#e8b45a",
    accentSoft: "#f0c878",
    nationValue: "#ffe2a8",
    metricValue: "rgba(255, 236, 210, 0.96)",
    cardBorder: "rgba(212, 168, 90, 0.42)",
    cardBg: "rgba(48, 8, 14, 0.72)",
    titleGradientStart: "#fff6df",
    titleGradientMid: "#f0d08a",
    titleGradientEnd: "#c9963a",
  },
  window: {
    width: 540,
    height: 960,
    liveOutput: false,
    alwaysOnTop: false,
    transparent: false,
  },
  enrich: {
    fullIntervalMs: 60000,
    trendLimit: 5,
    concurrency: 2,
  },
  admin: {
    port: 8780,
    password: "admin888",
  },
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    const val = patch[key];
    if (val && typeof val === "object" && !Array.isArray(val) && base[key]) {
      out[key] = deepMerge(base[key], val);
    } else if (val !== undefined) {
      out[key] = val;
    }
  }
  return out;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function sanitizeSettings(input) {
  const s = deepMerge(DEFAULT_SETTINGS, input || {});
  s.pollIntervalMs = clamp(Number(s.pollIntervalMs) || 5000, 1000, 60000);
  s.topCount = clamp(Number(s.topCount) || 5, 1, 30);
  s.bubble.fontSize = clamp(Number(s.bubble.fontSize) || 12, 8, 32);
  s.bubble.durationMs = clamp(Number(s.bubble.durationMs) || 1600, 500, 5000);
  s.bubble.floatHeight = clamp(Number(s.bubble.floatHeight) || 44, 20, 120);
  s.bubble.minDelta = clamp(Number(s.bubble.minDelta) || 0.001, 0, 100);
  s.admin.port = clamp(Number(s.admin.port) || 8780, 1024, 65535);
  for (const k of Object.keys(s.fonts)) {
    const max = k === "heroTitle" ? 96 : 72;
    s.fonts[k] = clamp(Number(s.fonts[k]) || DEFAULT_SETTINGS.fonts[k] || 12, 8, max);
  }
  for (const k of Object.keys(s.window)) {
    if (k === "width") s.window.width = clamp(Number(s.window.width) || 540, 360, 1200);
    if (k === "height") s.window.height = clamp(Number(s.window.height) || 960, 400, 1920);
    if (k === "liveOutput") s.window.liveOutput = Boolean(s.window.liveOutput);
    if (k === "alwaysOnTop") s.window.alwaysOnTop = Boolean(s.window.alwaysOnTop);
    if (k === "transparent") s.window.transparent = Boolean(s.window.transparent);
  }
  s.enrich.fullIntervalMs = clamp(Number(s.enrich.fullIntervalMs) || 60000, 10000, 300000);
  s.enrich.trendLimit = clamp(Number(s.enrich.trendLimit) || 5, 1, 20);
  s.enrich.concurrency = clamp(Number(s.enrich.concurrency) || 2, 1, 6);
  return s;
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
      return sanitizeSettings(raw);
    }
  } catch {
    /* use defaults */
  }
  return sanitizeSettings({});
}

function stripSensitiveSettings(settings) {
  const s = { ...settings };
  if (s.admin) {
    s.admin = { ...s.admin, password: s.admin.password ? "***" : "" };
  }
  return s;
}

function saveSettings(patch) {
  const next = sanitizeSettings(deepMerge(loadSettings(), patch || {}));
  next.updatedAt = Date.now();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

function applyRemoteSettings(remote) {
  const local = loadSettings();
  const patch = { ...remote };
  delete patch.admin;
  if (remote?.admin?.port) {
    patch.admin = { port: remote.admin.port };
  }
  if (remote?.admin?.password && remote.admin.password !== "***") {
    patch.admin = { ...(patch.admin || {}), password: remote.admin.password };
  } else if (local.admin?.password) {
    patch.admin = { ...(patch.admin || {}), password: local.admin.password };
  }
  return saveSettings(patch);
}

function settingsToCssVars(settings) {
  const s = settings || loadSettings();
  const b = s.bubble;
  const f = s.fonts;
  const c = s.colors;
  return {
    "--bubble-color": b.color,
    "--bubble-bg": `linear-gradient(135deg, ${b.bgStart} 0%, ${b.bgEnd} 100%)`,
    "--bubble-border": b.borderColor,
    "--bubble-shadow": b.shadowColor,
    "--bubble-glow": b.glowColor,
    "--bubble-font-size": `${b.fontSize}px`,
    "--bubble-duration": `${b.durationMs}ms`,
    "--bubble-float": `${b.floatHeight}px`,
    "--font-hero-title": `${f.heroTitle}px`,
    "--font-hero-sub": `${f.heroSubtitle}px`,
    "--font-nation-box": `${f.nationBox}px`,
    "--font-nation-label": `${f.nationLabel}px`,
    "--font-movie-title": `${f.movieTitle}px`,
    "--font-movie-rank": `${f.movieRank}px`,
    "--font-region": `${f.region}px`,
    "--font-metric-label": `${f.metricLabel}px`,
    "--font-metric-value": `${f.metricValue}px`,
    "--font-table": `${f.table}px`,
    "--font-sans": '"HarmonyOS Sans SC", "HarmonyOS Sans", sans-serif',
    "--font-compact-title": `${Math.round(f.movieTitle * 1.1)}px`,
    "--font-compact-box": `${Math.round(f.movieTitle * 1.1)}px`,
    "--font-compact-metric": `${f.metricLabel}px`,
    "--font-podium-title": `${Math.round(f.movieTitle * 0.9)}px`,
    "--font-podium-title-rank1": `${Math.round(f.movieTitle * 0.95)}px`,
    "--font-podium-box": `${f.nationBox}px`,
    "--font-podium-box-rank1": `${Math.round(f.nationBox * 1.14)}px`,
    "--font-compact-forecast": `${f.metricLabel}px`,
    "--font-compact-delta": `${f.metricLabel}px`,
    "--color-frame-border": "rgba(214, 169, 72, 0.32)",
    "--color-accent": c.accent,
    "--color-accent-soft": c.accentSoft,
    "--color-nation-value": c.nationValue,
    "--color-metric-value": c.metricValue,
    "--color-card-border": c.cardBorder,
    "--color-card-bg": c.cardBg,
    "--title-gradient": `linear-gradient(90deg, ${c.titleGradientStart} 0%, ${c.titleGradientMid} 50%, ${c.titleGradientEnd} 100%)`,
  };
}

module.exports = {
  SETTINGS_PATH,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  applyRemoteSettings,
  sanitizeSettings,
  stripSensitiveSettings,
  settingsToCssVars,
};
