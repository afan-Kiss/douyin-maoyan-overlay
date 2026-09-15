/**
 * 启动阶段耗时采集（冷/热启动、各里程碑）
 */
const STORAGE_KEY = "maoyan_startup_metrics_v1";

const stages = [
  "appInit",
  "windowVisible",
  "serviceReady",
  "dashboardReturned",
  "firstRealFields",
  "firstBoxDisplay",
  "mappingComplete",
  "enrichComplete",
];

let sessionId = "";
let sessionKind = "cold";
let originMs = 0;
const marks = new Map();
let reported = false;

function now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

function readStored() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStored(payload) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

export function beginStartupSession(kind = "cold") {
  const prev = readStored();
  sessionKind = kind || (prev?.completed ? "warm" : "cold");
  sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  originMs = now();
  marks.clear();
  reported = false;
  markStartup("appInit");
  if (typeof document !== "undefined" && document.visibilityState !== "hidden") {
    markStartup("windowVisible");
  } else if (typeof document !== "undefined") {
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState !== "hidden") markStartup("windowVisible");
      },
      { once: true },
    );
  }
}

export function markStartup(stage, detail = null) {
  if (!stage || marks.has(stage)) return;
  marks.set(stage, { at: now(), detail });
  if (stage === "enrichComplete") {
    queueReport();
  }
}

export function getStartupMarks() {
  const out = {};
  for (const stage of stages) {
    const entry = marks.get(stage);
    if (!entry) continue;
    out[stage] = {
      ms: Math.round(entry.at - originMs),
      detail: entry.detail || null,
    };
  }
  return {
    sessionId,
    sessionKind,
    originMs,
    marks: out,
  };
}

function queueReport() {
  if (reported) return;
  reported = true;
  const payload = getStartupMarks();
  writeStored({ ...payload, completed: true, savedAt: new Date().toISOString() });
  console.log("[startup-metrics]", JSON.stringify(payload));
}

export function flushStartupReport() {
  queueReport();
  return getStartupMarks();
}

export function getPreviousStartupReport() {
  return readStored();
}
