/**
 * 猫眼真实响应字段审计采集（只读，不改业务逻辑）
 * node deploy/audit-maoyan-fields.js
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "audit-data", "maoyan-fields");
const API_BASE = process.env.MAOYAN_API_BASE || "http://127.0.0.1:8765";
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const SENSITIVE_KEY_RE =
  /^(cookie|cookies|authorization|token|access_token|refresh_token|signkey|sign_key|signature|sign|uuid|timestamp|timestamp_ms|phone|mobile|mob|deviceid|device_id|userid|user_id|session|sessionid|password|secret|privatekey|private_key|browserstate|storage|auth|csrf|xss)$/i;

const URL_QUERY_SENSITIVE = /sign|signature|token|uuid|timestamp|signkey|auth/i;

const SUMMARY_COLUMN_DEFS = [
  [
    { key: "dynamicForecast", label: "动态预测" },
    { key: "endDate", label: "下映日期" },
    { key: "releaseInfo", label: "上映" },
  ],
  [
    { key: "dailyBox", label: "实时票房" },
    { key: "boxRate", label: "票房占比" },
  ],
  [
    { key: "avgShowView", label: "场均人次" },
    { key: "showCountRate", label: "排片占比" },
  ],
];

const EXTRA_SUMMARY_DEFS = [
  { key: "dailyIncrease", label: "日增" },
  { key: "yesterdayTotal", label: "昨日" },
  { key: "yesterdaySamePeriod", label: "昨日同期" },
  { key: "yesterdayHourSpeed", label: "昨日时速" },
  { key: "totalViews", label: "总人次" },
  { key: "showCountDesc", label: "排片场次" },
  { key: "sumBoxDesc", label: "累计票房" },
  { key: "sumSplitBoxDesc", label: "分账票房" },
  { key: "splitBoxRate", label: "分账占比" },
  { key: "hmtBox", label: "港澳台" },
  { key: "overseasBox", label: "海外" },
  { key: "endDate", label: "下映日期" },
];

const DAILY_TABLE_COLUMNS = [
  { key: "box", label: "票房" },
  { key: "forecast", label: "预测" },
  { key: "boxRate", label: "票房%" },
  { key: "showCountRate", label: "排片%" },
  { key: "avgSeatView", label: "上座率" },
];

const DAILY_TABLE_LABELS = ["今日", "明日", "后天"];

function unwrapPayload(raw) {
  return raw?.data?.data ?? raw?.data ?? raw;
}

function desensitizeString(text) {
  const s = String(text);
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(s)) return "[REDACTED]";
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      for (const key of [...u.searchParams.keys()]) {
        if (URL_QUERY_SENSITIVE.test(key)) {
          u.searchParams.set(key, "[REDACTED]");
        }
      }
      return u.toString();
    } catch {
      return s.replace(/([?&])(sign|signature|token|uuid|signKey|timeStamp)=[^&]*/gi, "$1$2=[REDACTED]");
    }
  }
  return s;
}

function desensitize(value, depth = 0) {
  if (depth > 24) return "[TRUNCATED]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return desensitizeString(value);
  if (Array.isArray(value)) return value.map((item) => desensitize(item, depth + 1));
  if (typeof value !== "object") return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = desensitize(val, depth + 1);
    }
  }
  return out;
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function writeJsonFile(filePath, data) {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(filePath, text, "utf8");
  return sha256Text(text);
}

function isEmptyField(val) {
  if (val == null) return true;
  if (Array.isArray(val)) return !val.length;
  const text = String(val).trim();
  return !text || text === "--" || text === "-";
}

function formatMoneyMetric(val) {
  if (isEmptyField(val)) return "--";
  const text = String(val).trim();
  if (text.startsWith("¥")) return text;
  if (text.includes("亿") || text.includes("万") || text.includes("%")) {
    return text.includes("亿") || text.includes("万") ? `¥${text}` : text;
  }
  return `¥${text}`;
}

function formatHourSpeedDisplay(text) {
  if (isEmptyField(text)) return "--";
  const raw = String(text).trim().replace(/^¥/, "");
  return raw.includes("/h") ? raw : `${raw}/h`;
}

function formatEndDateMetric(m) {
  const hasDate = !isEmptyField(m?.endDate);
  const hasDays = !isEmptyField(m?.remainingDays);
  if (!hasDate && !hasDays) return "--";
  const dateText = hasDate ? String(m.endDate).replace(/^\d{4}-/, "").trim() : "";
  const days = hasDays ? `剩${String(m.remainingDays).trim()}天` : "";
  if (dateText && days) return `${dateText} ${days}`;
  return dateText || days || "--";
}

