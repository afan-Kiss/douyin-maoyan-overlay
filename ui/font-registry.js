/**
 * 按字体内容版本隔离：CSS、视觉就绪、PUA 映射、发布门控。
 * 禁止用旧映射解释新响应；过期 Worker 结果只进缓存，不污染当前发布。
 */
import {
  computeVersionKey,
  computeVersionKeyAsync,
  extractFontUrls,
  decodeMarkupWithPuaMap,
  MAP_CONFIDENCE,
  clearPuaMapCache,
} from "./font-pua-mapper.js";
import { iterMarkupCodePoints, isPuaCodePoint } from "./dashboard-rank.js";
import {
  validateDecodedBoxStructure,
  isUntrustedBoxDecode,
} from "./pua-cross-helpers.js";
import { containsEncodedBoxMarkup } from "./dashboard-rank.js";

/** @typedef {{ urlKey:string, contentKey:string, family:string, css:string, buffer:ArrayBuffer|null, visualReady:boolean, map:Map|null, mapMeta:object|null, probeGlyphs:number[] }} FontEntry */

const entries = new Map();
const urlKeyToContent = new Map();
const registeredStyleMarkers = new Set();

let publishedResponseId = 0;
let publishedBusinessDate = "";
let publishedContentKey = "";

let decoderEl = null;

function ensureDecoder() {
  if (decoderEl) return decoderEl;
  decoderEl = document.createElement("span");
  decoderEl.setAttribute("aria-hidden", "true");
  decoderEl.style.cssText =
    "position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;font-size:16px;";
  document.body.appendChild(decoderEl);
  return decoderEl;
}

export function fontFamilyForKey(contentKey) {
  const ver = String(contentKey || "").trim();
  if (!ver) return "mtsi-font";
  const safe = ver.replace(/[^a-zA-Z0-9:_-]/g, "_");
  return `mtsi-font-${safe}`;
}

