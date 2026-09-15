/**
 * 单次 dashboard 响应：结构解析与票房解码分离，发布前校验 responseId / fontKey。
 */
import {
  registerFontFromStyle,
  cacheMapForFont,
  publishSession,
  collectProbeGlyphsFromRaw,
  waitForFontVisual,
  isMapVerified,
  isVisualReady,
  getPublishedState,
  resolveUrlKey,
  normalizeFontIdentity,
  syncLegacyActivePointers,
} from "./font-registry.js";
import {
  parseDashboardStructure,
  decodeDashboardFields,
  buildCrossContextFromRaw,
} from "./maoyan-api.js";

let responseSeq = 0;

export function nextResponseId() {
  responseSeq += 1;
  return responseSeq;
}

export function getCurrentResponseId() {
  return responseSeq;
}

export function createDashboardSession(raw, topCount) {
  const responseId = nextResponseId();
  const businessDate = String(raw?.calendar?.today || "").slice(0, 10);
  const fontStyle = raw?.fontStyle || "";
  const fontUrlKey = resolveUrlKey(fontStyle);
  const parsed = parseDashboardStructure(raw, topCount);
  parsed.responseId = responseId;
  parsed.businessDate = businessDate;
  parsed.fontUrlKey = fontUrlKey;
  parsed.fontContentKey = "";
  return {
    responseId,
    businessDate,
    fontStyle,
    fontUrlKey,
    fontContentKey: "",
    raw,
    parsed,
    mapGen: 0,
  };
}

export function isSessionCurrent(session) {
  return session && session.responseId === responseSeq;
}

export async function prepareSessionFont(session) {
  if (!session?.fontStyle) return { ok: false, reason: "no_font_style" };
  const probeGlyphs = collectProbeGlyphsFromRaw(session.raw);
  const reg = await registerFontFromStyle(session.fontStyle, { probeGlyphs });
  session.fontContentKey = reg.contentKey;
  session.parsed.fontContentKey = reg.contentKey;
  await waitForFontVisual(reg.contentKey, probeGlyphs);
  return {
    ok: true,
    urlKey: reg.urlKey,
    contentKey: reg.contentKey,
    fontFamily: reg.family,
    visualReady: isVisualReady(reg.contentKey),
  };
}

export async function buildSessionPuaMap(session, options = {}) {
  const { schedulePuaMapBuild } = await import("./font-pipeline.js");
  const crossContext = buildCrossContextFromRaw(session.raw);
  const built = await schedulePuaMapBuild(session.fontStyle, crossContext, options);
  const contentKey = built?.versionKey || session.fontContentKey || session.fontUrlKey;
  session.fontContentKey = contentKey;
  session.parsed.fontContentKey = contentKey;
  cacheMapForFont(contentKey, built);
  return { built, contentKey, crossContext };
}

export function tryPublishSession(session) {
  if (!isSessionCurrent(session)) {
    return { ok: false, reason: "stale_response" };
  }
  const contentKey = session.fontContentKey || session.fontUrlKey;
  const gate = publishSession({
    responseId: session.responseId,
    contentKey,
    businessDate: session.businessDate,
  });
  if (!gate.ok) return gate;
  return {
    ok: true,
    reason: "published",
    contentKey,
    identity: normalizeFontIdentity(contentKey),
    state: syncLegacyActivePointers(contentKey),
    mapVerified: isMapVerified(contentKey),
    visualReady: isVisualReady(contentKey),
  };
}

export function decodeSessionDashboard(session) {
  const contentKey = session.fontContentKey || getPublishedState().contentKey;
  if (!contentKey) return session.parsed;
  return decodeDashboardFields(session.parsed, contentKey, {
    movies: session.parsed.movies,
    crossCheckMovies: session.parsed.movies,
  });
}

export function sessionFontIdentity(session) {
  const key = session?.fontContentKey || session?.fontUrlKey || "";
  return normalizeFontIdentity(key);
}