function formatReleaseMetric(m, formatReleaseTag) {
  if (!isEmptyField(m?.releaseDate)) {
    return String(m.releaseDate).replace(/^\d{4}-/, "").trim();
  }
  const tagged = formatReleaseTag(m?.releaseInfo);
  if (!isEmptyField(tagged)) return tagged;
  if (!isEmptyField(m?.releaseInfo)) return String(m.releaseInfo).trim();
  return "--";
}

function formatDailyBoxDisplay(movie, helpers) {
  const { formatWanDisplayText, formatBoxTextForDisplay, parseBoxNum, resolveChampionBoxWan, isUntrustedBoxDecode } =
    helpers;
  const amount = resolveChampionBoxWan(movie);
  if (amount > 0) return `¥${formatWanDisplayText(amount)}`;
  if (!isEmptyField(movie.todayBoxText) && movie.todayBoxText !== "--") {
    const text = String(movie.todayBoxText).trim();
    if (isUntrustedBoxDecode(text)) return "[encoded-font]";
    const unit = movie.todayUnit || "万";
    const normalized = formatBoxTextForDisplay(text, unit, parseBoxNum);
    if (normalized) return `¥${normalized}`;
  }
  return "--";
}

function formatMainlandDisplay(movie) {
  const raw = movie.mainlandBox || "";
  if (isEmptyField(raw)) return "--";
  const text = String(raw).trim();
  if (text.startsWith("¥")) return text;
  if (text.includes("亿") || text.includes("万")) return `¥${text}`;
  return `¥${text}`;
}

function resolveDisplayDate(parsed) {
  const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
  let d = null;
  if (parsed?.updateTimestamp) d = new Date(Number(parsed.updateTimestamp));
  if ((!d || Number.isNaN(d.getTime())) && parsed?.updateTimeText) {
    d = new Date(String(parsed.updateTimeText).replace(/-/g, "/"));
  }
  if (!d || Number.isNaN(d.getTime())) d = new Date();

  let y = d.getFullYear();
  let m = d.getMonth() + 1;
  let day = d.getDate();
  const calendarDay = String(parsed?.calendar?.today || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(calendarDay)) {
    const [cy, cm, cd] = calendarDay.split("-").map(Number);
    if (cy && cm && cd) {
      y = cy;
      m = cm;
      day = cd;
    }
  }
  return `今日：${y}年${String(m).padStart(2, "0")}月${String(day).padStart(2, "0")}日 周${WEEK[d.getDay()]}`;
}

function resolveNationBoxDisplay(nation, helpers) {
  const { formatWanDisplayText, resolveChampionBoxWan } = helpers;
  const amount = nation?.todayBox > 0 ? nation.todayBox : 0;
  if (amount > 0) return `¥${formatWanDisplayText(amount)}`;
  const text = String(nation?.todayBoxText || "").trim();
  if (text && text !== "--") return `${text}${nation?.todayUnit || "万"}`;
  return "--";
}

function ensureDailyTable(movie, helpers) {
  const labels = DAILY_TABLE_LABELS;
  const src = Array.isArray(movie.dailyTable) ? movie.dailyTable : [];
  const byLabel = new Map(src.map((row) => [String(row.label || "").trim(), row]));
  const amount = helpers.resolveChampionBoxWan(movie);

  return labels.map((label, i) => {
    const prev = byLabel.get(label) || src[i] || {};
    const isToday = i === 0;
    const box = isToday
      ? amount > 0
        ? helpers.formatWanDisplayText(amount)
        : !isEmptyField(prev.box) && prev.box !== "--"
          ? prev.box
          : "--"
      : !isEmptyField(prev.box) && prev.box !== "--"
        ? prev.box
        : "--";
    return {
      label,
      box,
      forecast:
        !isEmptyField(prev.forecast) && prev.forecast !== "--"
          ? prev.forecast
          : isToday && !isEmptyField(movie.dynamicForecast)
            ? movie.dynamicForecast
            : "--",
      boxRate:
        !isEmptyField(prev.boxRate) && prev.boxRate !== "--"
          ? prev.boxRate
          : isToday && !isEmptyField(movie.boxRate)
            ? movie.boxRate
            : "--",
      showCountRate:
        !isEmptyField(prev.showCountRate) && prev.showCountRate !== "--"
          ? prev.showCountRate
          : isToday && !isEmptyField(movie.showCountRate)
            ? movie.showCountRate
            : "--",
      avgSeatView:
        !isEmptyField(prev.avgSeatView) && prev.avgSeatView !== "--"
          ? prev.avgSeatView
          : isToday && !isEmptyField(movie.avgSeatView)
            ? movie.avgSeatView
            : "--",
    };
  });
}

