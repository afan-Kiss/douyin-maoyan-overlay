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
  const {
    parseDashboard,
    resolveChampionBoxWan,
    resolveNationSeatMetric,
    computeMovieBoxDeltaWan,
  } = await import(apiPath);
  const { formatWanDisplayText } = await import(boxPath);

  const raw = mockDashboardRaw();
  const parsed = parseDashboard(raw, 5);

  assert.strictEqual(parsed.nation.todayBox, 4198.2, "今日大盘应来自 nationBoxSplitUnit");
  assert.strictEqual(parsed.nation.showCountDesc, "37.3万");
  assert.strictEqual(parsed.nation.viewCountDesc, "104.2万");
  assert.strictEqual(resolveChampionBoxWan(parsed.movies[0]), 1028.9);
  assert.strictEqual(
    resolveChampionBoxWan(parsed.movies[0]),
    parsed.movies[0].todayBox,
    "冠军票房 === TOP1 todayBox",
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
  assert.strictEqual(movieA.rank, 2);
  assert.strictEqual(movieB.rank, 1);
  assert.strictEqual(movieA.sumBoxDesc, "12亿");
  assert.strictEqual(movieB.sumBoxDesc, "11亿");
  assert.strictEqual(movieA.todayBox, 700);
  assert.strictEqual(movieB.todayBox, 710);

  const delta = computeMovieBoxDeltaWan(700, 710);
  assert.ok(Math.abs(delta - 10) < 0.01, `涨幅应按 movieId: ${delta}`);

  const wrongRankDelta = computeMovieBoxDeltaWan(1000, 710);
  assert.strictEqual(wrongRankDelta, 0, "不得拿上一轮第1名票房比较");

  const nationDelta = computeMovieBoxDeltaWan(4100, 4198.2);
  assert.ok(Math.abs(nationDelta - 98.2) < 0.01, "全国大盘涨幅 nation 对 nation");

  assert.strictEqual(formatWanDisplayText(12300), "1.23亿");
  assert.strictEqual(formatWanDisplayText(3525.5), "3525.5万");

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
  console.log("  movieId delta +10万 on rank promotion");
  console.log("\nALL PASSED (data consistency)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
