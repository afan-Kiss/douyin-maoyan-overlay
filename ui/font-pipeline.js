/**
 * 字体注入（快）与 PUA 映射（慢，Worker）分离；按字体内容版本缓存。
 */
import {
  ensurePuaMap,
  buildPuaMapFromFontBuffer,
  MAP_CONFIDENCE,
  extractFontUrls,
  computeVersionKeyAsync,
  fetchFontBuffer,
  clearPuaMapCache,
  evaluateMapConfidence,
  validatePuaMapAgainstContext,
} from "./font-pua-mapper.js";
import {
  validateNationCrossCheck,
  validateDecodedBoxStructure,
  isUntrustedBoxDecode,
  parseBoxNum,
  parseRate,
} from "./pua-cross-helpers.js";

const fontBufferCache = new Map();
const inflightBuilds = new Map();
const failureBackoff = new Map();

const BACKOFF_BASE_MS = 3000;
const BACKOFF_MAX_MS = 120_000;

let worker = null;
let workerSeq = 0;

const puaMapHelpers = {
  validateNationCrossCheck,
  validateDecodedBoxStructure,
  isUntrustedBoxDecode,
  parseBoxNum,
  parseRate,
};

function deserializeMap(entries) {
  if (!entries) return null;
  return new Map(entries);
}

function crossContextFingerprint(crossContext) {
  const parts = [];
  if (crossContext?.nationHtml) parts.push(String(crossContext.nationHtml).slice(0, 80));
  for (const movie of crossContext?.movies || []) {
    if (movie?.todayBoxHtml) parts.push(`${movie.rank}:${String(movie.todayBoxHtml).slice(0, 40)}`);
  }
  return parts.join("|");
}

function shouldBackoff(versionKey, crossContext, force) {
  if (force) return false;
  const state = failureBackoff.get(versionKey);
  if (!state) return false;
  if (Date.now() >= state.nextAt) return false;
  const fp = crossContextFingerprint(crossContext);
  return fp === state.lastFingerprint;
}

function recordFailure(versionKey, crossContext) {
  const prev = failureBackoff.get(versionKey) || { count: 0 };
  const count = prev.count + 1;
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, Math.min(count - 1, 5)));
  failureBackoff.set(versionKey, {
    count,
    nextAt: Date.now() + delay,
    lastFingerprint: crossContextFingerprint(crossContext),
  });
}

function clearFailure(versionKey) {
  failureBackoff.delete(versionKey);
}

function canUseWorker() {
  return typeof Worker !== "undefined" && typeof document !== "undefined";
}

function ensureWorker() {
  if (!canUseWorker()) return null;
  if (worker) return worker;
  worker = new Worker(new URL("./font-pua-mapper.worker.js", import.meta.url), { type: "module" });
  return worker;
}

async function buildOnMainThread(fontBuffer, fontStyle, crossContext, budget, simulateDelayMs = 0) {
  if (simulateDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, simulateDelayMs));
  }
  const built = await buildPuaMapFromFontBuffer(fontBuffer, fontStyle, {
    crossContext,
    helpers: puaMapHelpers,
    budget,
  });
  return serializeBuiltForTransfer(built);
}

function serializeBuiltForTransfer(built) {
  if (!built) return built;
  return {
    ...built,
    map: built.map ? [...built.map.entries()] : null,
  };
}

function buildInWorker(fontBuffer, fontStyle, crossContext, budget, simulateDelayMs = 0) {
  const w = ensureWorker();
  if (!w) {
    return buildOnMainThread(fontBuffer, fontStyle, crossContext, budget, simulateDelayMs);
  }
  const id = ++workerSeq;
  // 预留主线程回退用的拷贝：postMessage transfer 会掏空原 buffer
  const mainFallbackBuffer = fontBuffer.slice(0);
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = event.data || {};
      if (msg.id !== id) return;
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      if (!msg.ok) {
        reject(new Error(msg.error || "worker_build_failed"));
        return;
      }
      resolve(msg.built);
    };
    const onError = (error) => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      reject(error);
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    w.postMessage(
      {
        type: "build",
        id,
        fontBuffer,
        fontStyle,
        crossContext,
        budget,
        simulateDelayMs,
      },
      [fontBuffer],
    );
  }).catch(async (err) => {
    console.warn("[font-pipeline] worker build failed, fallback main thread", err?.message || err);
    return buildOnMainThread(mainFallbackBuffer, fontStyle, crossContext, budget, simulateDelayMs);
  });
}