function resolveSummaryDisplay(def, movie, helpers) {
  switch (def.key) {
    case "dynamicForecast":
      return formatMoneyMetric(movie.dynamicForecast) || formatMoneyMetric(movie.dailyTable?.[0]?.forecast) || "--";
    case "endDate":
      return formatEndDateMetric(movie);
    case "releaseInfo":
      return formatReleaseMetric(movie, helpers.formatReleaseTag);
    case "dailyBox":
      return formatDailyBoxDisplay(movie, helpers);
    case "boxRate":
      return movie.boxRate || movie.dailyTable?.[0]?.boxRate || "--";
    case "avgShowView":
      return movie.avgShowView || "--";
    case "showCountRate":
      return movie.showCountRate || movie.dailyTable?.[0]?.showCountRate || "--";
    default:
      return "--";
  }
}

function resolveExtraSummaryDisplay(def, movie) {
  switch (def.key) {
    case "dailyIncrease":
      return formatMoneyMetric(movie.dailyIncrease);
    case "yesterdayTotal":
      return formatMoneyMetric(movie.yesterdayTotal);
    case "yesterdaySamePeriod":
      return formatMoneyMetric(movie.yesterdaySamePeriodText);
    case "yesterdayHourSpeed":
      return formatHourSpeedDisplay(formatMoneyMetric(formatHourSpeedDisplay(movie.yesterdayHourSpeedText)));
    case "totalViews":
      return movie.totalViews || "--";
    case "showCountDesc":
      if (!isEmptyField(movie.showCountDesc)) return String(movie.showCountDesc).trim();
      if (movie.showCount > 0) {
        return movie.showCount >= 10000
          ? `${(movie.showCount / 10000).toFixed(1)}万场`
          : `${movie.showCount}场`;
      }
      return "--";
    case "sumBoxDesc":
      return formatMoneyMetric(movie.sumBoxDesc);
    case "sumSplitBoxDesc":
      return formatMoneyMetric(movie.sumSplitBoxDesc);
    case "splitBoxRate":
      return movie.splitBoxRate || "--";
    case "hmtBox":
      return formatMoneyMetric(movie.hmtBox);
    case "overseasBox":
      return formatMoneyMetric(movie.overseasBox);
    case "endDate":
      return formatEndDateMetric(movie);
    default:
      return "--";
  }
}

function lookupFieldMap(fieldMap, key) {
  return fieldMap.find((row) => row.key === key) || null;
}

function sourceFunctionForKey(key, fieldMap) {
  const row = lookupFieldMap(fieldMap, key);
  if (!row) {
    if (key === "dailyBox" || key === "todayBox") return "parseDashboard";
    if (key === "mainlandBox") return "parseGlobalMetrics";
    return "ui-display";
  }
  const source = row.source;
  if (source === "dashboard") return "parseDashboard";
  if (source === "getPredictionBox") return "parsePredictionMetrics";
  if (source === "getBoxShow") return "parseBoxShowMetrics";
  if (source === "getBoxShowna") return "parseGlobalMetrics";
  if (source === "getTechData") return "parseTechMetrics";
  return source;
}

