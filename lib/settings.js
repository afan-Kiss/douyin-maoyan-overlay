const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 2;

const LEGACY_SETTINGS_PATH = path.join(__dirname, "..", "overlay-settings.json");

const UI_V2_FONT_DEFAULTS = {
  heroTitle: 64,
  heroSubtitle: 24,
  nationBox: 56,
  nationLabel: 22,
  movieTitle: 34,
  movieRank: 28,
  region: 22,
  metricLabel: 18,
  metricValue: 24,
  table: 30,
  footer: 18,
};

const FONT_RANGES = {
  heroTitle: [16, 96],
  heroSubtitle: [12, 48],
  nationBox: [20, 96],
  nationLabel: [12, 48],
  movieTitle: [16, 72],
  movieRank: [12, 48],
  region: [10, 40],
  metricLabel: [10, 36],
  metricValue: [10, 48],
  table: [14, 48],
  footer: [8, 24],
};

const DEFAULT_SETTINGS = {
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  pollIntervalMs: 5000,
  topCount: 10,
  bubble: {
    enabled: true,
    color: "#ff4d4d",
    bgStart: "rgba(28, 8, 14, 0.92)",
    bgEnd: "rgba(48, 10, 18, 0.88)",
    borderColor: "rgba(255, 90, 90, 0.5)",
    shadowColor: "rgba(255, 60, 80, 0.32)",
    glowColor: "rgba(255, 77, 109, 0.22)",
    fontSize: 22,
    durationMs: 1600,
    floatHeight: 44,
    minDelta: 0.001,
  },
  fonts: { ...UI_V2_FONT_DEFAULTS },
  colors: {
    accent: "#ff5a5a",
    accentSoft: "#ff6b6b",
    nationValue: "#ffffff",
    metricValue: "rgba(255, 245, 230, 0.95)",
    cardBorder: "rgba(120, 200, 220, 0.22)",
    cardBg: "rgba(8, 24, 36, 0.55)",
    titleGradientStart: "#fff8e8",
    titleGradientMid: "#f0d080",
    titleGradientEnd: "#c9a040",
  },
  window: {
    width: 525,
    height: 1080,
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

let _settingsPath = null;
let _migrationDone = false;

function resolveUserDataDir() {
  try {
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") {
      return app.getPath("userData");
    }
  } catch {
    /* not in electron main */
  }

  const local = process.env.LOCALAPPDATA || process.env.APPDATA;
  if (local) {
    return path.join(local, "MaoyanOverlay");
  }
  return path.join(__dirname, "..");
}

function getSettingsPath() {
  if (_settingsPath) return _settingsPath;

  const envPath = String(process.env.MAOYAN_SETTINGS_PATH || "").trim();
  if (envPath) {
    _settingsPath = envPath;
    return _settingsPath;
  }

  const userData = resolveUserDataDir();
  _settingsPath = path.join(userData, "overlay-settings.json");
  return _settingsPath;
}

function migrateSettingsFileIfNeeded() {
  if (_migrationDone) return;
  _migrationDone = true;

  const newPath = getSettingsPath();
  const legacyPath = LEGACY_SETTINGS_PATH;

  try {
    if (newPath === legacyPath) return;
    if (fs.existsSync(newPath)) return;
    if (!fs.existsSync(legacyPath)) return;
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.copyFileSync(legacyPath, newPath);
  } catch {
    /* 迁移失败不阻塞启动 */
  }
}

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

function looksLikeLegacyFontValue(key, value) {
  const legacy = {
    heroTitle: 32,
    heroSubtitle: 15,
    nationBox: 27,
    nationLabel: 14,
    movieTitle: 20,
    movieRank: 14,
    region: 13,
    metricLabel: 12,
    metricValue: 14,
    table: 12,
    footer: 11,
  };
  const num = Number(value);
  if (!Number.isFinite(num)) return true;
  const old = legacy[key];
  if (old == null) return false;
  return num <= old + 1;
}

function migrateSchemaOnce(settings, fromSchema) {
  const current = Number(fromSchema ?? settings.schemaVersion) || 0;
  if (current >= SCHEMA_VERSION) return settings;

  const migrated = { ...settings };
  migrated.schemaVersion = SCHEMA_VERSION;
  migrated.fonts = { ...DEFAULT_SETTINGS.fonts, ...(settings.fonts || {}) };

  for (const [key, v2Default] of Object.entries(UI_V2_FONT_DEFAULTS)) {
    if (looksLikeLegacyFontValue(key, migrated.fonts[key])) {
      migrated.fonts[key] = v2Default;
    }
  }

  if (!migrated.colors || typeof migrated.colors !== "object") {
    migrated.colors = { ...DEFAULT_SETTINGS.colors };
  } else {
    migrated.colors = { ...DEFAULT_SETTINGS.colors, ...migrated.colors };
  }

  if (!migrated.bubble || typeof migrated.bubble !== "object") {
    migrated.bubble = { ...DEFAULT_SETTINGS.bubble };
  } else {
    migrated.bubble = { ...DEFAULT_SETTINGS.bubble, ...migrated.bubble };
  }

  return migrated;
}

function sanitizeSettings(input) {
  const s = deepMerge(DEFAULT_SETTINGS, input || {});
  s.schemaVersion = SCHEMA_VERSION;
  s.revision = Math.max(0, Number(s.revision) || 0);
  s.pollIntervalMs = clamp(Number(s.pollIntervalMs) || 5000, 1000, 60000);
  s.topCount = clamp(Number(s.topCount) || 10, 1, 30);
  s.bubble.fontSize = clamp(Number(s.bubble.fontSize) || 22, 8, 32);
  s.bubble.durationMs = clamp(Number(s.bubble.durationMs) || 1600, 500, 5000);
  s.bubble.floatHeight = clamp(Number(s.bubble.floatHeight) || 44, 20, 120);
  s.bubble.minDelta = clamp(Number(s.bubble.minDelta) || 0.001, 0, 100);
  s.admin.port = clamp(Number(s.admin.port) || 8780, 1024, 65535);
  for (const key of Object.keys(s.fonts)) {
    const [min, max] = FONT_RANGES[key] || [8, 48];
    const fallback = UI_V2_FONT_DEFAULTS[key] || DEFAULT_SETTINGS.fonts[key] || 12;
    s.fonts[key] = clamp(Number(s.fonts[key]) || fallback, min, max);
  }
  for (const k of Object.keys(s.window)) {
    if (k === "width") s.window.width = clamp(Number(s.window.width) || 525, 360, 1200);
    if (k === "height") s.window.height = clamp(Number(s.window.height) || 1080, 400, 1920);
    if (k === "alwaysOnTop") s.window.alwaysOnTop = Boolean(s.window.alwaysOnTop);
    if (k === "transparent") s.window.transparent = Boolean(s.window.transparent);
  }
  s.enrich.fullIntervalMs = clamp(Number(s.enrich.fullIntervalMs) || 60000, 10000, 300000);
  s.enrich.trendLimit = clamp(Number(s.enrich.trendLimit) || 5, 1, 20);
  s.enrich.concurrency = clamp(Number(s.enrich.concurrency) || 2, 1, 6);
  return s;
}

function persistSettings(settings) {
  const settingsPath = getSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function loadSettings() {
  migrateSettingsFileIfNeeded();
  const settingsPath = getSettingsPath();

  try {
    if (fs.existsSync(settingsPath)) {
      const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      const beforeSchema = Number(raw.schemaVersion) || 0;
      const merged = deepMerge(DEFAULT_SETTINGS, raw);
      let settings =
        beforeSchema < SCHEMA_VERSION
          ? migrateSchemaOnce(merged, beforeSchema)
          : merged;
      settings = sanitizeSettings(settings);
      if (beforeSchema < SCHEMA_VERSION) {
        try {
          persistSettings(settings);
        } catch {
          /* ignore */
        }
      }
      return settings;
    }
  } catch {
    /* use defaults */
  }

  const defaults = sanitizeSettings({});
  try {
    persistSettings(defaults);
  } catch {
    /* ignore */
  }
  return defaults;
}

function stripSensitiveSettings(settings) {
  const s = { ...settings };
  if (s.admin) {
    s.admin = { ...s.admin, password: s.admin.password ? "***" : "" };
  }
  return s;
}

function isMaskedPassword(value) {
  const pwd = String(value || "").trim();
  return !pwd || pwd === "***";
}

function saveSettings(patch) {
  const prev = loadSettings();
  const merged = deepMerge(prev, patch || {});

  if (patch?.admin && Object.prototype.hasOwnProperty.call(patch.admin, "password")) {
    const incomingPwd = patch.admin.password;
    if (isMaskedPassword(incomingPwd)) {
      merged.admin = {
        ...merged.admin,
        password: prev.admin?.password || "",
      };
    }
  }

  const next = sanitizeSettings(merged);
  next.revision = Math.max(Number(prev.revision) || 0, Number(patch?.revision) || 0) + 1;
  next.updatedAt = Date.now();
  persistSettings(next);
  return next;
}

function getSettingsRevision(settings) {
  const s = settings || {};
  const revision = Number(s.revision);
  if (Number.isFinite(revision) && revision > 0) return revision;
  const updatedAt = Number(s.updatedAt);
  if (Number.isFinite(updatedAt) && updatedAt > 0) return updatedAt;
  return 0;
}

function applyRemoteSettings(remote) {
  const local = loadSettings();
  const patch = { ...remote };
  delete patch.admin;
  if (remote?.admin?.port) {
    patch.admin = { port: remote.admin.port };
  }
  if (remote?.admin?.password && !isMaskedPassword(remote.admin.password)) {
    patch.admin = { ...(patch.admin || {}), password: remote.admin.password };
  } else if (local.admin?.password) {
    patch.admin = { ...(patch.admin || {}), password: local.admin.password };
  }

  const merged = deepMerge(local, patch);
  const next = sanitizeSettings(merged);
  next.revision =
    remote?.revision != null
      ? Number(remote.revision)
      : Math.max(Number(local.revision) || 0, Number(remote.updatedAt) || 0);
  next.updatedAt = Number(remote.updatedAt) || Date.now();
  persistSettings(next);
  return next;
}

function settingsToCssVars(settings) {
  const s = settings || loadSettings();
  const b = s.bubble;
  const f = s.fonts;
  const c = s.colors;
  const movieTitle = Number(f.movieTitle) || 34;
  const nationBox = Number(f.nationBox) || 56;
  const movieRank = Number(f.movieRank) || 28;
  const metricLabel = Number(f.metricLabel) || 18;
  const metricValue = Number(f.metricValue) || 24;
  const table = Number(f.table) || 30;

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
    "--font-nation-box": `${nationBox}px`,
    "--font-nation-secondary": `${Math.round(nationBox * 0.58)}px`,
    "--font-nation-label": `${f.nationLabel}px`,
    "--font-movie-title": `${movieTitle}px`,
    "--font-movie-rank": `${movieRank}px`,
    "--font-rank-num": `${movieRank}px`,
    "--font-rank-name": `${table}px`,
    "--font-rank-box": `${metricValue + 8}px`,
    "--font-rank-round": `${metricLabel + 10}px`,
    "--font-region": `${f.region}px`,
    "--font-metric-label": `${metricLabel}px`,
    "--font-metric-value": `${metricValue}px`,
    "--font-table": `${table}px`,
    "--font-sans": '"HarmonyOS Sans SC", "HarmonyOS Sans", sans-serif',
    "--font-compact-title": `${Math.round(movieTitle * 1.1)}px`,
    "--font-compact-box": `${Math.round(movieTitle * 1.1)}px`,
    "--font-compact-metric": `${metricLabel}px`,
    "--font-podium-title": `${Math.round(movieTitle * 0.85)}px`,
    "--font-podium-title-rank1": `${Math.round(movieTitle * 0.95)}px`,
    "--font-podium-box": `${Math.round(nationBox * 0.72)}px`,
    "--font-podium-box-rank1": `${Math.round(nationBox * 1.05)}px`,
    "--font-compact-forecast": `${metricLabel}px`,
    "--font-compact-delta": `${metricLabel}px`,
    "--font-trailer-title": `${Math.round(movieTitle * 0.9)}px`,
    "--font-trailer-movie": `${Math.round(movieTitle * 1.05)}px`,
    "--color-frame-border": "rgba(214, 169, 72, 0.32)",
    "--color-accent": c.accent,
    "--color-accent-soft": c.accentSoft,
    "--color-nation-value": c.nationValue,
    "--color-metric-value": c.metricValue,
    "--color-card-border": c.cardBorder,
    "--color-card-bg": c.cardBg,
    "--title-gradient": `linear-gradient(180deg, ${c.titleGradientStart} 0%, ${c.titleGradientMid} 28%, ${c.titleGradientEnd} 52%, #8a6520 78%, #f5e0a0 100%)`,
  };
}

module.exports = {
  SCHEMA_VERSION,
  SETTINGS_PATH: LEGACY_SETTINGS_PATH,
  getSettingsPath,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  applyRemoteSettings,
  sanitizeSettings,
  stripSensitiveSettings,
  settingsToCssVars,
  getSettingsRevision,
  isMaskedPassword,
  migrateSchemaOnce,
  looksLikeLegacyFontValue,
};
