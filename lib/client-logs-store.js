const fs = require("fs");
const path = require("path");

const LOGS_DIR = process.env.MAOYAN_LOGS_DIR || path.join(process.cwd(), "logs");
const REGISTRY_FILE = path.join(LOGS_DIR, "devices.json");
const MAX_LINES_PER_DEVICE = 3000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_ENTRIES = 200;
const uploadBuckets = new Map();

function ensureLogsDir() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function sanitizeDeviceId(deviceId) {
  return String(deviceId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64);
}

function sanitizeText(value, maxLen) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLen);
}

function logFilePath(deviceId) {
  return path.join(LOGS_DIR, `${sanitizeDeviceId(deviceId)}.jsonl`);
}

function readRegistry() {
  ensureLogsDir();
  try {
    if (!fs.existsSync(REGISTRY_FILE)) return {};
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8")) || {};
  } catch {
    return {};
  }
}

function writeRegistry(registry) {
  ensureLogsDir();
  const tmp = `${REGISTRY_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, REGISTRY_FILE);
}

function trimLogFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    const stat = fs.statSync(filePath);
    const text = fs.readFileSync(filePath, "utf-8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (stat.size <= MAX_FILE_BYTES && lines.length <= MAX_LINES_PER_DEVICE) return;
    const kept = lines.slice(-MAX_LINES_PER_DEVICE);
    fs.writeFileSync(filePath, `${kept.join("\n")}\n`, "utf-8");
  } catch {
    /* ignore trim errors */
  }
}

function normalizeEntry(entry) {
  const ts = Number(entry?.ts) || Date.now();
  const level = sanitizeText(entry?.level || "info", 16).toLowerCase() || "info";
  const tag = sanitizeText(entry?.tag || "app", 64) || "app";
  const message = sanitizeText(entry?.message || "", 4000);
  return { ts, level, tag, message };
}

function checkUploadRate(deviceId) {
  const now = Date.now();
  const bucket = uploadBuckets.get(deviceId) || { count: 0, resetAt: now + 60000 };
  if (now >= bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 60000;
  }
  bucket.count += 1;
  uploadBuckets.set(deviceId, bucket);
  if (bucket.count > 120) {
    throw new Error("upload rate limit exceeded");
  }
}

function appendClientLogs(payload = {}) {
  const deviceId = sanitizeDeviceId(payload.deviceId);
  if (!deviceId) {
    throw new Error("deviceId required");
  }

  checkUploadRate(deviceId);

  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  if (entries.length === 0) {
    return { ok: true, appended: 0 };
  }
  if (entries.length > MAX_UPLOAD_ENTRIES) {
    throw new Error("too many entries");
  }

  ensureLogsDir();
  const filePath = logFilePath(deviceId);
  const lines = entries.map((entry) => JSON.stringify(normalizeEntry(entry))).join("\n");
  fs.appendFileSync(filePath, `${lines}\n`, "utf-8");
  trimLogFile(filePath);

  const registry = readRegistry();
  registry[deviceId] = {
    deviceId,
    hostname: sanitizeText(payload.hostname || registry[deviceId]?.hostname || "", 128),
    appVersion: sanitizeText(payload.appVersion || registry[deviceId]?.appVersion || "", 32),
    platform: sanitizeText(payload.platform || registry[deviceId]?.platform || "", 32),
    lastSeen: Date.now(),
    lineCount: countLines(filePath),
  };
  writeRegistry(registry);

  return { ok: true, appended: entries.length };
}

function countLines(filePath) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const text = fs.readFileSync(filePath, "utf-8");
    return text.split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

function listDevices() {
  const registry = readRegistry();
  const merged = { ...registry };

  try {
    ensureLogsDir();
    for (const name of fs.readdirSync(LOGS_DIR)) {
      if (!name.endsWith(".jsonl")) continue;
      const deviceId = sanitizeDeviceId(name.slice(0, -6));
      if (!deviceId) continue;
      if (merged[deviceId]) continue;
      const filePath = path.join(LOGS_DIR, name);
      merged[deviceId] = {
        deviceId,
        hostname: deviceId,
        appVersion: "",
        platform: "",
        lastSeen: fs.statSync(filePath).mtimeMs || Date.now(),
        lineCount: countLines(filePath),
      };
    }
  } catch {
    /* ignore */
  }

  return Object.values(merged).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

function readClientLogs(deviceId, options = {}) {
  const id = sanitizeDeviceId(deviceId);
  if (!id) return [];

  const filePath = logFilePath(id);
  if (!fs.existsSync(filePath)) return [];

  const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 1000);
  const level = String(options.level || "").trim().toLowerCase();
  const since = Number(options.since) || 0;

  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (since && Number(entry.ts) < since) continue;
      if (level && String(entry.level || "").toLowerCase() !== level) continue;
      parsed.push(entry);
    } catch {
      /* skip bad line */
    }
  }
  return parsed.slice(-limit);
}

function clearClientLogs(deviceId) {
  const id = sanitizeDeviceId(deviceId);
  if (!id) return { ok: true, cleared: false };

  const filePath = logFilePath(id);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  const registry = readRegistry();
  if (registry[id]) {
    registry[id].lineCount = 0;
    registry[id].lastSeen = Date.now();
    writeRegistry(registry);
  }

  return { ok: true, cleared: true };
}

module.exports = {
  LOGS_DIR,
  appendClientLogs,
  listDevices,
  readClientLogs,
  clearClientLogs,
};