function buildRenderedFields(enriched, parsed, nation, fieldMap, helpers) {
  const items = [];
  const push = (entry) => items.push(entry);

  push({
    location: "全国大盘",
    label: parsed.nation?.title || "实时大盘",
    frontend_key: "nation.todayBox",
    display_value: resolveNationBoxDisplay(nation, helpers),
    source_function: "parseDashboard",
    raw_path_claimed: "movieList.nationBoxInfo.nationBoxSplitUnit",
  });
  push({
    location: "全国大盘",
    label: "排片场次",
    frontend_key: "nation.showCountDesc",
    display_value: nation.showCountDesc || "--",
    source_function: "parseDashboard",
    raw_path_claimed: "movieList.nationBoxInfo.showCountDesc",
  });
  push({
    location: "全国大盘",
    label: "观影人次",
    frontend_key: "nation.viewCountDesc",
    display_value: nation.viewCountDesc || "--",
    source_function: "parseDashboard",
    raw_path_claimed: "movieList.nationBoxInfo.viewCountDesc",
  });
  push({
    location: "全国大盘",
    label: nation.seatLabel || "实时上座",
    frontend_key: "nation.seatValue",
    display_value: nation.seatValue || "--",
    source_function: "parseDashboard",
    raw_path_claimed: "movieList.nationBoxInfo.avgSeatView|avgShowView",
  });
  push({
    location: "全国大盘",
    label: "日期",
    frontend_key: "heroDate",
    display_value: resolveDisplayDate(parsed),
    source_function: "parseDashboard",
    raw_path_claimed: "calendar.today + updateInfo.updateTimestamp",
  });

  for (const movie of enriched) {
    const top = `TOP${movie.rank}卡片`;
    const mapRow = (key) => lookupFieldMap(fieldMap, key);

    push({
      location: top,
      label: "中国内地",
      frontend_key: "mainlandBox",
      display_value: formatMainlandDisplay(movie),
      source_function: "parseGlobalMetrics",
      raw_path_claimed:
        mapRow("mainlandBox")?.raw ||
        "nationData.globalBoxRankList[regionName=中国内地].sumBoxInfo",
    });

    for (const col of SUMMARY_COLUMN_DEFS.flat()) {
      const row = mapRow(col.key === "dailyBox" ? "todayBox" : col.key) || mapRow(col.key);
      push({
        location: top,
        label: col.label,
        frontend_key: col.key === "dailyBox" ? "todayBox" : col.key,
        display_value: resolveSummaryDisplay(col, movie, helpers),
        source_function: sourceFunctionForKey(col.key === "dailyBox" ? "todayBox" : col.key, fieldMap),
        raw_path_claimed: row?.raw || "",
      });
    }

    if (Number(movie.rank) === 1) {
      const rows = ensureDailyTable(movie, helpers);
      for (const row of rows) {
        const tableLoc = `${top}/${row.label}表格`;
        for (const col of DAILY_TABLE_COLUMNS) {
          push({
            location: tableLoc,
            label: col.label,
            frontend_key: `dailyTable.${row.label}.${col.key}`,
            display_value: row[col.key] || "--",
            source_function:
              col.key === "forecast"
                ? "parsePredictionMetrics"
                : col.key === "box"
                  ? "parseDashboard|parseBoxShowMetrics"
                  : "parseDashboard|parseBoxShowMetrics|parsePredictionMetrics",
            raw_path_claimed:
              col.key === "forecast"
                ? "predictionBoxList|pageData.list"
                : col.key === "box"
                  ? "boxSplitUnit|boxDatas"
                  : col.key,
          });
        }
      }
    }

    for (const def of EXTRA_SUMMARY_DEFS) {
      push({
        location: `${top}/隐藏补充字段(MAX_EXTRA_SUMMARY_METRICS=0)`,
        label: def.label,
        frontend_key: def.key,
        display_value: resolveExtraSummaryDisplay(def, movie),
        source_function: sourceFunctionForKey(def.key, fieldMap),
        raw_path_claimed: mapRow(def.key)?.raw || "",
      });
    }
  }

  return items;
}

function extractDashboardRaw(raw, movies) {
  const movieList = raw?.movieList || {};
  const out = {
    calendar: raw?.calendar,
    updateInfo: movieList.updateInfo,
    nationBoxInfo: movieList.nationBoxInfo,
    fontStyle: raw?.fontStyle,
    globalBoxTrends: raw?.movieInfo?.boxTrends,
    movies: movies.map((m) => {
      const item = m.listItem || {};
      const perMovie = { movieId: m.movieId, name: m.name, listItem: item };
      if (item?.movieInfo?.boxTrends) {
        perMovie.boxTrends = item.movieInfo.boxTrends;
      }
      return perMovie;
    }),
  };
  return out;
}

function extractPredictionRaw(raw) {
  const inner = unwrapPayload(raw);
  const out = {};
  const keys = [
    "predictionBoxList",
    "boxPredictionList",
    "pageData",
    "sumPrediction",
    "totalPrediction",
    "dynamicPrediction",
    "todayPrediction",
    "predictionBox",
    "boxPrediction",
    "detail",
    "list",
    "dayList",
  ];
  for (const key of keys) {
    if (inner?.[key] !== undefined) out[key] = inner[key];
  }
  return out;
}

function extractBoxShowRaw(raw) {
  const inner = unwrapPayload(raw);
  return {
    timeFilterChartData: inner?.timeFilterChartData,
    timeChartData: inner?.timeChartData,
    boxDatas: inner?.boxDatas,
    boxInfoDataRes: inner?.boxInfoDataRes,
  };
}