async function getFontBuffer(fontStyle) {
  const url = extractFontUrls(fontStyle);
  if (!url) throw new Error("missing_font_url");
  const buffer = await fetchFontBuffer(url);
  const resolvedKey = await computeVersionKeyAsync(fontStyle, buffer);
  fontBufferCache.set(resolvedKey, buffer);
  return { buffer, versionKey: resolvedKey };
}

async function finalizeBuiltMap(built, fontStyle, crossContext, options = {}) {
  let result = {
    ...built,
    map: deserializeMap(built.map),
  };
  if (result.ok && result.map && crossContext && Object.keys(puaMapHelpers).length) {
    const validation = validatePuaMapAgainstContext(result.map, crossContext, puaMapHelpers);
    if (!validation.ok) {
      result = {
        ...result,
        ok: false,
        reason: `cross_check_failed:${validation.reason}`,
        map: null,
        decoded: validation.decoded,
        confidence: MAP_CONFIDENCE.NONE,
        rejection_reason: validation.reason || "cross_check_failed",
      };
    } else {
      result = { ...result, decoded: validation.decoded, crossValidated: true };
      const evaluated = evaluateMapConfidence(result, crossContext, options);
      result.confidence = evaluated.confidence;
      result.confidence_reason = evaluated.reason;
    }
  }
  return result;
}

/**
 * 后台构建 PUA 映射（Worker + 主线程校验）；同版本去重。
 */
export async function schedulePuaMapBuild(fontStyle, crossContext, options = {}) {
  const normalizedStyle = String(fontStyle || "").trim();
  if (!normalizedStyle) return { ok: false, reason: "no_font_style" };

  let buffer = options.fontBuffer || null;
  let vk = "";
  if (buffer) {
    vk = await computeVersionKeyAsync(normalizedStyle, buffer);
  } else {
    const loaded = await getFontBuffer(normalizedStyle);
    buffer = loaded.buffer;
    vk = loaded.versionKey;
  }

  if (shouldBackoff(vk, crossContext, options.force === true)) {
    return { ok: false, reason: "mapping_backoff", versionKey: vk, confidence: MAP_CONFIDENCE.NONE };
  }

  if (inflightBuilds.has(vk)) return inflightBuilds.get(vk);

  const promise = (async () => {
    try {
      let inferredKeep = null;
      if (!options.force) {
        const cached = await ensurePuaMap(normalizedStyle, {
          force: false,
          crossContext,
          helpers: puaMapHelpers,
          fontBuffer: buffer,
          budget: options.budget || {},
        });
        if (cached?.ok && cached.map && cached.confidence === MAP_CONFIDENCE.VERIFIED) {
          clearFailure(vk);
          return cached;
        }
        // INFERRED 已够气泡解码；继续尝试升级，但失败时保留它
        if (cached?.ok && cached.map && cached.confidence === MAP_CONFIDENCE.INFERRED) {
          inferredKeep = cached;
        }
      }

      const workerBuilt = await buildInWorker(
        buffer.slice(0),
        normalizedStyle,
        crossContext,
        options.budget || {},
        options.simulateDelayMs || 0,
      );
      let built = await finalizeBuiltMap(workerBuilt, normalizedStyle, crossContext, options);

      if (!built.ok && built.puaGlyphs?.length === 10 && crossContext) {
        const fallback = await ensurePuaMap(normalizedStyle, {
          force: true,
          crossContext,
          helpers: puaMapHelpers,
          fontBuffer: buffer,
          budget: options.budget,
        });
        if (fallback?.ok) built = fallback;
      }

      if (built.ok && built.map && built.confidence === MAP_CONFIDENCE.VERIFIED) {
        clearFailure(vk);
      } else if (!built.ok) {
        if (inferredKeep?.ok && inferredKeep.map) {
          return inferredKeep;
        }
        recordFailure(vk, crossContext);
      }
      return built;
    } finally {
      inflightBuilds.delete(vk);
    }
  })();

  inflightBuilds.set(vk, promise);
  return promise;
}

export function clearFontPipelineCache(versionKey) {
  if (versionKey) {
    fontBufferCache.delete(versionKey);
    clearPuaMapCache(versionKey);
    failureBackoff.delete(versionKey);
  } else {
    fontBufferCache.clear();
    clearPuaMapCache();
    failureBackoff.clear();
  }
}
