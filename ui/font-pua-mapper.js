/**
 * 猫眼反爬字体 PUA→数字映射：基于 WOFF cmap + glyph outline，禁止 Arial 猜字。
 * 内部票房单位「万」：30000万=3亿元（非3万元）。
 */
import {
  PUA_MIN,
  PUA_MAX,
  isPuaCodePoint,
  iterMarkupCodePoints,
  ABSURD_BOX_WAN_MAX,
} from "./dashboard-rank.js";

const mapCache = new Map();
const mapStabilityState = new Map();
let opentypeModule = null;

export const MAP_CONFIDENCE = {
  VERIFIED: "verified",
  INFERRED: "inferred",
  NONE: "none",
};

const ASSIGNMENT_CONFIDENCE_MAX = 0.42;
const ASSIGNMENT_MIN_GAP = 0.008;
const MAPPING_TIMEOUT_MS = 5000;
const MAX_CANDIDATES_EXAMINED = 120_000;
const STABILITY_ROUNDS_REQUIRED = 2;
const FACTORIAL_9 = 362_880;
const RASTER_WIDTH = 48;
const RASTER_HEIGHT = 56;

const DIGIT_TOPOLOGY_SIGNATURES = [
  { digit: 0, movesMin: 2, aspectMin: 0.55, aspectMax: 0.72, cmdsMin: 30 },
  { digit: 1, aspectMax: 0.45, movesMax: 2, cmdsMax: 40 },
  { digit: 2, movesMax: 2, aspectMin: 0.55, aspectMax: 0.72, cmdsMin: 18, cmdsMax: 55 },
  { digit: 3, movesMax: 2, aspectMin: 0.55, aspectMax: 0.72, cmdsMin: 18, cmdsMax: 55 },
  { digit: 4, movesMax: 2, aspectMin: 0.58, aspectMax: 0.75, cmdsMin: 12, cmdsMax: 22 },
  { digit: 5, movesMax: 2, aspectMin: 0.55, aspectMax: 0.72, cmdsMin: 30, cmdsMax: 55 },
  { digit: 6, movesMin: 1, movesMax: 2, aspectMin: 0.55, aspectMax: 0.72, cmdsMin: 30, cmdsMax: 55 },
  { digit: 7, movesMax: 2, aspectMin: 0.58, aspectMax: 0.75, cmdsMin: 12, cmdsMax: 24 },
  { digit: 8, movesMin: 2, aspectMin: 0.55, aspectMax: 0.72, cmdsMin: 30 },
  { digit: 9, movesMin: 1, movesMax: 2, aspectMin: 0.55, aspectMax: 0.72, cmdsMin: 30, cmdsMax: 55 },
];
export { ABSURD_BOX_WAN_MAX };