function extractGlobalRaw(raw) {
  const inner = unwrapPayload(raw);
  if (!inner || typeof inner !== "object") return {};
  const out = {};
  const keys = [
    "chinaBoxDesc",
    "hmtBoxDesc",
    "overseasBoxDesc",
    "gatBoxDesc",
    "chinaGatBoxDesc",
    "mainlandBoxDesc",
    "sumBoxDesc",
    "boxDesc",
    "boxList",
    "areaList",
    "regionList",
    "list",
    "data",
    "boxInfo",
    "boxInfoDataRes",
  ];
  for (const key of keys) {
    if (inner[key] !== undefined) out[key] = inner[key];
  }
  if (!Object.keys(out).length) {
    for (const [key, val] of Object.entries(inner)) {
      if (SENSITIVE_KEY_RE.test(key)) continue;
      if (key === "detail" && typeof val === "string") continue;
      out[key] = val;
    }
  }
  return out;
}

function hasGlobalBusinessData(rawSlice) {
  const text = JSON.stringify(rawSlice || {});
  return /BoxDesc|boxList|regionList|areaList|overseas|hmt|china|港澳台|海外|内地/i.test(text);
}

function extractTechRaw(raw) {
  const inner = unwrapPayload(raw);
  const out = {};
  const keys = [
    "items",
    "endDate",
    "releaseDate",
    "offlineDate",
    "beginDate",
    "startDate",
    "showDate",
    "releaseTime",
    "openDay",
    "lastShowDate",
    "endShowDate",
    "showEndDate",
    "offlineDay",
  ];
  for (const key of keys) {
    if (inner?.[key] !== undefined) out[key] = inner[key];
  }
  return out;
}

function structureFingerprint(obj) {
  const keys = [];
  const walk = (node, prefix = "", depth = 0) => {
    if (!node || typeof node !== "object" || depth > 4) return;
    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === "object") walk(node[0], `${prefix}[]`, depth + 1);
      return;
    }
    for (const key of Object.keys(node).sort()) {
      const path = prefix ? `${prefix}.${key}` : key;
      keys.push(path);
      walk(node[key], path, depth + 1);
    }
  };
  walk(obj);
  return keys.join("|");
}

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs || 25000) });
  const body = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, body };
}

async function checkServiceReady() {
  try {
    const { ok, body } = await fetchJson(`${API_BASE}/health/ready`, { timeoutMs: 8000 });
    return { reachable: ok, ready: Boolean(body?.ok), detail: body || null };
  } catch (error) {
    return { reachable: false, ready: false, detail: { error: error.message } };
  }
}

async function warmSignatures(movieId) {
  const url = `${API_BASE}/api/refresh?` + new URLSearchParams({ movieId: String(movieId), boxLevel: "1" });
  const { ok, status, body } = await fetchJson(url, { timeoutMs: 45000 });
  return { ok, status, body };
}

function scanForSensitiveCredentials(text) {
  const issues = [];
  const patterns = [
    { name: "authorization header", re: /"authorization"\s*:\s*"(?!(\[REDACTED\]|--))[^"]+"/i },
    { name: "cookie value", re: /"cookie"\s*:\s*"(?!(\[REDACTED\]|--))[^"]{8,}"/i },
    { name: "signKey literal", re: /"signKey"\s*:\s*"(?!(\[REDACTED\]|""))[^"]+"/i },
    { name: "token literal", re: /"(access_token|refresh_token|session_token)"\s*:\s*"(?!(\[REDACTED\]))[^"]+"/i },
    { name: "phone number", re: /"phone"\s*:\s*"\d{11}"/i },
    { name: "unsigned url sign param", re: /[?&](sign|signature|signKey)=([A-Za-z0-9%+/=]{16,})/i },
  ];
  for (const p of patterns) {
    if (p.re.test(text)) issues.push(p.name);
  }
  return issues;
}

function findListItem(raw, movieId) {
  const list = raw?.movieList?.list;
  if (!Array.isArray(list)) return null;
  return (
    list.find((item) => {
      const id = item?.movieId ?? item?.movieInfo?.movieId;
      return String(id) === String(movieId);
    }) || null
  );
}

