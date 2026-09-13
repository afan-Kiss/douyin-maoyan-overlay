const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const FLUSH_INTERVAL_MS = 15000;
const FLUSH_SOON_MS = 800;
const MAX_BUFFER = 200;
const MAX_MESSAGE_LEN = 2000;
const MAX_BATCH_SIZE = 40;

let buffer = [];
let deviceId = "";
let appVersion = "0.0";
let uploadBase = "";
let flushTimer = null;
let uploadInterval = null;
let flushing = false;
let patched = false;
let processHooksInstalled = false;

function getUserDataDir() {
  try {
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") {
      return app.getPath("userData");
    }
  } catch {
    /* not in electron */
  }
  const local = process.env.LOCALAPPDATA || process.env.APPDATA;
  return local ? path.join(local, "MaoyanOverlay") : process.cwd();
}

function loadOrCreateDeviceId() {
  const idFile = path.join(getUserDataDir(), "device-id.txt");
  try {
    fs.mkdirSync(path.dirname(idFile), { recursive: true });
    if (fs.existsSync(idFile)) {
      const existing = String(fs.readFileSync(idFile, "utf-8")).trim();
      if (existing) return existing.slice(0, 64);
    }
  } catch {
    /* fall through */
  }

  const seed = [os.hostname(), os.userInfo().username, os.platform(), os.arch()].join("|");
  const id = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
  try {
    fs.writeFileSync(idFile, `${id}\n`, "utf-8");
  } catch {
    /* ignore */
  }
  return id;
}

function formatArgs(args) {
  return args
    .map((item) => {
      if (item instanceof Error) return item.stack || item.message;
      if (typeof item === "string") return item;
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_LEN);
}

function enqueue(level, tag, message) {
  if (!message) return;
  buffer.push({
    ts: Date.now(),
    level,
    tag,
    message,
  });
  if (buffer.length > MAX_BUFFER) {
    buffer = buffer.slice(-MAX_BUFFER);
  }
  if (level === "error" || level === "warn") {
    scheduleFlushSoon();
  }
}

function scheduleFlushSoon() {
  if (flushTimer || !uploadBase) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(() => {});
  }, FLUSH_SOON_MS);
}

function patchConsole() {
  if (patched) return;
  patched = true;

  const wrap = (level, orig) => (...args) => {
    enqueue(level, "console", formatArgs(args));
    orig(...args);
  };

  console.log = wrap("info", console.log.bind(console));
  console.info = wrap("info", console.info.bind(console));
  console.warn = wrap("warn", console.warn.bind(console));
  console.error = wrap("error", console.error.bind(console));
}

function installProcessHooks() {
  if (processHooksInstalled) return;
  processHooksInstalled = true;

  process.on("uncaughtException", (error) => {
    reportError("process", error);
  });
  process.on("unhandledRejection", (reason) => {
    reportError("process", reason instanceof Error ? reason : new Error(String(reason)));
  });
}

function initClientLogger(options = {}) {
  deviceId = loadOrCreateDeviceId();
  appVersion = String(options.appVersion || "0.0");
  patchConsole();
  installProcessHooks();
  enqueue("info", "startup", `客户端启动 v${appVersion} · ${os.hostname()} · ${deviceId}`);
}

function report(level, tag, message, extra) {
  const text = extra ? `${message} ${formatArgs([extra])}` : String(message || "");
  enqueue(level, tag || "app", text.slice(0, MAX_MESSAGE_LEN));
}

function reportError(tag, error, extra) {
  const msg = error instanceof Error ? error.stack || error.message : String(error || "unknown");
  report("error", tag, msg, extra);
}

async function postBatch(baseUrl, batch) {
  const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/api/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId,
      hostname: os.hostname(),
      appVersion,
      platform: `${process.platform}-${process.arch}`,
      entries: batch,
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(detail || `upload failed (${resp.status})`);
  }
}

async function flushTo(baseUrl) {
  const target = String(baseUrl || uploadBase || "").trim();
  if (flushing || !target || buffer.length === 0) return;

  flushing = true;
  try {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, MAX_BATCH_SIZE);
      try {
        await postBatch(target, batch);
      } catch {
        buffer = batch.concat(buffer).slice(-MAX_BUFFER);
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

async function flush() {
  return flushTo(uploadBase);
}

function clearUploadTimer() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function clearUploadInterval() {
  if (uploadInterval) {
    clearInterval(uploadInterval);
    uploadInterval = null;
  }
}

async function shutdownUpload() {
  const savedBase = uploadBase;
  clearUploadTimer();
  clearUploadInterval();
  uploadBase = "";
  await flushTo(savedBase);
}

function startLogUpload(remoteAdminUrl) {
  const nextBase = String(remoteAdminUrl || "").trim();
  if (!nextBase) {
    return shutdownUpload();
  }

  if (uploadBase === nextBase && uploadInterval) {
    scheduleFlushSoon();
    return shutdownUpload;
  }

  clearUploadTimer();
  clearUploadInterval();
  uploadBase = nextBase;

  uploadInterval = setInterval(() => {
    flush().catch(() => {});
  }, FLUSH_INTERVAL_MS);

  scheduleFlushSoon();
  return shutdownUpload;
}

function stopLogUpload() {
  return shutdownUpload();
}

function getDeviceId() {
  return deviceId || loadOrCreateDeviceId();
}

module.exports = {
  initClientLogger,
  startLogUpload,
  stopLogUpload,
  report,
  reportError,
  flush,
  getDeviceId,
};
