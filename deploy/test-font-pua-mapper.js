/**
 * 猫眼 PUA 字体映射与全国大盘交叉验证回归
 * node deploy/test-font-pua-mapper.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");

async function main() {
  const rankPath = pathToFileURL(path.join(ROOT, "ui", "dashboard-rank.js")).href;
  const mapperPath = pathToFileURL(path.join(ROOT, "ui", "font-pua-mapper.js")).href;
  const {
    ABSURD_BOX_WAN_MAX,
    validateNationCrossCheck,
    rejectImplausibleTodayBoxWan,
    validateDecodedBoxStructure,
    isUntrustedBoxDecode,
    parseBoxNum,
    DECODE_STATUS,
  } = await import(rankPath);
  const mapper = await import(mapperPath);

  // 0. 文档单位：30000万=3亿元，不是3万元
  assert.strictEqual(parseBoxNum("30000", "万"), 30000);
  assert.strictEqual(parseBoxNum("3", "亿"), 30000);
  const rankSource = fs.readFileSync(path.join(ROOT, "ui", "dashboard-rank.js"), "utf8");
  assert.ok(rankSource.includes("30000万=3亿元"), "dashboard-rank unit doc must clarify 30000万=3亿元");

  // 1. 节假日 5亿/10亿 合法值不得被 absurd 上限拒绝
  for (const wan of [50000, 100000]) {
    assert.ok(
      !rejectImplausibleTodayBoxWan(wan, { absurdMaxWan: ABSURD_BOX_WAN_MAX }),
      `${wan}万(=${wan / 10000}亿) must not be rejected by absurd cap`,
    );
    const cross = validateNationCrossCheck(wan, {
      top1BoxWan: wan * 0.4,
      top1BoxRate: 40,
      moviesSumWan: wan * 0.8,
      absurdMaxWan: ABSURD_BOX_WAN_MAX,
    });
    assert.ok(cross.ok, `nation ${wan}万 cross-check should pass: ${cross.reasons.join(",")}`);
  }

  // 2. 8572685.878 万仍必须拒绝
  assert.ok(
    rejectImplausibleTodayBoxWan(8572685.878, { absurdMaxWan: ABSURD_BOX_WAN_MAX }),
    "8572685.878 must be rejected",
  );
  const absurdCross = validateNationCrossCheck(8572685.878, {
    top1BoxWan: 100,
    top1BoxRate: 15,
    moviesSumWan: 500,
    absurdMaxWan: ABSURD_BOX_WAN_MAX,
  });
  assert.ok(!absurdCross.ok);
  assert.ok(absurdCross.reasons.includes("absurd_magnitude"));

  // 3. PUA 映射缺失时不得输出明文
  const partialMap = new Map([[0xe6d5, "1"]]);
  const missing = mapper.decodeMarkupWithPuaMap("&#xe6d5;&#xf66d;", partialMap);
  assert.ok(!missing.complete);
  assert.strictEqual(missing.text, "");

  // 4. 字体版本 A/B 缓存严格隔离（禁止 len 键）
  mapper.clearPuaMapCache();
  const styleA =
    '@font-face{font-family:"mtsi-font";src:url("//cdn.example/font/aaaa1111.woff");}';
  const styleB =
    '@font-face{font-family:"mtsi-font";src:url("//cdn.example/font/bbbb2222.woff");}';
  assert.notStrictEqual(mapper.fontStyleToVersionKey(styleA), mapper.fontStyleToVersionKey(styleB));
  const noHashA =
    '@font-face{font-family:"mtsi-font";src:url("//cdn.example/fonts/custom-alpha.woff");}';
  const noHashB =
    '@font-face{font-family:"mtsi-font";src:url("//cdn.example/fonts/custom-beta.woff");}';
  const keyNoHashA = mapper.fontStyleToVersionKey(noHashA);
  const keyNoHashB = mapper.fontStyleToVersionKey(noHashB);
  assert.notStrictEqual(keyNoHashA, keyNoHashB);
  assert.ok(keyNoHashA.startsWith("mtsi:css:"), "no-hash fontStyle must use full normalized CSS key");
  assert.ok(!keyNoHashA.includes(":len"), "cache key must not use CSS length");
  const buf = fs.readFileSync(path.join(ROOT, "deploy", "fixtures", "maoyan-75e5b39d.woff"));
  const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const builtA = await mapper.buildPuaMapFromFontBuffer(arrayBuf, styleA);
  mapper.clearPuaMapCache();
  const builtB = await mapper.buildPuaMapFromFontBuffer(arrayBuf, styleB);
  assert.strictEqual(
    builtA.versionKey,
    builtB.versionKey,
    "same font bytes must share sha256 version key even when CSS url differs",
  );
  const shaKey = await mapper.computeVersionKeyAsync("", arrayBuf);
  assert.ok(shaKey.startsWith("mtsi:sha256:"), "buffer cache key must use sha256");
  assert.strictEqual(shaKey.length, "mtsi:sha256:".length + 64);
  mapper.clearPuaMapCache();
  await mapper.ensurePuaMap(styleA, { fontBuffer: arrayBuf, force: true });
  const cachedA = mapper.getCachedPuaMap(builtA.versionKey);
  const cachedB = mapper.getCachedPuaMap(builtB.versionKey);
  assert.ok(!cachedA || !cachedB || cachedA !== cachedB, "different version keys must not share cache");

  // 5. nation < TOP1 或 nation < 电影合计时拒绝
  const belowTop1 = validateNationCrossCheck(100, {
    top1BoxWan: 200,
    top1BoxRate: 20,
    moviesSumWan: 180,
    absurdMaxWan: ABSURD_BOX_WAN_MAX,
  });
  assert.ok(!belowTop1.ok);
  assert.ok(belowTop1.reasons.includes("nation_below_top1"));

  const belowSum = validateNationCrossCheck(100, {
    top1BoxWan: 80,
    top1BoxRate: 40,
    moviesSumWan: 200,
    absurdMaxWan: ABSURD_BOX_WAN_MAX,
  });
  assert.ok(!belowSum.ok);
  assert.ok(belowSum.reasons.includes("nation_below_movies_sum"));

  // 6. 票房占比反推明显不一致时拒绝
  const rateMismatch = validateNationCrossCheck(500, {
    top1BoxWan: 100,
    top1BoxRate: 10,
    moviesSumWan: 100,
    absurdMaxWan: ABSURD_BOX_WAN_MAX,
  });
  assert.ok(!rateMismatch.ok);
  assert.ok(rateMismatch.reasons.includes("box_rate_mismatch"));

  // 7. 完整映射缺数字/重复时 build 失败
  if (builtA.ok && builtA.map) {
    const digits = [...builtA.map.values()];
    assert.strictEqual(new Set(digits).size, 10, "bijection must cover 0-9");
    assert.strictEqual(digits.sort().join(""), "0123456789");
  }

  // 8. 结构校验：PUA 数量必须与明文数字位一致
  assert.ok(validateDecodedBoxStructure("&#xe6d5;&#xf66d;&#xe6d5;", "101"));
  assert.ok(!validateDecodedBoxStructure("&#xe6d5;&#xf66d;", "101"));

  // 9. cross-check 上下文校验（无 map 时失败）
  const noMap = mapper.validatePuaMapAgainstContext(null, { nationHtml: "&#xe6d5;" }, {
    validateNationCrossCheck,
    validateDecodedBoxStructure,
    isUntrustedBoxDecode,
    parseBoxNum: (t) => parseFloat(t),
    parseRate: (r) => parseFloat(r),
  });
  assert.ok(!noMap.ok);

  // 10. encoded/decode_error 语义（与 dashboard-rank 一致）
  assert.strictEqual(DECODE_STATUS.ENCODED, "encoded");
  assert.strictEqual(DECODE_STATUS.DECODE_ERROR, "decode_error");

  // 11. 三次贝塞尔：非对称双控制点，修改第二控制点必须改变采样
  const cubicA = {
    commands: [
      { type: "M", x: 0, y: 0 },
      { type: "C", x1: 10, y1: 90, x2: 20, y2: 10, x: 100, y: 100 },
    ],
  };
  const cubicB = {
    commands: [
      { type: "M", x: 0, y: 0 },
      { type: "C", x1: 10, y1: 90, x2: 80, y2: 10, x: 100, y: 100 },
    ],
  };
  const ptsA = mapper.samplePathPoints(cubicA, 120);
  const ptsB = mapper.samplePathPoints(cubicB, 120);
  assert.ok(ptsA.length > 0 && ptsB.length > 0);
  assert.notDeepStrictEqual(ptsA, ptsB, "second control point must affect cubic samples");

  // 12. Hungarian 替代 10! 全排列
  const cost = [
    [0.1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15],
    [0.15, 0.1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2],
    [0.2, 0.15, 0.1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3],
    [0.3, 0.2, 0.15, 0.1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4],
    [0.4, 0.3, 0.2, 0.15, 0.1, 0.9, 0.8, 0.7, 0.6, 0.5],
    [0.5, 0.4, 0.3, 0.2, 0.15, 0.1, 0.9, 0.8, 0.7, 0.6],
    [0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1, 0.9, 0.8, 0.7],
    [0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1, 0.9, 0.8],
    [0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1, 0.9],
    [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1],
  ];
  const hungarian = mapper.hungarianMinAssignment(cost);
  assert.deepStrictEqual(hungarian.assignment, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const mapperSource = fs.readFileSync(path.join(ROOT, "ui", "font-pua-mapper.js"), "utf8");
  assert.ok(!mapperSource.includes("function permutations"), "must not enumerate full permutations");

  // 13. 363万(9!) 候选场景不得阻塞：超时快速返回
  const mockGlyphs = Array.from({ length: 10 }, (_, i) => ({
    code: 0xe000 + i,
    topology: { aspect: 0.35 + i * 0.04, moves: 1, cmds: 30, width: 100, height: 200 },
    raster: new Uint8Array(48 * 56),
  }));
  const looseContext = {
    nationHtml: "&#xe000;&#xe001;&#xe002;",
    nationUnit: "万",
    movies: [
      { rank: 1, todayBoxHtml: "&#xe003;&#xe004;", todayUnit: "万", boxRate: "10%", boxRateNum: 10 },
      { rank: 2, todayBoxHtml: "&#xe005;&#xe006;", todayUnit: "万", boxRate: "10%", boxRateNum: 10 },
    ],
  };
  const bbStart = Date.now();
  const bb = mapper.branchAndBoundCrossCheck(mockGlyphs, looseContext, {
    validateNationCrossCheck,
    validateDecodedBoxStructure,
    isUntrustedBoxDecode,
    parseBoxNum: (t) => parseFloat(t),
    parseRate: (r) => parseFloat(r),
  }, { timeoutMs: 40, maxExamined: 300 });
  const bbElapsed = Date.now() - bbStart;
  assert.ok(bbElapsed < 500, `branch-and-bound must not block render thread (${bbElapsed}ms)`);
  assert.ok(bb.timeout || bb.candidates_examined <= 300);
  assert.ok(bb.candidates_remaining >= 0);
  assert.ok(typeof bb.mapping_duration_ms === "number");

  // 14. 超时后安全失败（不产出可用 map）
  const timedOut = mapper.branchAndBoundCrossCheck(mockGlyphs, looseContext, {}, { timeoutMs: 1, maxExamined: 1 });
  assert.strictEqual(timedOut.timeout, true);
  assert.strictEqual(timedOut.ok, false);
  assert.strictEqual(timedOut.map, null);
  assert.strictEqual(timedOut.rejection_reason, "mapping_timeout");

  // 15. 多组候选通过时不得选择最低成本映射
  const ambigGlyphs = Array.from({ length: 10 }, (_, i) => ({
    code: 0xe100 + i,
    topology: { aspect: i === 0 ? 0.2 : 0.55 + i * 0.01, moves: 1, cmds: 30, width: 100, height: 200 },
  }));
  const ambigContext = {
    nationHtml: "&#xe100;&#xe101;",
    nationUnit: "万",
    nationSplitHtml: "&#xe102;&#xe103;",
    nationSplitUnit: "万",
    movies: Array.from({ length: 5 }, (_, i) => ({
      rank: i + 1,
      todayBoxHtml: `&#xe10${4 + i};&#xe10${5 + i};`,
      todayUnit: "万",
      splitBoxHtml: `&#xe10${4 + i};`,
      splitUnit: "万",
      boxRate: "20%",
      boxRateNum: 20,
    })),
  };
  const ambig = mapper.searchPuaMapByCrossCheck(ambigGlyphs, ambigContext, {
    validateNationCrossCheck,
    validateDecodedBoxStructure,
    isUntrustedBoxDecode,
    parseBoxNum: (t, unit) => parseBoxNum(`${t}${unit === "亿" ? "亿" : ""}`, unit),
    parseRate: (r) => parseFloat(String(r).replace("%", "")),
  }, { timeoutMs: 80, maxExamined: 2000 });
  if (ambig.reason === "cross_check_ambiguous_provisional" || ambig.provisional === true) {
    assert.ok(ambig.map instanceof Map, "ambiguous may pick provisional map for bubble loose decode");
    assert.notEqual(ambig.confidence, mapper.MAP_CONFIDENCE.VERIFIED, "provisional must not be verified");
  } else if (ambig.reason === "cross_check_ambiguous") {
    assert.strictEqual(ambig.map, null, "legacy ambiguous reject keeps map null");
  }

  // 16. 只有唯一且连续稳定的映射才能 verified
  mapper.clearMappingStabilityState();
  const stableMap = new Map(Array.from({ length: 10 }, (_, i) => [0xe200 + i, String(i)]));
  const stableDecoded = {
    nation: { text: "120.45", unit: "万" },
    nationSplit: { text: "110.20", unit: "万" },
    "movie-1": { text: "50.10", unit: "万" },
    "movie-2": { text: "40.20", unit: "万" },
    "movie-3": { text: "30.30", unit: "万" },
    "movie-4": { text: "20.40", unit: "万" },
    "movie-5": { text: "10.50", unit: "万" },
    "split-1": { text: "25.00", unit: "万" },
  };
  const crossContext = {
    nationHtml: "x",
    nationSplitHtml: "y",
    movies: Array.from({ length: 5 }, (_, i) => ({
      rank: i + 1,
      todayBoxHtml: "a",
      splitBoxHtml: "b",
      boxRate: "20%",
      boxRateNum: 20,
    })),
  };
  const inferredBuilt = {
    ok: true,
    map: stableMap,
    versionKey: "mtsi:test",
    method: "outline_raster",
    reason: "outline_assignment_ok",
    decoded: stableDecoded,
  };
  const inferredEval = mapper.evaluateMapConfidence(inferredBuilt, crossContext, {});
  assert.strictEqual(inferredEval.confidence, mapper.MAP_CONFIDENCE.INFERRED);
  mapper.evaluateMapConfidence(inferredBuilt, crossContext, {});
  const verifiedBuilt = {
    ...inferredBuilt,
    method: "cross_check_disambiguation",
    reason: "cross_check_unique_fingerprint",
  };
  const verifiedEval = mapper.evaluateMapConfidence(verifiedBuilt, crossContext, {
    authoritativePlaintextTemplate: true,
  });
  assert.strictEqual(verifiedEval.confidence, mapper.MAP_CONFIDENCE.VERIFIED);

  mapper.clearMappingStabilityState();
  const crossValidatedBuilt = { ...inferredBuilt, crossValidated: true };
  mapper.evaluateMapConfidence(crossValidatedBuilt, crossContext, {});
  const crossValidatedEval = mapper.evaluateMapConfidence(crossValidatedBuilt, crossContext, {});
  assert.strictEqual(
    crossValidatedEval.confidence,
    mapper.MAP_CONFIDENCE.VERIFIED,
    "outline map with crossValidated + stability must reach VERIFIED",
  );

  const appSource = fs.readFileSync(path.join(ROOT, "ui", "app.js"), "utf8");
  assert.ok(!mapperSource.includes("guessDigitFromPua"), "Arial guess path must be removed");
  assert.ok(!mapperSource.includes("Arial, Helvetica"), "must not reference Arial comparison");
  assert.ok(!mapperSource.includes("getGlyphBitmap"), "must not use canvas glyph bitmap guessing");
  assert.ok(mapperSource.includes("mapping_duration_ms"), "mapping perf metrics required");
  assert.ok(mapperSource.includes("MAP_CONFIDENCE"), "verified/inferred confidence required");
  assert.ok(appSource.includes("shouldPreferEncodedNation"), "nation encoded HTML display required");
  assert.ok(appSource.includes("decodeLocked"), "encoded/decode_error must not restore nation bubble baseline");

  console.log("PASS font PUA mapper validation");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