function pickSecondaryMovie(primaryId, candidates, fetchRawFn) {
  return (async () => {
    const primaryRaw = await fetchRawFn(primaryId);
    const primaryFp = structureFingerprint(primaryRaw);
    for (const movie of candidates) {
      if (String(movie.movieId) === String(primaryId)) continue;
      const raw = await fetchRawFn(movie.movieId);
      if (structureFingerprint(raw) !== primaryFp) {
        return { movie, raw };
      }
    }
    return null;
  })();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const apiPath = pathToFileURL(path.join(ROOT, "ui", "maoyan-api.js")).href;
  const boxDisplayPath = pathToFileURL(path.join(ROOT, "ui", "box-display.js")).href;
  const {
    fetchDashboard,
    parseDashboard,
    enrichMovies,
    fetchPredictionBox,
    fetchBoxShow,
    fetchBoxShowna,
    fetchTechData,
    parsePredictionMetrics,
    parseBoxShowMetrics,
    parseGlobalMetrics,
    parseTechMetrics,
    EXTRA_METRIC_FIELD_MAP,
    resolveChampionBoxWan,
    resolveNationSeatMetric,
    formatReleaseTag,
    parseBoxNum,
    isUntrustedBoxDecode,
    resetApiSigWarm,
  } = await import(apiPath);
  const { formatWanDisplayText, formatBoxTextForDisplay } = await import(boxDisplayPath);

  const helpers = {
    formatWanDisplayText,
    formatBoxTextForDisplay,
    parseBoxNum,
    resolveChampionBoxWan,
    isUntrustedBoxDecode,
    formatReleaseTag,
  };

  const collectedAt = new Date().toISOString();
  const manifest = {
    collectedAt,
    appVersion: PACKAGE_VERSION,
    apiBaseHost: "127.0.0.1:8765",
    entries: [],
  };

  const service = await checkServiceReady();
  if (!service.reachable) {
    console.error("猫眼本地服务不可达，请先启动应用并完成登录后再运行 audit:maoyan-fields");
    manifest.entries.push({
      api: "service",
      httpStatus: 0,
      movieId: null,
      businessDate: null,
      file: null,
      sha256: null,
      success: false,
      missingReason: "本地服务不可达 (127.0.0.1:8765)",
    });
    writeJsonFile(path.join(OUT_DIR, "manifest.json"), manifest);
    process.exit(1);
  }

  resetApiSigWarm();

  let dashboardRaw = null;
  let dashboardStatus = 0;
  let dashboardError = null;
  try {
    dashboardRaw = await fetchDashboard(API_BASE);
    dashboardStatus = 200;
  } catch (error) {
    dashboardError = error?.detail || error?.message || String(error);
  }

  const businessDate = dashboardRaw?.calendar?.today || null;
  let parsedDashboard = null;
  if (dashboardRaw) {
    parsedDashboard = parseDashboard(dashboardRaw, 5);
  }

  const primaryMovie = parsedDashboard?.movies?.[0] || null;
  const sampleMovies = [];
  if (primaryMovie) {
    sampleMovies.push({
      movieId: primaryMovie.movieId,
      name: primaryMovie.name,
      listItem: findListItem(dashboardRaw, primaryMovie.movieId),
    });
  }

  if (primaryMovie) {
    const warm = await warmSignatures(primaryMovie.movieId);
    if (!warm.ok) {
      manifest.entries.push({
        api: "signature-warm",
        httpStatus: warm.status,
        movieId: primaryMovie.movieId,
        businessDate,
        file: null,
        sha256: null,
        success: false,
        missingReason: warm.body?.detail || "签名预热失败，可能未登录或会话失效",
      });
    }
  }

  const predictionSamples = [];
  const boxShowSamples = [];
  const globalSamples = [];
  const techSamples = [];

  async function captureMovieApis(movie) {
    const movieId = movie.movieId;
    const sampleBase = { movieId, name: movie.name, httpStatus: 200, success: true, missingReason: null };

    let predictionRaw = null;
    let boxShowRaw = null;
    let globalRaw = null;
    let techRaw = null;

    try {
      predictionRaw = await fetchPredictionBox(API_BASE, movieId);
    } catch (error) {
      predictionSamples.push({
        ...sampleBase,
        success: false,
        httpStatus: 0,
        missingReason: error?.detail || error?.message || "getPredictionBox 失败",
        raw: null,
        parsed: null,
      });
    }

    try {
      boxShowRaw = await fetchBoxShow(API_BASE, movieId, 1);
    } catch (error) {
      boxShowSamples.push({
        ...sampleBase,
        success: false,
        httpStatus: 0,
        missingReason: error?.detail || error?.message || "getBoxShow 失败",
        raw: null,
        parsed: null,
      });
    }

    try {
      globalRaw = await fetchBoxShowna(API_BASE, movieId);
    } catch (error) {
      globalSamples.push({
        ...sampleBase,
        success: false,
        httpStatus: 0,
        missingReason: error?.detail || error?.message || "getBoxShowna 失败",
        raw: null,
        parsed: null,
      });
    }

    try {
      techRaw = await fetchTechData(API_BASE, movieId);
    } catch (error) {
      techSamples.push({
        ...sampleBase,
        success: false,
        httpStatus: 0,
        missingReason: error?.detail || error?.message || "getTechData 失败",
        raw: null,
        parsed: null,
      });
    }

    if (predictionRaw) {
      predictionSamples.push({
        ...sampleBase,
        raw: desensitize(extractPredictionRaw(predictionRaw)),
        parsed: parsePredictionMetrics(predictionRaw, businessDate || ""),
      });
    }
    if (boxShowRaw) {
      boxShowSamples.push({
        ...sampleBase,
        raw: desensitize(extractBoxShowRaw(boxShowRaw)),
        parsed: parseBoxShowMetrics(boxShowRaw, businessDate || ""),
      });
    }
    if (globalRaw) {
      globalSamples.push({
        ...sampleBase,
        raw: desensitize(extractGlobalRaw(globalRaw)),
        parsed: parseGlobalMetrics(globalRaw),
      });
    }
    if (techRaw) {
      techSamples.push({
        ...sampleBase,
        raw: desensitize(extractTechRaw(techRaw)),
        parsed: parseTechMetrics(techRaw),
      });
    }

    return { predictionRaw, boxShowRaw, globalRaw, techRaw };
  }

  if (primaryMovie) {
    await captureMovieApis(primaryMovie);

    const others = (parsedDashboard?.movies || []).slice(1, 5);
    const secondary = await pickSecondaryMovie(primaryMovie.movieId, others, async (movieId) => {
      try {
        return extractPredictionRaw(await fetchPredictionBox(API_BASE, movieId));
      } catch {
        return {};
      }
    });

    if (secondary?.movie) {
      sampleMovies.push({
        movieId: secondary.movie.movieId,
        name: secondary.movie.name,
        listItem: findListItem(dashboardRaw, secondary.movie.movieId),
        note: "结构不同于主样本",
      });
      await captureMovieApis(secondary.movie);
    }

    const globalPrimary = globalSamples.find((s) => String(s.movieId) === String(primaryMovie.movieId));
    if (globalPrimary && !hasGlobalBusinessData(globalPrimary.raw)) {
      for (const movie of others) {
        try {
          const globalRaw = await fetchBoxShowna(API_BASE, movie.movieId);
          const slice = desensitize(extractGlobalRaw(globalRaw));
          if (!hasGlobalBusinessData(slice)) continue;
          globalSamples.push({
            movieId: movie.movieId,
            name: movie.name,
            success: true,
            httpStatus: 200,
            missingReason: null,
            raw: slice,
            parsed: parseGlobalMetrics(globalRaw),
          });
          break;
        } catch {
          /* try next */
        }
      }
    }
  }

  let enriched = [];
  if (parsedDashboard?.movies?.length) {
    enriched = await enrichMovies(API_BASE, parsedDashboard.movies, {
      trendLimit: 5,
      enableExtraApis: true,
      todayStr: businessDate || "",
      concurrency: 2,
    });
  }

  const nation = parsedDashboard?.nation || null;
  const nationSeat = nation ? resolveNationSeatMetric(nation) : null;
  if (nation && nationSeat) {
    nation.seatLabel = nationSeat.label;
    nation.seatValue = nationSeat.value;
  }

  const files = [];

  if (dashboardRaw) {
    const dashboardRawDoc = desensitize({
      schema: "maoyan-audit-v1",
      collectedAt,
      businessDate,
      nation: extractDashboardRaw(dashboardRaw, []).nationBoxInfo
        ? {
            calendar: dashboardRaw.calendar,
            updateInfo: dashboardRaw.movieList?.updateInfo,
            nationBoxInfo: dashboardRaw.movieList?.nationBoxInfo,
            fontStyle: dashboardRaw.fontStyle,
            globalBoxTrends: dashboardRaw.movieInfo?.boxTrends,
          }
        : {},
      movies: sampleMovies.map((m) => ({
        movieId: m.movieId,
        name: m.name,
        listItem: m.listItem,
        boxTrends: m.listItem?.movieInfo?.boxTrends,
      })),
    });
    files.push({
      api: "dashboard",
      rawFile: "01-dashboard-raw.json",
      parsedFile: "01-dashboard-parsed.json",
      rawDoc: dashboardRawDoc,
      parsedDoc: {
        schema: "maoyan-audit-v1",
        collectedAt,
        businessDate,
        nation,
        calendar: parsedDashboard?.calendar,
        updateGapSecond: parsedDashboard?.updateGapSecond,
        updateTimestamp: parsedDashboard?.updateTimestamp,
        updateTimeText: parsedDashboard?.updateTimeText,
        globalTrends: parsedDashboard?.globalTrends,
        movies: enriched,
      },
      httpStatus: dashboardStatus,
      movieId: null,
      success: true,
      missingReason: null,
    });
  } else {
    manifest.entries.push({
      api: "dashboard",
      httpStatus: dashboardStatus,
      movieId: null,
      businessDate,
      file: "01-dashboard-raw.json",
      sha256: null,
      success: false,
      missingReason: dashboardError || "dashboard 无数据",
    });
  }

  const detailSets = [
    { api: "getPredictionBox", prefix: "02-prediction", samples: predictionSamples },
    { api: "getBoxShow", prefix: "03-box-show", samples: boxShowSamples },
    { api: "getBoxShowna", prefix: "04-global-box", samples: globalSamples },
    { api: "getTechData", prefix: "05-tech-data", samples: techSamples },
  ];

  for (const set of detailSets) {
    const rawFile = `${set.prefix}-raw.json`;
    const parsedFile = `${set.prefix}-parsed.json`;
    const successSamples = set.samples.filter((s) => s.raw || s.parsed);
    const rawDoc = {
      schema: "maoyan-audit-v1",
      collectedAt,
      businessDate,
      api: set.api,
      samples: successSamples.map(({ movieId, name, raw, success, missingReason }) => ({
        movieId,
        name,
        success,
        missingReason,
        raw,
      })),
      failures: set.samples
        .filter((s) => !s.raw && !s.success)
        .map(({ movieId, name, missingReason }) => ({ movieId, name, missingReason })),
    };
    const parsedDoc = {
      schema: "maoyan-audit-v1",
      collectedAt,
      businessDate,
      api: set.api,
      samples: set.samples.map(({ movieId, name, parsed, success, missingReason }) => ({
        movieId,
        name,
        success: success && parsed != null,
        missingReason: parsed == null ? missingReason || "解析为空" : missingReason,
        parsed,
      })),
    };

    files.push({
      api: set.api,
      rawFile,
      parsedFile,
      rawDoc,
      parsedDoc,
      httpStatus: successSamples.length ? 200 : 0,
      movieId: successSamples[0]?.movieId || null,
      success: successSamples.length > 0,
      missingReason:
        successSamples.length > 0
          ? null
          : set.samples.map((s) => s.missingReason).filter(Boolean).join("; ") || "无成功样本",
    });
  }

  const renderedDoc = {
    schema: "maoyan-audit-v1",
    collectedAt,
    businessDate,
    items: buildRenderedFields(enriched, parsedDashboard || {}, nation || {}, EXTRA_METRIC_FIELD_MAP, helpers),
  };
  files.push({
    api: "rendered-fields",
    rawFile: null,
    parsedFile: "06-current-rendered-fields.json",
    rawDoc: null,
    parsedDoc: renderedDoc,
    httpStatus: enriched.length ? 200 : 0,
    movieId: null,
    success: enriched.length > 0,
    missingReason: enriched.length ? null : "无 enriched 电影数据",
  });

  const shaByFile = {};
  for (const file of files) {
    if (file.rawDoc && file.rawFile) {
      shaByFile[file.rawFile] = writeJsonFile(path.join(OUT_DIR, file.rawFile), file.rawDoc);
      JSON.parse(fs.readFileSync(path.join(OUT_DIR, file.rawFile), "utf8"));
    }
    if (file.parsedDoc && file.parsedFile) {
      shaByFile[file.parsedFile] = writeJsonFile(path.join(OUT_DIR, file.parsedFile), file.parsedDoc);
      JSON.parse(fs.readFileSync(path.join(OUT_DIR, file.parsedFile), "utf8"));
    }
    manifest.entries.push({
      api: file.api,
      httpStatus: file.httpStatus,
      movieId: file.movieId,
      businessDate,
      files: [file.rawFile, file.parsedFile].filter(Boolean),
      sha256: [file.rawFile, file.parsedFile]
        .filter(Boolean)
        .map((name) => ({ file: name, sha256: shaByFile[name] })),
      success: file.success,
      missingReason: file.missingReason,
    });
  }

  writeJsonFile(path.join(OUT_DIR, "manifest.json"), manifest);
  JSON.parse(fs.readFileSync(path.join(OUT_DIR, "manifest.json"), "utf8"));

  const allText = fs
    .readdirSync(OUT_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => fs.readFileSync(path.join(OUT_DIR, name), "utf8"))
    .join("\n");
  const credentialIssues = scanForSensitiveCredentials(allText);

  const summary = {
    outDir: OUT_DIR,
    serviceReady: service.ready,
    successApis: manifest.entries.filter((e) => e.success).map((e) => e.api),
    failedApis: manifest.entries.filter((e) => !e.success).map((e) => ({ api: e.api, reason: e.missingReason })),
    credentialIssues,
    files: fs.readdirSync(OUT_DIR).sort(),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!dashboardRaw) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