export function extractFontUrls(fontStyle) {
  const css = String(fontStyle || "");
  const urls = [];
  const re = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  let match;
  while ((match = re.exec(css))) {
    let url = match[1].trim();
    if (url.startsWith("//")) url = `https:${url}`;
    if (/\.(woff2?|otf|ttf|eot)(\?|#|$)/i.test(url)) urls.push(url.split("#")[0]);
  }
  const preferred = urls.find((u) => /\.woff2?$/i.test(u) && !/\.eot/i.test(u));
  return preferred || urls.find((u) => /\.woff2?$/i.test(u)) || urls[0] || "";
}

export function normalizeFontCssForKey(fontStyle) {
  return String(fontStyle || "")
    .replace(/url\("\/\//g, 'url("https://')
    .replace(/url\('\/\//g, "url('https://")
    .replace(/url\(\/\//g, "url(https://")
    .replace(/\s+/g, " ")
    .trim();
}

export async function sha256Hex(input) {
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : input instanceof Uint8Array
        ? input
        : new TextEncoder().encode(String(input));
  if (globalThis.crypto?.subtle) {
    const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

export function computeVersionKey(fontStyle) {
  const url = extractFontUrls(fontStyle);
  const hash = url.match(/font\/([a-f0-9]+)\./i)?.[1] || "";
  if (hash) return `mtsi:${hash}`;
  const normalized = normalizeFontCssForKey(fontStyle);
  return normalized ? `mtsi:css:${normalized}` : "";
}

export async function computeVersionKeyAsync(fontStyle, fontBuffer = null) {
  if (fontBuffer) return `mtsi:sha256:${await sha256Hex(fontBuffer)}`;
  const url = extractFontUrls(fontStyle);
  const hash = url.match(/font\/([a-f0-9]+)\./i)?.[1] || "";
  if (hash) return `mtsi:${hash}`;
  return computeVersionKey(fontStyle);
}

export function fontStyleToVersionKey(fontStyle) {
  return computeVersionKey(fontStyle);
}

function nowMs() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

async function loadOpentype() {
  if (opentypeModule) return opentypeModule;
  // Renderer / Worker 用本地 vendor；纯 Node 测试用 npm 包。
  // Worker 无 window，旧逻辑会误走 "opentype.js" bare import 并失败。
  const inDomOrWorker =
    typeof document !== "undefined" ||
    (typeof self !== "undefined" &&
      typeof WorkerGlobalScope !== "undefined" &&
      self instanceof WorkerGlobalScope);
  const imported = inDomOrWorker
    ? await import("./vendor/opentype.mjs")
    : await import("opentype.js");
  opentypeModule = imported.default || imported;
  return opentypeModule;
}

export function samplePathPoints(path, samples = 48) {
  const cmds = path?.commands || [];
  if (!cmds.length) return [];
  const segments = [];
  let cx = 0;
  let cy = 0;
  let moveX = 0;
  let moveY = 0;
  for (const cmd of cmds) {
    if (cmd.type === "M") {
      cx = cmd.x;
      cy = cmd.y;
      moveX = cx;
      moveY = cy;
      segments.push({ type: "M", x: cx, y: cy });
    } else if (cmd.type === "L") {
      segments.push({ type: "L", x0: cx, y0: cy, x1: cmd.x, y1: cmd.y });
      cx = cmd.x;
      cy = cmd.y;
    } else if (cmd.type === "C") {
      segments.push({
        type: "C",
        x0: cx,
        y0: cy,
        x1: cmd.x1,
        y1: cmd.y1,
        x2: cmd.x2,
        y2: cmd.y2,
        x3: cmd.x,
        y3: cmd.y,
      });
      cx = cmd.x;
      cy = cmd.y;
    } else if (cmd.type === "Q") {
      segments.push({ type: "Q", x0: cx, y0: cy, x1: cmd.x1, y1: cmd.y1, x2: cmd.x, y2: cmd.y });
      cx = cmd.x;
      cy = cmd.y;
    } else if (cmd.type === "Z") {
      segments.push({ type: "L", x0: cx, y0: cy, x1: moveX, y1: moveY });
      cx = moveX;
      cy = moveY;
    }
  }
  const points = [];
  for (const seg of segments) {
    if (seg.type === "M") {
      points.push([seg.x, seg.y]);
    } else if (seg.type === "L") {
      points.push([seg.x1, seg.y1]);
    } else if (seg.type === "C") {
      for (let t = 0; t <= 1; t += 1 / 6) {
        const u = 1 - t;
        const x =
          u * u * u * seg.x0 +
          3 * u * u * t * seg.x1 +
          3 * u * t * t * seg.x2 +
          t * t * t * seg.x3;
        const y =
          u * u * u * seg.y0 +
          3 * u * u * t * seg.y1 +
          3 * u * t * t * seg.y2 +
          t * t * t * seg.y3;
        points.push([x, y]);
      }
    } else if (seg.type === "Q") {
      for (let t = 0; t <= 1; t += 1 / 4) {
        const u = 1 - t;
        const x = u * u * seg.x0 + 2 * u * t * seg.x1 + t * t * seg.x2;
        const y = u * u * seg.y0 + 2 * u * t * seg.y1 + t * t * seg.y2;
        points.push([x, y]);
      }
    }
  }
  if (!points.length) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);
  const norm = points.map(([x, y]) => [(x - minX) / w, (y - minY) / h]);
  if (norm.length <= samples) return norm;
  const out = [];
  for (let i = 0; i < samples; i++) {
    out.push(norm[Math.floor((i * norm.length) / samples)]);
  }
  return out;
}

function bitmapHamming(a, b) {
  const len = Math.min(a?.length || 0, b?.length || 0) || 1;
  let diff = 0;
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) diff += 1;
  return diff / len;
}

function rasterizeFromNormalizedPoints(points, width = RASTER_WIDTH, height = RASTER_HEIGHT, radius = 0.06) {
  const grid = new Uint8Array(width * height);
  if (!points?.length) return grid;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = x / Math.max(width - 1, 1);
      const ny = 1 - y / Math.max(height - 1, 1);
      let min = Infinity;
      for (const [px, py] of points) {
        min = Math.min(min, Math.hypot(nx - px, ny - py));
      }
      if (min <= radius) grid[y * width + x] = 1;
    }
  }
  return grid;
}

function rasterizeGlyphPath(path, width = RASTER_WIDTH, height = RASTER_HEIGHT) {
  if (typeof document !== "undefined" && path?.draw) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const bbox = path.getBoundingBox();
    const gw = Math.max(bbox.x2 - bbox.x1, 1);
    const gh = Math.max(bbox.y2 - bbox.y1, 1);
    const scale = Math.min((width - 4) / gw, (height - 4) / gh);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#000";
    ctx.translate(2, height - 2);
    ctx.scale(scale, -scale);
    ctx.translate(-bbox.x1, -bbox.y1);
    path.draw(ctx);
    const data = ctx.getImageData(0, 0, width, height).data;
    const grid = new Uint8Array(width * height);
    for (let i = 0; i < grid.length; i++) grid[i] = data[i * 4 + 3] > 12 ? 1 : 0;
    return grid;
  }
  return rasterizeFromNormalizedPoints(samplePathPoints(path, 160), width, height);
}

function buildDigitTemplateRasters() {
  return DIGIT_OUTLINE_TEMPLATES.map((points) => rasterizeFromNormalizedPoints(points));
}

function glyphTopology(path) {
  const bbox = path.getBoundingBox();
  const w = Math.max(bbox.x2 - bbox.x1, 1);
  const h = Math.max(bbox.y2 - bbox.y1, 1);
  const moves = (path.commands || []).filter((cmd) => cmd.type === "M").length;
  return { aspect: w / h, moves, cmds: (path.commands || []).length, width: w, height: h };
}

function topologyMatchCost(glyph, signature) {
  const t = glyph.topology;
  let cost = 0;
  if (signature.aspectMin != null && t.aspect < signature.aspectMin) cost += signature.aspectMin - t.aspect;
  if (signature.aspectMax != null && t.aspect > signature.aspectMax) cost += t.aspect - signature.aspectMax;
  if (signature.movesMin != null && t.moves < signature.movesMin) cost += (signature.movesMin - t.moves) * 0.2;
  if (signature.movesMax != null && t.moves > signature.movesMax) cost += (t.moves - signature.movesMax) * 0.2;
  if (signature.cmdsMin != null && t.cmds < signature.cmdsMin) cost += (signature.cmdsMin - t.cmds) * 0.01;
  if (signature.cmdsMax != null && t.cmds > signature.cmdsMax) cost += (t.cmds - signature.cmdsMax) * 0.01;
  return cost;
}

function verifyDigitOneTopology(puaGlyphs, map) {
  const ranked = [...puaGlyphs].sort((a, b) => a.topology.aspect - b.topology.aspect);
  const narrowest = ranked[0];
  if (!narrowest || map.get(narrowest.code) !== "1") {
    return { ok: false, reason: "topology_digit1_mismatch" };
  }
  return { ok: true, reason: "" };
}

function buildAssignmentCostMatrix(puaGlyphs, digitTemplates) {
  const rasterCost = puaGlyphs.map((g) => digitTemplates.map((t) => bitmapHamming(g.raster, t)));
  const topoCost = puaGlyphs.map((g) => {
    const row = new Array(10).fill(1);
    for (const sig of DIGIT_TOPOLOGY_SIGNATURES) row[sig.digit] = topologyMatchCost(g, sig);
    return row;
  });
  return puaGlyphs.map((_, i) => rasterCost[i].map((r, d) => r * 0.7 + topoCost[i][d] * 0.3));
}

function assignmentCost(costMatrix, assignment) {
  let total = 0;
  for (let i = 0; i < assignment.length; i++) total += costMatrix[i][assignment[i]];
  return total;
}

function mapFromAssignment(puaGlyphs, assignment) {
  const map = new Map();
  for (let i = 0; i < puaGlyphs.length; i++) map.set(puaGlyphs[i].code, String(assignment[i]));
  return map;
}

export function hungarianMinAssignment(costMatrix) {
  const n = costMatrix.length;
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (!used[j]) {
          const cur = costMatrix[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const assignment = new Array(n);
  for (let j = 1; j <= n; j++) assignment[p[j] - 1] = j - 1;
  const cost = assignmentCost(costMatrix, assignment);
  return { assignment, cost };
}

function secondBestSwapCost(costMatrix, assignment) {
  const n = assignment.length;
  const best = assignmentCost(costMatrix, assignment);
  let second = Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const alt = assignment.slice();
      const tmp = alt[i];
      alt[i] = alt[j];
      alt[j] = tmp;
      const total = assignmentCost(costMatrix, alt);
      if (total > best && total < second) second = total;
    }
  }
  return second;
}

function assignByHungarian(puaGlyphs, costMatrix, options = {}) {
  const n = puaGlyphs.length;
  const { assignment, cost } = hungarianMinAssignment(costMatrix);
  const perGlyphAvg = cost / n;
  const maxCost = options.maxCost ?? ASSIGNMENT_CONFIDENCE_MAX;
  const minGap = options.minGap ?? ASSIGNMENT_MIN_GAP;
  const lowReason = options.lowReason || "outline_assignment_low_confidence";
  const ambiguousReason = options.ambiguousReason || "outline_assignment_ambiguous";
  const okReason = options.okReason || "outline_assignment_ok";
  if (perGlyphAvg > maxCost) {
    return { ok: false, reason: lowReason, map: null, cost: perGlyphAvg, assignment };
  }
  const map = mapFromAssignment(puaGlyphs, assignment);
  const topo = verifyDigitOneTopology(puaGlyphs, map);
  if (!topo.ok) return { ok: false, reason: topo.reason, map: null, cost: perGlyphAvg, assignment };
  const secondCost = secondBestSwapCost(costMatrix, assignment);
  const gap = Number.isFinite(secondCost) ? (secondCost - cost) / n : Infinity;
  if (!Number.isFinite(secondCost) || gap < minGap) {
    return { ok: false, reason: ambiguousReason, map: null, cost: perGlyphAvg, gap, assignment };
  }
  return {
    ok: true,
    reason: okReason,
    map,
    cost: perGlyphAvg,
    permutation: assignment,
    gap,
    confidence: MAP_CONFIDENCE.INFERRED,
  };
}

/** 交叉校验唯一用正式图；多候选时按 boxRate×nation 误差选最优，避免“随便取第一个”导致错数。 */
function pickMapFromFingerprints(search, uniqueReason, provisionalReason, crossContext = null) {
  const size = search?.fingerprints?.size || 0;
  if (size < 1) return null;
  const timedOut = search.timeout === true;
  const unique = size === 1 && !timedOut;

  let entry = null;
  if (unique || !crossContext) {
    entry = search.fingerprints.values().next().value;
  } else {
    entry = pickBestFingerprintByBoxRate(search.fingerprints, crossContext);
  }
  if (!entry?.map) return null;

  return {
    ok: true,
    reason: unique ? uniqueReason : provisionalReason,
    map: entry.map,
    decoded: entry.decoded,
    candidates: size,
    candidates_examined: search.candidates_examined,
    candidates_remaining: search.candidates_remaining,
    timeout: timedOut,
    confidence: MAP_CONFIDENCE.INFERRED,
    provisional: !unique,
  };
}

function pickBestFingerprintByBoxRate(fingerprints, crossContext) {
  let best = null;
  let bestScore = Infinity;
  for (const entry of fingerprints.values()) {
    const decoded = entry?.decoded;
    if (!decoded?.nation?.text) continue;
    const nationWan = parseFloat(String(decoded.nation.text).replace(/[^\d.]/g, ""));
    if (!(nationWan > 0)) continue;
    let score = 0;
    let matched = 0;
    for (const movie of crossContext.movies || []) {
      const rate = Number(movie.boxRateNum) || parseFloat(String(movie.boxRate || "").replace("%", "")) || 0;
      if (!(rate > 0)) continue;
      const key = `movie-${movie.rank || ""}`;
      const text = decoded[key]?.text;
      if (!text) continue;
      const wan = parseFloat(String(text).replace(/[^\d.]/g, ""));
      if (!(wan > 0)) continue;
      const expected = (nationWan * rate) / 100;
      const rel = Math.abs(wan - expected) / Math.max(expected, 1);
      score += rel;
      matched += 1;
    }
    if (matched < 2) continue;
    score /= matched;
    if (score < bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best || fingerprints.values().next().value;
}

function resolveOutlineAmbiguityWithCrossCheck(puaGlyphs, digitTemplates, crossContext, helpers = {}, budget = {}) {
  if (puaGlyphs.length !== 10 || !crossContext?.nationHtml) {
    return { ok: false, reason: "cross_check_missing_context", map: null };
  }
  const search = branchAndBoundCrossCheck(puaGlyphs, crossContext, helpers, budget);
  const picked = pickMapFromFingerprints(
    search,
    "outline_cross_check_unique",
    search.timeout
      ? "outline_cross_check_timeout_provisional"
      : "outline_cross_check_ambiguous_provisional",
    crossContext,
  );
  if (picked) return picked;
  if (search.timeout) {
    return {
      ok: false,
      reason: "mapping_timeout",
      map: null,
      candidates_examined: search.candidates_examined,
      candidates_remaining: search.candidates_remaining,
      timeout: true,
      rejection_reason: "mapping_timeout",
    };
  }
  return {
    ok: false,
    reason: search.reason || "outline_cross_check_no_candidate",
    map: null,
    candidates: search.fingerprints?.size || 0,
    candidates_examined: search.candidates_examined,
    candidates_remaining: search.candidates_remaining,
    timeout: search.timeout,
    rejection_reason: search.rejection_reason || search.reason || "",
  };
}

function assignPuaCombined(puaGlyphs, digitTemplates) {
  const n = puaGlyphs.length;
  if (n !== 10 || digitTemplates.length !== 10) {
    return { ok: false, reason: "pua_glyph_count_not_10", map: null, cost: Infinity };
  }
  const cost = buildAssignmentCostMatrix(puaGlyphs, digitTemplates);
  return assignByHungarian(puaGlyphs, cost, {
    okReason: "outline_assignment_ok",
    lowReason: "outline_assignment_low_confidence",
    ambiguousReason: "outline_assignment_ambiguous",
  });
}

function assignPuaByTopology(puaGlyphs) {
  const n = puaGlyphs.length;
  if (n !== 10) return { ok: false, reason: "pua_glyph_count_not_10", map: null, cost: Infinity };
  const cost = puaGlyphs.map((g) => {
    const row = new Array(10).fill(1);
    for (const sig of DIGIT_TOPOLOGY_SIGNATURES) row[sig.digit] = topologyMatchCost(g, sig);
    return row;
  });
  return assignByHungarian(puaGlyphs, cost, {
    maxCost: 0.35,
    minGap: 0.05,
    okReason: "topology_assignment_ok",
    lowReason: "topology_assignment_low_confidence",
    ambiguousReason: "topology_assignment_ambiguous",
  });
}

const DIGIT_OUTLINE_TEMPLATES = [
  [[0.5, 0.05], [0.85, 0.2], [0.95, 0.5], [0.85, 0.8], [0.5, 0.95], [0.15, 0.8], [0.05, 0.5], [0.15, 0.2]],
  [[0.45, 0.05], [0.55, 0.05], [0.52, 0.95], [0.48, 0.95]],
  [[0.15, 0.2], [0.85, 0.2], [0.85, 0.45], [0.15, 0.55], [0.15, 0.8], [0.85, 0.8]],
  [[0.15, 0.2], [0.85, 0.2], [0.85, 0.5], [0.2, 0.5], [0.85, 0.5], [0.85, 0.8], [0.15, 0.8]],
  [[0.75, 0.2], [0.25, 0.2], [0.25, 0.5], [0.75, 0.5], [0.75, 0.8], [0.25, 0.8]],
  [[0.85, 0.2], [0.15, 0.2], [0.15, 0.5], [0.85, 0.5], [0.85, 0.8], [0.15, 0.8]],
  [[0.15, 0.2], [0.85, 0.2], [0.85, 0.5], [0.15, 0.5], [0.15, 0.8], [0.85, 0.8], [0.85, 0.5]],
  [[0.15, 0.2], [0.85, 0.2], [0.85, 0.45], [0.15, 0.45], [0.85, 0.45], [0.85, 0.8], [0.15, 0.8]],
  [[0.85, 0.2], [0.15, 0.2], [0.15, 0.8], [0.85, 0.8], [0.85, 0.5], [0.15, 0.5], [0.85, 0.2]],
  [[0.15, 0.2], [0.85, 0.2], [0.85, 0.5], [0.15, 0.5], [0.15, 0.8], [0.85, 0.8]],
];

function assignPuaToDigits(puaGlyphs, digitTemplates) {
  const n = puaGlyphs.length;
  if (n !== 10 || digitTemplates.length !== 10) {
    return { ok: false, reason: "pua_glyph_count_not_10", map: null, cost: Infinity };
  }
  const cost = puaGlyphs.map((g) => digitTemplates.map((t) => bitmapHamming(g.raster, t)));
  const assigned = assignByHungarian(puaGlyphs, cost, { minGap: 0.015 });
  if (!assigned.ok) return assigned;
  const usedDigits = new Set(assigned.permutation);
  if (usedDigits.size !== 10) {
    return { ok: false, reason: "outline_assignment_not_bijection", map: null, cost: assigned.cost };
  }
  return assigned;
}

export function mapFingerprint(map) {
  if (!map) return "";
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([cp, digit]) => `${cp}:${digit}`).join("|");
}

function countIndependentCrossFields(crossContext = {}) {
  let count = 0;
  if (crossContext.nationHtml) count += 1;
  if (crossContext.nationSplitHtml) count += 1;
  for (const movie of crossContext.movies || []) {
    if (movie.todayBoxHtml) count += 1;
    if (movie.splitBoxHtml) count += 1;
  }
  return count;
}

function hasFullCrossValidation(decoded) {
  if (!decoded?.nation?.text) return false;
  const movieKeys = Object.keys(decoded).filter((key) => key.startsWith("movie-"));
  if (movieKeys.length < 5) return false;
  const splitKeys = Object.keys(decoded).filter((key) => key.startsWith("split-"));
  if (!decoded.nationSplit?.text && !splitKeys.length) return false;
  return movieKeys.every((key) => decoded[key]?.text);
}

export function recordMappingStability(versionKey, fingerprint) {
  if (!versionKey || !fingerprint) return 0;
  const prev = mapStabilityState.get(versionKey);
  if (prev && prev.fingerprint === fingerprint) {
    prev.consecutiveRounds += 1;
    return prev.consecutiveRounds;
  }
  mapStabilityState.set(versionKey, { fingerprint, consecutiveRounds: 1 });
  return 1;
}

export function clearMappingStabilityState(versionKey) {
  if (versionKey) mapStabilityState.delete(versionKey);
  else mapStabilityState.clear();
}

export function evaluateMapConfidence(built, crossContext = {}, options = {}) {
  if (!built?.ok || !built.map) {
    return { confidence: MAP_CONFIDENCE.NONE, reason: built?.reason || "map_build_failed" };
  }
  if (
    built.provisional === true ||
    /ambiguous_provisional|timeout_provisional/.test(String(built.reason || ""))
  ) {
    return { confidence: MAP_CONFIDENCE.INFERRED, reason: built.reason || "inferred_provisional" };
  }
  const method = String(built.method || "");
  const outlineOrTopology =
    method.includes("outline") || method.includes("topology") || String(built.reason || "").includes("topology");
  const hasAuthoritativeTemplate = options.authoritativePlaintextTemplate === true;
  const independentFields = countIndependentCrossFields(crossContext);
  const fullCross = hasFullCrossValidation(built.decoded);
  const stableRounds = recordMappingStability(built.versionKey, mapFingerprint(built.map));
  const uniqueFromCross =
    method.includes("cross_check") &&
    (built.reason || "").includes("unique") &&
    independentFields >= 3;
  const crossValidated = built.crossValidated === true;
  const movieDecodeKeys = Object.keys(built.decoded || {}).filter((key) => key.startsWith("movie-"));
  const movieContextCount = (crossContext.movies || []).filter((m) => m.todayBoxHtml).length;
  const sufficientCross =
    crossValidated &&
    Boolean(built.decoded?.nation?.text) &&
    movieDecodeKeys.length >= Math.min(5, Math.max(movieContextCount, 1));
  if (
    (hasAuthoritativeTemplate || uniqueFromCross || crossValidated) &&
    stableRounds >= STABILITY_ROUNDS_REQUIRED &&
    (fullCross || sufficientCross)
  ) {
    const reason = crossValidated
      ? uniqueFromCross
        ? "cross_check_verified"
        : "cross_context_verified"
      : "cross_check_verified";
    return { confidence: MAP_CONFIDENCE.VERIFIED, reason };
  }
  if (outlineOrTopology || method.includes("cross_check")) {
    return { confidence: MAP_CONFIDENCE.INFERRED, reason: built.reason || "inferred_mapping" };
  }
  return { confidence: MAP_CONFIDENCE.INFERRED, reason: built.reason || "inferred_mapping" };
}

function emptyMappingPerf() {
  return {
    mapping_duration_ms: 0,
    candidates_examined: 0,
    candidates_remaining: 0,
    timeout: false,
    rejection_reason: "",
  };
}

export function branchAndBoundCrossCheck(puaGlyphs, crossContext = {}, helpers = {}, budget = {}) {
  const timeoutMs = budget.timeoutMs ?? MAPPING_TIMEOUT_MS;
  const maxExamined = budget.maxExamined ?? MAX_CANDIDATES_EXAMINED;
  const start = nowMs();
  const perf = emptyMappingPerf();
  const fingerprints = new Map();

  if (puaGlyphs.length !== 10 || !crossContext?.nationHtml) {
    perf.rejection_reason = "cross_check_missing_context";
    return { ok: false, reason: perf.rejection_reason, map: null, fingerprints, ...perf };
  }

  const oneIdx = findDigitOneGlyphIndex(puaGlyphs);
  const otherIdx = puaGlyphs.map((_, i) => i).filter((i) => i !== oneIdx);
  const digitAssign = new Array(puaGlyphs.length);
  digitAssign[oneIdx] = 1;
  const used = new Set([1]);

  const deadline = () => {
    if (nowMs() - start > timeoutMs) {
      perf.timeout = true;
      return true;
    }
    if (perf.candidates_examined >= maxExamined) {
      perf.timeout = true;
      return true;
    }
    return false;
  };

  const dfs = (depth) => {
    if (deadline()) return;
    // 不再在 fingerprints.size>1 时提前停：多候选时要继续搜，才能按 boxRate 选最优。
    if (depth === otherIdx.length) {
      perf.candidates_examined += 1;
      const map = mapFromAssignment(puaGlyphs, digitAssign);
      const topo = verifyDigitOneTopology(puaGlyphs, map);
      if (!topo.ok) return;
      const validation = validatePuaMapAgainstContext(map, crossContext, helpers);
      if (!validation.ok) return;
      const fp = decodedFingerprint(validation.decoded);
      if (!fingerprints.has(fp)) {
        fingerprints.set(fp, { map, decoded: validation.decoded, fingerprint: fp });
      }
      return;
    }
    const glyphIdx = otherIdx[depth];
    const candidates = [0, 2, 3, 4, 5, 6, 7, 8, 9].filter((digit) => !used.has(digit));
    for (const digit of candidates) {
      digitAssign[glyphIdx] = digit;
      used.add(digit);
      dfs(depth + 1);
      used.delete(digit);
      if (perf.timeout) return;
    }
  };

  dfs(0);
  perf.mapping_duration_ms = Math.round(nowMs() - start);
  perf.candidates_remaining = Math.max(0, FACTORIAL_9 - perf.candidates_examined);

  if (perf.timeout) {
    perf.rejection_reason = "mapping_timeout";
    return { ok: false, reason: perf.rejection_reason, map: null, fingerprints, ...perf };
  }
  if (fingerprints.size === 1) {
    const entry = fingerprints.values().next().value;
    return { ok: true, reason: "cross_check_unique_fingerprint", map: entry.map, decoded: entry.decoded, fingerprints, ...perf };
  }
  if (fingerprints.size > 1) {
    perf.rejection_reason = "cross_check_ambiguous";
    return { ok: false, reason: perf.rejection_reason, map: null, fingerprints, candidates: fingerprints.size, ...perf };
  }
  perf.rejection_reason = "cross_check_no_candidate";
  return { ok: false, reason: perf.rejection_reason, map: null, fingerprints, ...perf };
}

export function listFontPuaEntries(font) {
  const entries = [];
  for (let cp = PUA_MIN; cp <= PUA_MAX; cp++) {
    const glyph = font.charToGlyph(String.fromCodePoint(cp));
    if (glyph && glyph.index > 0) {
      const path = glyph.getPath(0, 0, 1000);
      entries.push({
        code: cp,
        gid: glyph.index,
        name: glyph.name || "",
        points: samplePathPoints(path),
        raster: rasterizeGlyphPath(path),
        topology: glyphTopology(path),
      });
    }
  }
  entries.sort((a, b) => a.gid - b.gid || a.code - b.code);
  return entries;
}

export function buildPuaMapFromFontBuffer(buffer, fontStyle = "", options = {}) {
  const buildStart = nowMs();
  const perf = emptyMappingPerf();
  return loadOpentype().then(async (opentype) => {
    const parse = opentype.parse;
    if (!parse) throw new Error("opentype_parse_unavailable");
    const font = parse(buffer);
    const versionKey = options.versionKey || (await computeVersionKeyAsync(fontStyle, buffer));
    const puaGlyphs = listFontPuaEntries(font);
    if (puaGlyphs.length !== 10) {
      perf.mapping_duration_ms = Math.round(nowMs() - buildStart);
      perf.rejection_reason = "pua_glyph_count_not_10";
      return {
        ok: false,
        versionKey,
        reason: perf.rejection_reason,
        map: null,
        puaGlyphs,
        fontUrl: extractFontUrls(fontStyle),
        confidence: MAP_CONFIDENCE.NONE,
        ...perf,
      };
    }
    const rasterTemplates = buildDigitTemplateRasters();
    let assigned = assignPuaCombined(puaGlyphs, rasterTemplates);
    let method = "";
    if (assigned.ok) {
      method = "outline_raster";
    } else if (
      (assigned.reason === "outline_assignment_ambiguous" ||
        assigned.reason === "outline_assignment_low_confidence") &&
      options.crossContext
    ) {
      const resolved = resolveOutlineAmbiguityWithCrossCheck(
        puaGlyphs,
        rasterTemplates,
        options.crossContext,
        options.helpers || {},
        options.budget || {},
      );
      perf.candidates_examined += resolved.candidates_examined || 0;
      perf.candidates_remaining = resolved.candidates_remaining || 0;
      perf.timeout = resolved.timeout === true;
      if (resolved.ok) {
        assigned = {
          ok: true,
          reason: resolved.reason,
          map: resolved.map,
          decoded: resolved.decoded,
          confidence: MAP_CONFIDENCE.INFERRED,
          provisional: resolved.provisional === true,
        };
        method = "outline_cross_check";
      } else if (resolved.reason) {
        assigned = { ...assigned, reason: resolved.reason };
        perf.rejection_reason = resolved.reason;
      }
    } else if (!assigned.ok) {
      perf.rejection_reason = assigned.reason || "outline_assignment_failed";
    }
    perf.mapping_duration_ms = Math.round(nowMs() - buildStart);
    return {
      ok: assigned.ok,
      versionKey,
      reason: assigned.reason || perf.rejection_reason || "",
      map: assigned.map,
      cost: assigned.cost,
      puaGlyphs,
      permutation: assigned.permutation,
      gap: assigned.gap,
      decoded: assigned.decoded || null,
      fontUrl: extractFontUrls(fontStyle),
      method: assigned.ok ? method || "outline_raster" : "",
      confidence: assigned.ok ? MAP_CONFIDENCE.INFERRED : MAP_CONFIDENCE.NONE,
      provisional: assigned.provisional === true,
      ...perf,
    };
  });
}

export async function fetchFontBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`font fetch failed ${resp.status}`);
  return resp.arrayBuffer();
}

function collectCrossCheckHtmlFields(crossContext = {}) {
  const fields = [];
  if (crossContext.nationHtml) {
    fields.push({ key: "nation", html: crossContext.nationHtml, unit: crossContext.nationUnit || "万" });
  }
  if (crossContext.nationSplitHtml) {
    fields.push({
      key: "nationSplit",
      html: crossContext.nationSplitHtml,
      unit: crossContext.nationSplitUnit || crossContext.nationUnit || "万",
    });
  }
  for (const movie of crossContext.movies || []) {
    if (movie.todayBoxHtml) {
      fields.push({ key: `movie-${movie.rank || fields.length}`, html: movie.todayBoxHtml, unit: movie.todayUnit || "万", movie });
    }
    if (movie.splitBoxHtml) {
      fields.push({
        key: `split-${movie.rank || fields.length}`,
        html: movie.splitBoxHtml,
        unit: movie.splitUnit || movie.todayUnit || "万",
        movie,
      });
    }
  }
  return fields;
}

export function validatePuaMapAgainstContext(map, crossContext = {}, helpers = {}) {
  const {
    validateNationCrossCheck,
    validateDecodedBoxStructure,
    isUntrustedBoxDecode,
    parseBoxNum,
    parseRate,
  } = helpers;
  if (!map) return { ok: false, reason: "missing_map", decoded: null };
  const fields = collectCrossCheckHtmlFields(crossContext);
  if (!fields.length) return { ok: true, reason: "no_cross_context", decoded: null };

  const decoded = {};
  for (const field of fields) {
    const result = decodeMarkupWithPuaMap(field.html, map);
    if (!result.complete) return { ok: false, reason: result.reason || "decode_incomplete", decoded: null };
    if (validateDecodedBoxStructure && !validateDecodedBoxStructure(field.html, result.text)) {
      return { ok: false, reason: "structure_mismatch", decoded: null };
    }
    if (isUntrustedBoxDecode && isUntrustedBoxDecode(result.text)) {
      return { ok: false, reason: "untrusted_decode", decoded: null };
    }
    decoded[field.key] = { text: result.text, unit: field.unit, movie: field.movie || null };
  }

  const nationEntry = decoded.nation;
  const splitAux = validateNationSplitAuxiliary(decoded, parseBoxNum);
  if (!splitAux.ok) return { ok: false, reason: splitAux.reason, decoded };

  if (nationEntry && validateNationCrossCheck) {
    const movies = (crossContext.movies || [])
      .map((movie) => {
        const key = `movie-${movie.rank || ""}`;
        const entry = decoded[key];
        if (!entry) return null;
        const wan = parseBoxNum ? parseBoxNum(entry.text, entry.unit) : parseFloat(entry.text);
        if (!(wan > 0)) return null;
        return {
          ...movie,
          todayBox: wan,
          boxRateNum: movie.boxRateNum || (parseRate ? parseRate(movie.boxRate) : 0),
        };
      })
      .filter(Boolean);
    const top1 = movies.find((m) => Number(m.rank) === 1) || movies[0] || null;
    const moviesSumWan = movies.reduce((sum, m) => sum + (Number(m.todayBox) || 0), 0);
    const nationWan = parseBoxNum
      ? parseBoxNum(nationEntry.text, nationEntry.unit)
      : parseFloat(nationEntry.text);
    const cross = validateNationCrossCheck(nationWan, {
      top1BoxWan: top1?.todayBox || 0,
      top1BoxRate: top1?.boxRateNum || 0,
      moviesSumWan,
      absurdMaxWan: ABSURD_BOX_WAN_MAX,
    });
    if (!cross.ok) {
      return { ok: false, reason: cross.reasons.join("|"), decoded };
    }
  }

  return { ok: true, reason: "", decoded };
}

function findDigitOneGlyphIndex(puaGlyphs) {
  if (!puaGlyphs.length) return -1;
  let idx = 0;
  for (let i = 1; i < puaGlyphs.length; i++) {
    if (puaGlyphs[i].topology.aspect < puaGlyphs[idx].topology.aspect) idx = i;
  }
  return idx;
}

function decodedFingerprint(decoded) {
  if (!decoded) return "";
  const keys = Object.keys(decoded).sort();
  return JSON.stringify(keys.map((key) => [key, decoded[key]?.text || ""]));
}

function validateNationSplitAuxiliary(decoded, parseBoxNum) {
  const nationEntry = decoded?.nation;
  const splitEntry = decoded?.nationSplit;
  if (!nationEntry?.text || !splitEntry?.text || !parseBoxNum) return { ok: true, reason: "" };
  const nationWan = parseBoxNum(nationEntry.text, nationEntry.unit || "万");
  const splitWan = parseBoxNum(splitEntry.text, splitEntry.unit || "万");
  if (!(nationWan > 0 && splitWan > 0)) return { ok: false, reason: "nation_split_non_positive" };
  const ratio = splitWan / nationWan;
  if (ratio < 0.82 || ratio > 0.98) return { ok: false, reason: "nation_split_ratio_mismatch" };
  return { ok: true, reason: "" };
}

export function resolveMapByCrossCheckDisambiguation(puaGlyphs, crossContext = {}, helpers = {}, budget = {}) {
  const movies = Array.isArray(crossContext.movies) ? crossContext.movies : [];
  if (movies.length < 2) {
    return { ok: false, reason: "cross_check_insufficient_movies", map: null, ...emptyMappingPerf() };
  }
  const search = branchAndBoundCrossCheck(puaGlyphs, crossContext, helpers, budget);
  const picked = pickMapFromFingerprints(
    search,
    "cross_check_unique_fingerprint",
    search.timeout
      ? "cross_check_timeout_provisional"
      : "cross_check_ambiguous_provisional",
    crossContext,
  );
  if (picked) {
    return {
      ...picked,
      inspected: search.candidates_examined,
      mapping_duration_ms: search.mapping_duration_ms,
      timeout: false,
    };
  }
  if (search.timeout) {
    return {
      ok: false,
      reason: "mapping_timeout",
      map: null,
      inspected: search.candidates_examined,
      mapping_duration_ms: search.mapping_duration_ms,
      candidates_examined: search.candidates_examined,
      candidates_remaining: search.candidates_remaining,
      timeout: true,
      rejection_reason: "mapping_timeout",
    };
  }
  return {
    ok: false,
    reason: search.reason || "cross_check_no_candidate",
    map: null,
    candidates: search.fingerprints?.size || 0,
    inspected: search.candidates_examined,
    mapping_duration_ms: search.mapping_duration_ms,
    candidates_examined: search.candidates_examined,
    candidates_remaining: search.candidates_remaining,
    timeout: false,
    rejection_reason: search.rejection_reason || search.reason || "",
  };
}

export async function ensurePuaMap(fontStyle, options = {}) {
  const start = nowMs();
  const perf = emptyMappingPerf();
  const normalizedStyle = normalizeFontCssForKey(fontStyle);
  if (!normalizedStyle && !options.fontBuffer) {
    return {
      ok: false,
      versionKey: "",
      reason: "missing_font_style",
      map: null,
      confidence: MAP_CONFIDENCE.NONE,
      ...perf,
      rejection_reason: "missing_font_style",
    };
  }

  const url = extractFontUrls(fontStyle);
  let versionKey = computeVersionKey(fontStyle);
  if (!versionKey) {
    perf.rejection_reason = "missing_version_key";
    return { ok: false, versionKey: "", reason: perf.rejection_reason, map: null, confidence: MAP_CONFIDENCE.NONE, ...perf };
  }

  const cached = mapCache.get(versionKey);
  if (cached?.ok && cached.map && !options.force) return cached;

  if (!url && !options.fontBuffer) {
    perf.rejection_reason = "missing_font_url";
    return { ok: false, versionKey, reason: perf.rejection_reason, map: null, confidence: MAP_CONFIDENCE.NONE, ...perf };
  }

  try {
    const buffer = options.fontBuffer || (await fetchFontBuffer(url));
    versionKey = await computeVersionKeyAsync(fontStyle, buffer);
    const helpers = options.helpers || {};
    const crossContext = options.crossContext || null;
    let built = await buildPuaMapFromFontBuffer(buffer, fontStyle, {
      crossContext,
      helpers,
      budget: options.budget || {},
      authoritativePlaintextTemplate: options.authoritativePlaintextTemplate === true,
    });
    perf.mapping_duration_ms += built.mapping_duration_ms || 0;
    perf.candidates_examined += built.candidates_examined || 0;
    perf.candidates_remaining = built.candidates_remaining || 0;
    perf.timeout = built.timeout === true;

    if (!built.ok && built.puaGlyphs?.length === 10 && crossContext) {
      const disambiguated = resolveMapByCrossCheckDisambiguation(
        built.puaGlyphs,
        crossContext,
        helpers,
        options.budget || {},
      );
      perf.candidates_examined += disambiguated.candidates_examined || 0;
      perf.candidates_remaining = disambiguated.candidates_remaining || 0;
      perf.timeout = disambiguated.timeout === true;
      if (disambiguated.ok && disambiguated.map) {
        built = {
          ...built,
          ok: true,
          reason: disambiguated.reason,
          map: disambiguated.map,
          decoded: disambiguated.decoded || built.decoded,
          method: "cross_check_disambiguation",
          confidence: MAP_CONFIDENCE.INFERRED,
          provisional: disambiguated.provisional === true,
          candidates_examined: disambiguated.candidates_examined,
          candidates_remaining: disambiguated.candidates_remaining,
          timeout: false,
        };
      } else if (disambiguated.timeout) {
        built = {
          ...built,
          ok: false,
          reason: "mapping_timeout",
          rejection_reason: "mapping_timeout",
          timeout: true,
        };
      }
    }

    if (built.ok && built.map && crossContext && Object.keys(helpers).length) {
      const validation = validatePuaMapAgainstContext(built.map, crossContext, helpers);
      if (!validation.ok) {
        built = {
          ...built,
          ok: false,
          reason: `cross_check_failed:${validation.reason}`,
          map: null,
          decoded: validation.decoded,
          confidence: MAP_CONFIDENCE.NONE,
          rejection_reason: validation.reason || "cross_check_failed",
        };
      } else {
        built = { ...built, decoded: validation.decoded, crossValidated: true };
        const evaluated = evaluateMapConfidence(built, crossContext, options);
        built.confidence = evaluated.confidence;
        built.confidence_reason = evaluated.reason;
      }
    }

    built.versionKey = versionKey;
    built.mapping_duration_ms = Math.round((built.mapping_duration_ms || 0) + (nowMs() - start));
    built.candidates_examined = perf.candidates_examined;
    built.candidates_remaining = perf.candidates_remaining;
    built.timeout = perf.timeout;
    built.rejection_reason = built.rejection_reason || (built.ok ? "" : built.reason || "");
    mapCache.set(versionKey, built);
    return built;
  } catch (error) {
    perf.mapping_duration_ms = Math.round(nowMs() - start);
    perf.rejection_reason = `font_load_error:${error.message}`;
    const fail = {
      ok: false,
      versionKey,
      reason: perf.rejection_reason,
      map: null,
      confidence: MAP_CONFIDENCE.NONE,
      ...perf,
    };
    mapCache.set(versionKey, fail);
    return fail;
  }
}

export function getCachedPuaMap(versionKey) {
  const cached = mapCache.get(versionKey);
  return cached?.ok && cached.confidence === MAP_CONFIDENCE.VERIFIED ? cached.map : null;
}

export function clearPuaMapCache(versionKey) {
  if (versionKey) mapCache.delete(versionKey);
  else mapCache.clear();
}

export function decodeMarkupWithPuaMap(markup, map) {
  if (!map || !markup) return { text: "", complete: false, reason: "missing_map" };
  let out = "";
  for (const cp of iterMarkupCodePoints(markup)) {
    if (isPuaCodePoint(cp)) {
      const digit = map.get(cp);
      if (digit == null) return { text: "", complete: false, reason: `unmapped_pua_${cp}` };
      out += digit;
    } else {
      out += String.fromCodePoint(cp);
    }
  }
  const text = out.trim();
  if (!text) return { text: "", complete: false, reason: "empty_decode" };
  return { text, complete: true, reason: "" };
}

export function searchPuaMapByCrossCheck(puaGlyphs, crossContext = {}, helpers = {}, budget = {}) {
  const search = branchAndBoundCrossCheck(puaGlyphs, crossContext, helpers, budget);
  const picked = pickMapFromFingerprints(
    search,
    "cross_check_unique",
    search.timeout ? "cross_check_timeout_provisional" : "cross_check_ambiguous_provisional",
  );
  if (picked) {
    return {
      ...picked,
      timeout: false,
    };
  }
  if (search.timeout) {
    return {
      ok: false,
      reason: "mapping_timeout",
      map: null,
      timeout: true,
      candidates_examined: search.candidates_examined,
      candidates_remaining: search.candidates_remaining,
      rejection_reason: "mapping_timeout",
    };
  }
  return {
    ok: false,
    reason: search.reason || "cross_check_no_candidate",
    map: null,
    candidates_examined: search.candidates_examined,
    candidates_remaining: search.candidates_remaining,
    rejection_reason: search.rejection_reason || search.reason || "",
  };
}

export function isAbsurdBoxWan(value) {
  return Number.isFinite(value) && value > ABSURD_BOX_WAN_MAX;
}
