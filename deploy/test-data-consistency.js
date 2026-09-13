/**
 * 票房数据一致性回归
 * node deploy/test-data-consistency.js
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");

function makeMovie(rank, movieId, todayBoxText, extra = {}) {
  return {
    movieInfo: { movieId, movieName: `电影${rank}` },
    boxSplitUnit: { num: todayBoxText, unit: "万" },
    boxRate: `${20 - rank}%`,
    showCountRate: `${15 - rank}%`,
    avgSeatView: `${2 + rank * 0.1}%`,
    sumBoxDesc: `${10 + rank}亿`,
    showCount: 1000 * rank,
    ...extra,
  };
}

function mockDashboardRaw(overrides = {}) {
  return {
    calendar: { today: "2026-09-13" },
    movieList: {
      nationBoxInfo: {
        nationBoxSplitUnit: { num: "4198.2", unit: "万" },
        showCountDesc: "37.3万",
        viewCountDesc: "104.2万",
        avgShowView: "3.2",
        ...overrides.nation,
      },
      list: overrides.list || [
        makeMovie(1, 101, "1028.9"),
        makeMovie(2, 202, "717.92"),
        makeMovie(3, 303, "587.29"),
        makeMovie(4, 404, "588.24"),
        makeMovie(5, 505, "228.22"),
      ],
      updateInfo: { updateTimestamp: Date.now(), updateGapSecond: 5 },
    },
    ...overrides.root,
  };
}

async function main() {
  const apiPath = pathToFileURL(path.join(ROOT, "ui", "maoyan-api.js")).href;
  const boxPath = pathToFileURL(path.join(ROOT, "ui", "box-display.js")).href;
  const rankPath = pathToFileURL(path.join(ROOT, "ui", "dashboard-rank.js")).href;
  const {
    parseDashboard,
    resolveChampionBoxWan,
    resolveNationSeatMetric,
    computeMovieBoxDeltaWan,
    isUntrustedBoxDecode,
  } = await import(apiPath);
  const { DECODE_STATUS, sortDashboardMovies, rerankMoviesByTodayBox } = await import(rankPath);
  const { formatWanDisplayText } = await import(boxPath);

  const raw = mockDashboardRaw();
  const parsed = parseDashboard(raw, 5);

  assert.strictEqual(parsed.nation.todayBox, 4198.2, "今日大盘应来自 nationBoxSplitUnit");
  assert.strictEqual(parsed.nation.showCountDesc, "37.3万");
  assert.strictEqual(parsed.nation.viewCountDesc, "104.2万");
  // 累计总票房最高者排 NO.1（mock 里 sumBoxDesc=15亿 的电影5）
  assert.strictEqual(parsed.movies[0].movieId, 505);
  assert.strictEqual(parsed.movies[0].sumBoxDesc, "15亿");
  assert.strictEqual(
    resolveChampionBoxWan(parsed.movies[0]),
    parsed.movies[0].todayBox,
    "冠军票房 === TOP1 todayBox（展示仍用实时）",
  );

  const moviesSum = parsed.movies.reduce((sum, m) => sum + m.todayBox, 0);
  assert.notStrictEqual(parsed.nation.todayBox, moviesSum, "今日大盘不得为 TOP5 求和");

  const seat = resolveNationSeatMetric(raw.movieList.nationBoxInfo);
  assert.strictEqual(seat.label, "场均人次");
  assert.strictEqual(seat.value, "3.2");
  assert.strictEqual(parsed.nation.seatLabel, "场均人次");
  assert.strictEqual(parsed.nation.seatValue, "3.2");

  const seatRateRaw = mockDashboardRaw({
    nation: { viewSeatRate: "4.5%", avgShowView: "" },
  });
  const seatRateParsed = parseDashboard(seatRateRaw, 5);
  assert.strictEqual(seatRateParsed.nation.seatLabel, "上座率");
  assert.strictEqual(seatRateParsed.nation.seatValue, "4.5%");

  const rankSwapRaw = mockDashboardRaw({
    list: [makeMovie(1, 202, "710"), makeMovie(2, 101, "700")],
  });
  const rankSwap = parseDashboard(rankSwapRaw, 5);
  const movieA = rankSwap.movies.find((m) => m.movieId === 101);
  const movieB = rankSwap.movies.find((m) => m.movieId === 202);
  // makeMovie(rank) → sumBoxDesc = (10+rank)亿：101→12亿，202→11亿 → 累计高者在前
  assert.strictEqual(movieA.rank, 1);
  assert.strictEqual(movieB.rank, 2);
  assert.strictEqual(movieA.sumBoxDesc, "12亿");
  assert.strictEqual(movieB.sumBoxDesc, "11亿");
  assert.strictEqual(movieA.todayBox, 700);
  assert.strictEqual(movieB.todayBox, 710);

  const cumulativeRankRaw = mockDashboardRaw({
    list: [
      makeMovie(1, 101, "100", { sumBoxDesc: "21.66亿" }),
      makeMovie(2, 202, "500", { sumBoxDesc: "7.01亿" }),
    ],
  });
  const cumulativeRank = parseDashboard(cumulativeRankRaw, 5);
  assert.strictEqual(cumulativeRank.movies[0].decodeStatus, DECODE_STATUS.OK);
  assert.strictEqual(cumulativeRank.movies[0].originalRank, 1);
  assert.strictEqual(cumulativeRank.movies[0].movieId, 101, "累计总票房高者排第1");
  assert.strictEqual(cumulativeRank.movies[0].todayBox, 100);
  assert.strictEqual(cumulativeRank.movies[0].sumBoxDesc, "21.66亿");
  assert.strictEqual(cumulativeRank.movies[1].movieId, 202);
  assert.strictEqual(cumulativeRank.movies[1].sumBoxDesc, "7.01亿");

  const tieRateRaw = mockDashboardRaw({
    list: [
      makeMovie(1, 101, "100", { boxRate: "10%", sumBoxDesc: "10亿" }),
      makeMovie(2, 202, "500", { boxRate: "25%", sumBoxDesc: "10亿" }),
    ],
  });
  const tieRate = parseDashboard(tieRateRaw, 5);
  assert.strictEqual(tieRate.movies[0].movieId, 202, "累计相同按实时票房排前");
  assert.strictEqual(tieRate.movies[0].todayBox, 500);

  const allEncodedRaw = mockDashboardRaw({
    list: [
      makeMovie(1, 101, "\uE6D5", { boxRate: "5%", sumBoxDesc: "20亿" }),
      makeMovie(2, 202, "\uE6D6", { boxRate: "50%", sumBoxDesc: "5亿" }),
    ],
  });
  const allEncoded = parseDashboard(allEncodedRaw, 5);
  assert.strictEqual(allEncoded.movies[0].movieId, 101, "累计总票房仍可排名（不依赖实时解码）");
  assert.strictEqual(allEncoded.movies[0].decodeStatus, DECODE_STATUS.ENCODED);
  assert.strictEqual(allEncoded.movies[0].sumBoxDesc, "20亿");
  assert.strictEqual(allEncoded.movies[1].originalRank, 2);

  const afterDecode = rerankMoviesByTodayBox([
    {
      originalRank: 1,
      movieId: 101,
      name: "累计高",
      todayBox: 100,
      boxRate: "10%",
      boxRateNum: 10,
      sumBoxDesc: "21亿",
      decodeStatus: DECODE_STATUS.OK,
    },
    {
      originalRank: 2,
      movieId: 202,
      name: "实时高",
      todayBox: 500,
      boxRate: "30%",
      boxRateNum: 30,
      sumBoxDesc: "7亿",
      decodeStatus: DECODE_STATUS.OK,
    },
  ]);
  assert.strictEqual(afterDecode[0].movieId, 101, "累计高排第1");
  assert.strictEqual(afterDecode[0].rank, 1);
  assert.strictEqual(afterDecode[1].movieId, 202);
  assert.strictEqual(afterDecode[1].rank, 2);

  const partialFail = sortDashboardMovies([
    {
      _apiIndex: 0,
      originalRank: 1,
      movieId: 1,
      todayBox: 0,
      sumBoxDesc: "5亿",
      boxRateNum: 99,
      decodeStatus: DECODE_STATUS.ENCODED,
    },
    {
      _apiIndex: 1,
      originalRank: 2,
      movieId: 2,
      todayBox: 300,
      sumBoxDesc: "20亿",
      boxRateNum: 1,
      decodeStatus: DECODE_STATUS.OK,
    },
  ]);
  assert.strictEqual(partialFail[0].movieId, 2, "按累计总票房排序");

  // 猫眼官方：当日榜 TOP5 内按累计重排 → 欢迎来龙进前排，阿嬷/蜘蛛侠不进榜
  const officialRaw = mockDashboardRaw({
    list: [
      makeMovie(1, 101, "181", { sumBoxDesc: "23.35亿" }), // 功夫女足 今日1
      makeMovie(2, 202, "122", { sumBoxDesc: "19.28亿" }), // 八仙 今日2
      makeMovie(3, 303, "80", { sumBoxDesc: "7.01亿" }), // 奥德赛 今日3
      makeMovie(4, 404, "41", { sumBoxDesc: "21.66亿" }), // 欢迎来龙 今日4
      makeMovie(5, 505, "26", { sumBoxDesc: "5.72亿" }), // 空枪 今日5
      makeMovie(6, 606, "1", { sumBoxDesc: "20.04亿" }), // 给阿嬷的情书 今日榜外
      makeMovie(7, 707, "12", { sumBoxDesc: "15.72亿" }), // 蜘蛛侠 今日榜外
    ],
  });
  const official = parseDashboard(officialRaw, 5);
  assert.deepStrictEqual(
    official.movies.map((m) => m.movieId),
    [101, 404, 202, 303, 505],
    "官方顺序：功夫女足→来龙餐馆→八仙→奥德赛→空枪",
  );
  assert.ok(!official.movies.some((m) => m.movieId === 606 || m.movieId === 707));

  const delta = computeMovieBoxDeltaWan(700, 710);
  assert.ok(Math.abs(delta - 10) < 0.01, `涨幅应按 movieId: ${delta}`);

  const wrongRankDelta = computeMovieBoxDeltaWan(1000, 710);
  assert.strictEqual(wrongRankDelta, 0, "不得拿上一轮第1名票房比较");

  const nationDelta = computeMovieBoxDeltaWan(4100, 4198.2);
  assert.ok(Math.abs(nationDelta - 98.2) < 0.01, "全国大盘涨幅 nation 对 nation");

  assert.strictEqual(formatWanDisplayText(12300), "1.23亿");
  assert.strictEqual(formatWanDisplayText(3525.5), "3525.5万");

  assert.strictEqual(isUntrustedBoxDecode("1111.1"), true);
  assert.strictEqual(isUntrustedBoxDecode("111.11"), true);
  assert.strictEqual(isUntrustedBoxDecode("1028.9"), false);
  assert.strictEqual(isUntrustedBoxDecode("1100.1"), false);

  const computedSeat = resolveNationSeatMetric({
    viewCountDesc: "104.2万",
    showCountDesc: "37.3万",
  });
  assert.strictEqual(computedSeat.label, "场均人次");
  assert.strictEqual(computedSeat.value, "2.8");

  const missingSeat = resolveNationSeatMetric({
    viewCountDesc: "--",
    showCountDesc: "--",
  });
  assert.strictEqual(missingSeat.value, "--");

  const missingForecastRaw = mockDashboardRaw({
    list: [makeMovie(1, 101, "100", { sumBoxDesc: "" })],
  });
  const missingForecast = parseDashboard(missingForecastRaw, 1);
  assert.strictEqual(missingForecast.movies[0].sumBoxDesc, "--");

  console.log("PASS data consistency");
  console.log("  champion === TOP1 todayBox");
  console.log("  nation todayBox from nationBoxSplitUnit");
  console.log("  nation views from viewCountDesc");
  console.log("  movieId rank swap preserves sumBoxDesc");
  console.log("  totalBox(sumBoxDesc) drives live rank");
  console.log("  today-topN then cumulative reorder (maoyan official)");
  console.log("  tie totalBox uses todayBox secondary sort");
  console.log("  encoded todayBox still ranks by sumBoxDesc");
  console.log("  movieId delta +10万 on rank promotion");
  console.log("\nALL PASSED (data consistency)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