function normalizeCss(fontStyle) {
  return String(fontStyle || "")
    .replace(/url\("\/\//g, 'url("https://')
    .replace(/url\('\/\//g, "url('https://")
    .replace(/url\(\/\//g, "url(https://");
}

function versionedCss(fontStyle, contentKey) {
  const family = fontFamilyForKey(contentKey);
  const css = normalizeCss(fontStyle);
  if (!css) return "";
  if (css.includes(`font-family: "${family}"`)) return css;
  return css.replace(/font-family\s*:\s*(["']?)mtsi-font\1/gi, `font-family: "${family}"`);
}

function ensureStyleRegistered(contentKey, fontStyle) {
  if (!contentKey || !fontStyle || registeredStyleMarkers.has(contentKey)) return;
  const css = versionedCss(fontStyle, contentKey);
  if (!css) return;
  let registry = document.getElementById("maoyan-font-registry");
  if (!registry) {
    registry = document.createElement("style");
    registry.id = "maoyan-font-registry";
    document.head.appendChild(registry);
  }
  const marker = `/* mtsi-version:${contentKey} */`;
  if (!registry.textContent.includes(marker)) {
    registry.appendChild(document.createTextNode(`${marker}\n${css}\n`));
  }
  registeredStyleMarkers.add(contentKey);
}

export function collectProbeGlyphsFromHtml(html, into = new Set()) {
  if (!html) return into;
  for (const cp of iterMarkupCodePoints(String(html))) {
    if (isPuaCodePoint(cp)) into.add(cp);
  }
  return into;
}

export function collectProbeGlyphsFromRaw(raw, limit = 12) {
  const set = new Set();
  const nation = raw?.movieList?.nationBoxInfo?.nationBoxSplitUnit?.num || "";
  collectProbeGlyphsFromHtml(nation, set);
  for (const item of raw?.movieList?.list || []) {
    collectProbeGlyphsFromHtml(item?.boxSplitUnit?.num, set);
    if (set.size >= limit) break;
  }
  return [...set].slice(0, limit);
}

function probeString(glyphs) {
  if (!glyphs?.length) return "\uE6D5\uE6D6";
  return glyphs.map((cp) => String.fromCodePoint(cp)).join("");
}

export async function waitForFontVisual(contentKey, probeGlyphs = [], retries = 8) {
  const entry = entries.get(contentKey);
  if (!entry) return false;
  const family = entry.family;
  const probe = probeString(probeGlyphs.length ? probeGlyphs : entry.probeGlyphs);
  for (let i = 0; i < retries; i++) {
    try {
      await document.fonts.load(`16px "${family}"`);
      await document.fonts.ready;
      const checkProbe = probe || "0";
      if (document.fonts.check(`16px "${family}"`, checkProbe)) {
        entry.visualReady = true;
        return true;
      }
      const el = ensureDecoder();
      el.style.fontFamily = `"${family}", monospace`;
      el.textContent = probe;
      const w1 = el.getBoundingClientRect().width;
      el.style.fontFamily = "monospace";
      el.textContent = probe;
      const w2 = el.getBoundingClientRect().width;
      if (w1 > 0 && Math.abs(w1 - w2) > 0.2) {
        entry.visualReady = true;
        return true;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 150 * (i + 1)));
  }
  return Boolean(entry.visualReady);
}

export function resolveUrlKey(fontStyle) {
  return computeVersionKey(normalizeCss(fontStyle));
}

export async function registerFontFromStyle(fontStyle, options = {}) {
  const css = normalizeCss(fontStyle);
  const urlKey = computeVersionKey(css);
  let contentKey = urlKeyToContent.get(urlKey) || urlKey;
  let buffer = options.fontBuffer || null;

  if (!buffer && options.fetchBuffer !== false) {
    const url = extractFontUrls(css);
    if (url) {
      try {
        const normalizedUrl = url.startsWith("//") ? `https:${url}` : url;
        const resp = await fetch(normalizedUrl);
        if (resp.ok) {
          buffer = await resp.arrayBuffer();
          contentKey = await computeVersionKeyAsync(css, buffer);
        }
      } catch {
        /* keep url key */
      }
    }
  } else if (buffer) {
    contentKey = await computeVersionKeyAsync(css, buffer);
  }

  urlKeyToContent.set(urlKey, contentKey);
  const family = fontFamilyForKey(contentKey);
  const probeGlyphs = options.probeGlyphs || [];
  if (!entries.has(contentKey)) {
    entries.set(contentKey, {
      urlKey,
      contentKey,
      family,
      css,
      buffer,
      visualReady: false,
      map: null,
      mapMeta: null,
      probeGlyphs,
    });
  } else {
    const e = entries.get(contentKey);
    e.urlKey = urlKey;
    if (buffer) e.buffer = buffer;
    if (probeGlyphs.length) e.probeGlyphs = probeGlyphs;
  }
  ensureStyleRegistered(contentKey, css);
  return { urlKey, contentKey, family };
}

export function cacheMapForFont(contentKey, built) {
  if (!contentKey || !built) return false;
  if (!entries.has(contentKey)) {
    entries.set(contentKey, {
      urlKey: contentKey,
      contentKey,
      family: fontFamilyForKey(contentKey),
      css: "",
      buffer: null,
      visualReady: false,
      map: null,
      mapMeta: null,
      probeGlyphs: [],
    });
  }
  const entry = entries.get(contentKey);
  if (!entry) return false;
  const map = built.map instanceof Map ? built.map : built.map ? new Map(built.map) : null;
  const conf = built.confidence || MAP_CONFIDENCE.NONE;
  const usable =
    built.ok &&
    map &&
    (conf === MAP_CONFIDENCE.VERIFIED || conf === MAP_CONFIDENCE.INFERRED);
  if (usable) {
    // 已有 VERIFIED 时不降级成 INFERRED
    if (
      entry.map &&
      entry.mapMeta?.confidence === MAP_CONFIDENCE.VERIFIED &&
      conf !== MAP_CONFIDENCE.VERIFIED
    ) {
      return true;
    }
    entry.map = map;
    entry.mapMeta = {
      confidence: conf,
      confidence_reason: built.confidence_reason || "",
      reason: built.reason || "",
      method: built.method || "",
      mapping_duration_ms: built.mapping_duration_ms || 0,
      provisional: built.provisional === true,
    };
    return true;
  }
  if (!entry.map) {
    entry.mapMeta = {
      confidence: conf || MAP_CONFIDENCE.NONE,
      reason: built.reason || built.rejection_reason || "map_build_failed",
    };
  }
  return false;
}

export function isMapVerified(contentKey) {
  const e = entries.get(contentKey);
  return Boolean(e?.map && e.mapMeta?.confidence === MAP_CONFIDENCE.VERIFIED);
}

export function isVisualReady(contentKey) {
  const requested = String(contentKey || "").trim();
  if (!requested) return false;
  const direct = entries.get(requested);
  if (direct?.visualReady) return true;

  const mapped = urlKeyToContent.get(requested);
  if (mapped) {
    const viaUrl = entries.get(mapped);
    if (viaUrl?.visualReady) return true;
  }

  const normalized = normalizeFontIdentity(requested);
  if (!normalized) return false;
  if (normalized !== requested) {
    const viaNorm = entries.get(normalized);
    if (viaNorm?.visualReady) return true;
  }
  for (const [key, entry] of entries) {
    if (entry?.visualReady && normalizeFontIdentity(key) === normalized) return true;
  }
  return false;
}

export function getPublishedState() {
  return {
    responseId: publishedResponseId,
    businessDate: publishedBusinessDate,
    contentKey: publishedContentKey,
  };
}

export function canPublishSession({ responseId, contentKey, businessDate }) {
  if (!responseId || responseId < publishedResponseId) {
    return { ok: false, reason: "stale_response" };
  }
  if (!contentKey || !entries.has(contentKey)) {
    return { ok: false, reason: "unknown_font_key" };
  }
  if (businessDate && publishedBusinessDate && businessDate !== publishedBusinessDate) {
    return { ok: true, reason: "business_date_change" };
  }
  return { ok: true, reason: "" };
}

export function publishSession({ responseId, contentKey, businessDate }) {
  const gate = canPublishSession({ responseId, contentKey, businessDate });
  if (!gate.ok) return gate;
  publishedResponseId = responseId;
  publishedContentKey = contentKey;
  if (businessDate) publishedBusinessDate = businessDate;
  return { ok: true, reason: "published", contentKey, responseId };
}

export function decodeHtmlWithFontKey(numHtml, contentKey, unit = "万") {
  if (!numHtml || !contentKey) return { text: "", verified: false, reason: "missing_input" };
  const entry = entries.get(contentKey);
  if (!entry?.map || entry.mapMeta?.confidence !== MAP_CONFIDENCE.VERIFIED) {
    return { text: "", verified: false, reason: "map_not_verified" };
  }
  const rawInput = String(numHtml).replace(/<[^>]+>/g, "").trim();
  if (!containsEncodedBoxMarkup(rawInput) && !containsEncodedBoxMarkup(numHtml)) {
    const plain = rawInput;
    if (!plain || isUntrustedBoxDecode(plain)) return { text: "", verified: false, reason: "untrusted_plain" };
    return { text: plain, verified: true, reason: "plain" };
  }
  const decoded = decodeMarkupWithPuaMap(numHtml, entry.map);
  if (!decoded.complete || !decoded.text) {
    return { text: "", verified: false, reason: decoded.reason || "decode_incomplete" };
  }
  if (!validateDecodedBoxStructure(numHtml, decoded.text) || isUntrustedBoxDecode(decoded.text)) {
    return { text: "", verified: false, reason: "decode_untrusted" };
  }
  return { text: decoded.text, verified: true, reason: "pua_verified", unit };
}

export function syncLegacyActivePointers(contentKey) {
  const entry = entries.get(contentKey);
  return {
    contentKey,
    family: entry?.family || fontFamilyForKey(contentKey),
    hasMap: Boolean(entry?.map),
    mapVerified: isMapVerified(contentKey),
    visualReady: isVisualReady(contentKey),
    mapMeta: entry?.mapMeta || null,
  };
}

export function getMapForKey(contentKey) {
  const e = entries.get(contentKey);
  if (!e?.map || e.mapMeta?.confidence !== MAP_CONFIDENCE.VERIFIED) return null;
  return e.map;
}

/** 气泡/追踪用：有映射表即可，不要求 VERIFIED */
export function getMapForKeyLoose(contentKey) {
  // 反爬字体每轮都可能换 PUA→数字映射。显式请求某个字体版本时，绝不能
  // 回退到 publishedContentKey 或 entries 中“随便一张”旧映射，否则会把当前
  // 票房误解成一个更大的数，随后被气泡高水位永久锁死。
  const requested = String(contentKey || "").trim();
  const effective = requested || String(publishedContentKey || "").trim();
  if (!effective) return null;

  const normalized = normalizeFontIdentity(effective);
  for (const key of new Set([effective, normalized].filter(Boolean))) {
    const e = entries.get(key);
    if (e?.map?.size) return e.map;
  }

  // URL key 可能已被归一到内容 sha256 key；只允许同一字体身份匹配。
  if (normalized) {
    for (const [key, e] of entries) {
      if (normalizeFontIdentity(key) === normalized && e?.map?.size) return e.map;
    }
  }
  return null;
}

/** URL 快速键与内容 sha256 键归一为同一字体身份 */
export function normalizeFontIdentity(key) {
  const raw = String(key || "").trim();
  if (!raw) return "";
  const mapped = urlKeyToContent.get(raw) || raw;
  const sha = mapped.match(/sha256:([a-f0-9]+)/i)?.[1];
  if (sha) return `sha256:${sha}`;
  const urlHash = mapped.match(/^mtsi:([a-f0-9]{8,})$/i)?.[1];
  if (urlHash) return `url:${urlHash}`;
  return mapped;
}

export function clearFontRegistry(contentKey) {
  if (contentKey) {
    entries.delete(contentKey);
    registeredStyleMarkers.delete(contentKey);
    clearPuaMapCache(contentKey);
    return;
  }
  entries.clear();
  registeredStyleMarkers.clear();
  urlKeyToContent.clear();
  publishedResponseId = 0;
  publishedContentKey = "";
  publishedBusinessDate = "";
  clearPuaMapCache();
}
