/**
 * 连续多轮 dashboard + 字体解码链路采集（脱敏，不记录 Cookie/Token）
 * node deploy/trace-dashboard-pipeline.js
 */
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "audit-data", "pipeline-trace");
const API_BASE = process.env.MAOYAN_API_BASE || "http://127.0.0.1:8765";
const ROUNDS = Number(process.env.PIPELINE_ROUNDS || 3);
const INTERVAL_MS = Number(process.env.PIPELINE_INTERVAL_MS || 2500);

async function loadModules() {
  const apiPath = pathToFileURL(path.join(ROOT, "ui", "maoyan-api.js")).href;
  const mapperPath = pathToFileURL(path.join(ROOT, "ui", "font-pua-mapper.js")).href;
  const rankPath = pathToFileURL(path.join(ROOT, "ui", "dashboard-rank.js")).href;
  const [api, mapper, rank] = await Promise.all([
    import(apiPath),
    import(mapperPath),
    import(rankPath),
  ]);
  return { api, mapper, rank };
}

function buildCrossContext(raw, parseRate) {
  const nation = raw?.movieList?.nationBoxInfo ?? {};
  const list = raw?.movieList?.list ?? [];
  return {
    nationHtml: nation.nationBoxSplitUnit?.num || "",
    nationUnit: nation.nationBoxSplitUnit?.unit || "万",
    nationSplitHtml: nation.nationSplitBoxSplitUnit?.num || "",
    nationSplitUnit: nation.nationSplitBoxSplitUnit?.unit || "万",
    movies: list.map((item, index) => ({
      rank: index + 1,
      todayBoxHtml: item.boxSplitUnit?.num || "",
      todayUnit: item.boxSplitUnit?.unit || "万",
      splitBoxHtml: item.splitBoxSplitUnit?.num || "",
      splitUnit: item.splitBoxSplitUnit?.unit || "万",
      boxRate: item.boxRate || "",
      boxRateNum: parseRate(item.boxRate),
    })),
  };
}

async function fetchFontBuffer(fontStyle) {
  const url = mapper.extractFontUrls(fontStyle);
  if (!url) return null;
  const normalized = url.startsWith("//") ? `https:${url}` : url;
  const resp = await fetch(normalized);
  if (!resp.ok) throw new Error(`font fetch ${resp.status}`);
  return resp.arrayBuffer();
}

let mapper;

async function main() {
  const mods = await loadModules();
  mapper = mods.mapper;
  const { api, rank } = mods;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const trace = {
    collectedAt: new Date().toISOString(),
    apiBaseHost: API_BASE.replace(/^https?:\/\//, ""),
    rounds: [],
  };

  for (let i = 0; i < ROUNDS; i += 1) {
    const seq = i + 1;
    const started = Date.now();
    let raw;
    try {
      raw = await api.fetchDashboard(API_BASE, "", { topCount: 10 });
    } catch (error) {
      trace.rounds.push({ seq, error: String(error.message || error) });
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
      continue;
    }

    const businessDate = String(raw?.movieList?.showDate || raw?.showDate || "").slice(0, 10);
    const fontStyle = raw?.fontStyle || "";
    const crossContext = buildCrossContext(raw, rank.parseRate);
    let mapBuilt = null;
    let fontBuffer = null;
    try {
      fontBuffer = await fetchFontBuffer(fontStyle);
      mapBuilt = await mapper.ensurePuaMap(fontStyle, {
        force: i === 0,
        crossContext,
        fontBuffer,
        helpers: {
          validateNationCrossCheck: rank.validateNationCrossCheck,
          validateDecodedBoxStructure: rank.validateDecodedBoxStructure,
          isUntrustedBoxDecode: rank.isUntrustedBoxDecode,
          parseBoxNum: rank.parseBoxNum,
          parseRate: rank.parseRate,
        },
      });
    } catch (error) {
      mapBuilt = { ok: false, reason: String(error.message || error) };
    }

    const parsed = api.parseDashboard(raw, 10);
    const round = {
      seq,
      businessDate,
      fontVersion: mapBuilt?.versionKey || mapper.fontStyleToVersionKey(fontStyle),
      fontReady: Boolean(fontBuffer),
      mapping: {
        ok: Boolean(mapBuilt?.ok),
        confidence: mapBuilt?.confidence || "",
        reason: mapBuilt?.reason || "",
        confidence_reason: mapBuilt?.confidence_reason || "",
        rejection_reason: mapBuilt?.rejection_reason || mapBuilt?.reason || "",
      },
      nation: null,
      movies: [],
      elapsedMs: Date.now() - started,
    };

    const decodeWithMap = (html) => {
      if (!mapBuilt?.ok || !mapBuilt.map || mapBuilt.confidence !== mapper.MAP_CONFIDENCE.VERIFIED) {
        return { text: "", complete: false, reason: "map_not_verified" };
      }
      return mapper.decodeMarkupWithPuaMap(html, mapBuilt.map);
    };

    if (parsed?.nation) {
      const html = parsed.nation.todayBoxHtml || "";
      const decoded = decodeWithMap(html);
      const todayBoxWan =
        decoded.complete && decoded.text
          ? rank.parseBoxNum(decoded.text, parsed.nation.todayUnit || "万")
          : 0;
      round.nation = {
        todayBoxHtml: html,
        todayUnit: parsed.nation.todayUnit || "万",
        decodeStatus: todayBoxWan > 0 ? "ok" : html ? "encoded_or_pending" : "missing",
        rejectionReason: round.mapping.rejection_reason || decoded.reason || "",
        decodedString: decoded.text || "",
        todayBoxWan,
        displaySource: todayBoxWan > 0 ? "decoded_plain" : html ? "encoded_glyph" : "missing",
        bubbleInputWan: todayBoxWan > 0 ? todayBoxWan : 0,
        bubbleWouldTrigger: false,
      };
    }

    for (const movie of parsed.movies || []) {
      const html = movie.todayBoxHtml || "";
      const decoded = decodeWithMap(html);
      const todayBoxWan =
        decoded.complete && decoded.text
          ? rank.parseBoxNum(decoded.text, movie.todayUnit || "万")
          : 0;
      round.movies.push({
        movieId: movie.movieId,
        rank: movie.rank,
        name: movie.name,
        todayBoxHtml: html,
        todayUnit: movie.todayUnit || "万",
        decodeStatus: todayBoxWan > 0 ? "ok" : html ? "encoded_or_pending" : "missing",
        rejectionReason: decoded.reason || round.mapping.rejection_reason || "",
        decodedString: decoded.text || "",
        todayBoxWan,
        displaySource: todayBoxWan > 0 ? "decoded_plain" : html ? "encoded_glyph" : "missing",
        bubbleInputWan: todayBoxWan,
        bubbleWouldTrigger: false,
      });
      if (todayBoxWan > 0) prevNation = todayBoxWan;
    }

    trace.rounds.push(round);
    if (i < ROUNDS - 1) await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  const outFile = path.join(OUT_DIR, `trace-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(trace, null, 2));
  console.log(`Wrote ${outFile}`);
  for (const round of trace.rounds) {
    console.log(
      `[${round.seq}] date=${round.businessDate} font=${round.fontVersion} conf=${round.mapping.confidence} nation=${round.nation?.todayBoxWan || 0} decoded=${(round.movies || []).filter((m) => m.todayBoxWan > 0).length}/${(round.movies || []).length}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
