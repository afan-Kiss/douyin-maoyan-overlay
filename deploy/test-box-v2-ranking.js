/**
 * V2 排名必须与 dashboard-rank.js 一致，禁止按 realtime 二次排序
 * node deploy/test-box-v2-ranking.js
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");

async function main() {
  const rankUrl = pathToFileURL(path.join(ROOT, "ui", "dashboard-rank.js")).href;
  const pipeUrl = pathToFileURL(path.join(ROOT, "ui", "box-pipeline.js")).href;
  const storeUrl = pathToFileURL(path.join(ROOT, "ui", "box-store.js")).href;
  const riseUrl = pathToFileURL(path.join(ROOT, "ui", "rise-engine.js")).href;

  const [
    { pickOfficialDashboardMovies, sortDashboardMovies },
    { simulateBoxRounds, rerankCandidateByTrustedBox, makeDecodeResult, validateInferredMovieBox },
    { createBoxStore },
    { createRiseEngine },
  ] = await Promise.all([
    import(rankUrl),
    import(pipeUrl),
    import(storeUrl),
    import(riseUrl),
  ]);

  // 截图场景（API 当日 TOP5 原始顺序，realtime 高但累计低）
  const apiTop5 = [
    {
      movieId: "A",
      name: "空枪",
      todayBox: 760,
      sumBoxNum: 8452.6,
      sumBoxDesc: "8452.6万",
      boxRate: "20.9%",
      originalRank: 1,
      _apiIndex: 0,
    },
    {
      movieId: "B",
      name: "欢迎来龙餐馆",
      todayBox: 550,
      sumBoxNum: 31600,
      sumBoxDesc: "3.16亿",
      boxRate: "25%",
      originalRank: 2,
      _apiIndex: 1,
    },
    {
      movieId: "C",
      name: "奥德赛",
      todayBox: 265,
      sumBoxNum: 10200,
      sumBoxDesc: "1.02亿",
      boxRate: "12%",
      originalRank: 3,
      _apiIndex: 2,
    },
    {
      movieId: "D",
      name: "八仙",
      todayBox: 226,
      sumBoxNum: 28000,
      sumBoxDesc: "2.80亿",
      boxRate: "10%",
      originalRank: 4,
      _apiIndex: 3,
    },
    {
      movieId: "E",
      name: "功夫女足",
      todayBox: 151,
      sumBoxNum: 33900,
      sumBoxDesc: "3.39亿",
      boxRate: "7%",
      originalRank: 5,
      _apiIndex: 4,
    },
  ];

  const ranked = pickOfficialDashboardMovies(apiTop5, 5);
  // 累计总票房降序：E(3.39亿) > B(3.16亿) > D(2.80亿) > C(1.02亿) > A(0.84亿)
  assert.deepStrictEqual(
    ranked.map((m) => m.movieId),
    ["E", "B", "D", "C", "A"],
    "dashboard-rank order by sumBox",
  );
  assert.strictEqual(ranked[0].rank, 1);
  assert.strictEqual(ranked[0].movieId, "E");

  const store = createBoxStore({ riseEngine: createRiseEngine() });
  const v2Input = ranked.map((m) => ({
    movieId: m.movieId,
    name: m.name,
    rank: m.rank,
    originalRank: m.originalRank,
    box: m.todayBox,
    boxRate: m.boxRate,
    sumBoxNum: m.sumBoxNum,
    sumBoxDesc: m.sumBoxDesc,
    reason: "verified",
  }));

  const beforeRanks = v2Input.map((m) => `${m.movieId}:${m.rank}`);
  const results = simulateBoxRounds(
    [
      {
        businessDate: "2026-09-15",
        fontKey: "fontA",
        movies: v2Input,
        nation: { box: 2197, reason: "verified" },
      },
    ],
    store,
  );

  assert.strictEqual(results[0].committed.ok, true, "v2 publish");
  const after = store.getSnapshot().movies;
  assert.deepStrictEqual(
    after.map((m) => m.movieId),
    ["E", "B", "D", "C", "A"],
    "store order matches dashboard-rank",
  );
  assert.deepStrictEqual(
    after.map((m) => `${m.movieId}:${m.rank}`),
    beforeRanks,
    "store commit must not reorder by fresh box",
  );
  assert.strictEqual(store.getChampion().movieId, "E", "champion is rank1 by sumBox");

  // rerankCandidateByTrustedBox 必须是空操作
  const candidate = {
    movies: [
      {
        movieId: "A",
        rank: 5,
        box: makeDecodeResult({ ok: true, valueWan: 760, reason: "verified" }),
      },
      {
        movieId: "E",
        rank: 1,
        box: makeDecodeResult({ ok: true, valueWan: 151, reason: "verified" }),
      },
    ],
  };
  const reranked = rerankCandidateByTrustedBox(candidate);
  assert.strictEqual(reranked.movies[0].movieId, "A");
  assert.strictEqual(reranked.movies[0].rank, 5);
  assert.strictEqual(reranked.movies[1].rank, 1);

  // 截图专项：760.05 必须 reject；460.05 必须 accept
  const bad = validateInferredMovieBox({
    movieWan: 760.05,
    nationWan: 2197,
    boxRate: 20.9,
    sumBoxNum: 8452.6,
  });
  assert.strictEqual(bad.ok, false, "760.05 reject");
  assert.strictEqual(bad.reason, "inferred_box_rate_mismatch");

  const good = validateInferredMovieBox({
    movieWan: 460.05,
    nationWan: 2197,
    boxRate: 20.9,
    sumBoxNum: 8452.6,
  });
  assert.strictEqual(good.ok, true, "460.05 accept");

  // 错误 inferred 不得污染 store / 产生 bubble
  const store2 = createBoxStore({ riseEngine: createRiseEngine() });
  simulateBoxRounds(
    [
      {
        businessDate: "2026-09-15",
        movies: [
          {
            movieId: "A",
            name: "空枪",
            rank: 5,
            box: 460.05,
            boxRate: "20.9%",
            sumBoxNum: 8452.6,
            reason: "inferred",
          },
        ],
        nation: { box: 2197, reason: "verified" },
      },
    ],
    store2,
  );
  assert.ok(Math.abs(store2.getMovie("A").displayBoxWan - 460.05) < 1e-6);

  const rises = [];
  const eng = createRiseEngine({ onRise: (e) => rises.push(e) });
  const store3 = createBoxStore({ riseEngine: eng });
  // 先写入可信值
  store3.commit({
    businessDate: "2026-09-15",
    movies: [
      {
        movieId: "A",
        name: "空枪",
        rank: 5,
        box: makeDecodeResult({ ok: true, valueWan: 460.05, reason: "verified" }),
        boxRate: "20.9%",
        sumBoxNum: 8452.6,
      },
    ],
    nation: {
      box: makeDecodeResult({ ok: true, valueWan: 2197, reason: "verified" }),
    },
  });
  rises.length = 0;
  const badRound = simulateBoxRounds(
    [
      {
        businessDate: "2026-09-15",
        movies: [
          {
            movieId: "A",
            name: "空枪",
            rank: 5,
            box: 760.05,
            boxRate: "20.9%",
            sumBoxNum: 8452.6,
            reason: "inferred",
          },
        ],
        nation: { box: 2197, reason: "verified" },
      },
    ],
    store3,
  );
  assert.strictEqual(badRound[0].committed.ok, false);
  assert.strictEqual(badRound[0].committed.reason, "inferred_crosscheck_failed");
  assert.ok(Math.abs(store3.getMovie("A").displayBoxWan - 460.05) < 1e-6, "keep 460.05");
  assert.ok(Math.abs(store3.getMovie("A").lastValidBoxWan - 460.05) < 1e-6);
  assert.strictEqual(rises.length, 0, "no +300 bubble");

  // sortDashboardMovies 与 pickOfficial 一致（同输入）
  const sorted = sortDashboardMovies(apiTop5);
  assert.deepStrictEqual(
    sorted.map((m) => m.movieId),
    ranked.map((m) => m.movieId),
  );

  console.log("test-box-v2-ranking: OK");
  console.log("  rank source = dashboard-rank (sumBox within API TOP5)");
  console.log("  no realtime rerank in V2");
  console.log("  760.05 rejected / 460.05 accepted");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
