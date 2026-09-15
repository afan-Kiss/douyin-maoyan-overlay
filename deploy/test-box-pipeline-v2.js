/**
 * Box Pipeline V2 单元测试
 * 运行: node deploy/test-box-pipeline-v2.js
 */
const path = require("path");
const { pathToFileURL } = require("url");

async function loadModules() {
  const root = path.join(__dirname, "..", "ui");
  const storeUrl = pathToFileURL(path.join(root, "box-store.js")).href;
  const riseUrl = pathToFileURL(path.join(root, "rise-engine.js")).href;
  const pipeUrl = pathToFileURL(path.join(root, "box-pipeline.js")).href;
  const [{ createBoxStore }, { createRiseEngine, formatRiseTextWithArrow }, pipe] = await Promise.all([
    import(storeUrl),
    import(riseUrl),
    import(pipeUrl),
  ]);
  return { createBoxStore, createRiseEngine, formatRiseTextWithArrow, ...pipe };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function nearly(a, b) {
  return Math.abs(Number(a) - Number(b)) < 1e-6;
}

function fiveMovies(boxes, opts = {}) {
  return boxes.map((box, i) => ({
    movieId: String(opts.ids?.[i] || i + 1),
    name: opts.names?.[i] || `M${i + 1}`,
    rank: i + 1,
    ...(box === null || box === undefined || opts.decodeFail?.[i]
      ? { decodeFail: true, reason: opts.reasons?.[i] || "decode_fail" }
      : { box }),
  }));
}

async function main() {
  const {
    createBoxStore,
    createRiseEngine,
    formatRiseTextWithArrow,
    makeDecodeResult,
    simulateBoxRounds,
    createBoxPipeline,
    tryPlainBoxDecode,
    resolveEntityBoxDecode,
    validateCandidate,
    BOX_POLL_MS,
  } = await loadModules();

  let passed = 0;
  const rises = [];
  const engine = createRiseEngine({
    onRise: (e) => rises.push(e),
  });
  const store = createBoxStore({ riseEngine: engine });

  function snapBox(id = "1") {
    return store.getMovie(id)?.displayBoxWan || 0;
  }

  // 1. 第一次 100 → 显示100 → 无 bubble
  rises.length = 0;
  let r = simulateBoxRounds(
    [{ businessDate: "2026-09-15", fontKey: "A", movies: [{ movieId: "1", name: "M1", rank: 1, box: 100 }] }],
    store,
  );
  assert(nearly(snapBox(), 100), "t1 display 100");
  assert(r[0].rises.length === 0, "t1 no bubble");
  passed += 1;

  // 2. 下一轮 100 → 无 bubble
  r = simulateBoxRounds(
    [{ businessDate: "2026-09-15", fontKey: "A", movies: [{ movieId: "1", name: "M1", rank: 1, box: 100 }] }],
    store,
  );
  assert(nearly(snapBox(), 100), "t2 still 100");
  assert(r[0].rises.length === 0, "t2 no bubble");
  passed += 1;

  // 3. 下一轮 101 → +1万 ↑
  r = simulateBoxRounds(
    [{ businessDate: "2026-09-15", fontKey: "A", movies: [{ movieId: "1", name: "M1", rank: 1, box: 101 }] }],
    store,
  );
  assert(nearly(snapBox(), 101), "t3 display 101");
  assert(r[0].rises.length === 1, "t3 has rise");
  assert(nearly(r[0].rises[0].deltaWan, 1), "t3 delta 1");
  assert(formatRiseTextWithArrow(1).includes("万") && formatRiseTextWithArrow(1).includes("↑"), "t3 text");
  passed += 1;

  // 4. decode 失败 → 整轮 reject → UI 仍 101
  r = simulateBoxRounds(
    [
      {
        businessDate: "2026-09-15",
        fontKey: "A",
        movies: [{ movieId: "1", name: "M1", rank: 1, decodeFail: true }],
      },
    ],
    store,
  );
  assert(r[0].committed.ok === false, "t4 reject");
  assert(r[0].committed.reason === "partial_box_decode", "t4 partial_box_decode");
  assert(nearly(snapBox(), 101), "t4 keep 101 on fail");
  assert(nearly(store.getMovie("1").lastValidBoxWan, 101), "t4 lastValid 101");
  assert(r[0].rises.length === 0, "t4 no bubble");
  passed += 1;

  // 5. 101.5 → +5000元 ↑
  r = simulateBoxRounds(
    [{ businessDate: "2026-09-15", fontKey: "A", movies: [{ movieId: "1", name: "M1", rank: 1, box: 101.5 }] }],
    store,
  );
  assert(nearly(snapBox(), 101.5), "t5 display 101.5");
  assert(r[0].rises.length === 1, "t5 rise");
  assert(nearly(r[0].rises[0].deltaWan, 0.5), "t5 delta 0.5");
  const t5text = formatRiseTextWithArrow(0.5);
  assert(t5text.includes("万") && t5text.includes("↑"), `t5 text got ${t5text}`);
  assert(t5text.includes("+0.50万"), `t5 wan format got ${t5text}`);
  passed += 1;

  // 6. 错误回落 99 → 仍 101.5，无 bubble
  r = simulateBoxRounds(
    [{ businessDate: "2026-09-15", fontKey: "A", movies: [{ movieId: "1", name: "M1", rank: 1, box: 99 }] }],
    store,
  );
  assert(nearly(snapBox(), 101.5), "t6 keep 101.5");
  assert(r[0].rises.length === 0, "t6 no bubble");
  passed += 1;

  // 7. 连续 20 轮相同 → 再上涨 → bubble 正常
  for (let i = 0; i < 20; i += 1) {
    simulateBoxRounds(
      [{ businessDate: "2026-09-15", fontKey: "A", movies: [{ movieId: "1", name: "M1", rank: 1, box: 101.5 }] }],
      store,
    );
  }
  r = simulateBoxRounds(
    [{ businessDate: "2026-09-15", fontKey: "A", movies: [{ movieId: "1", name: "M1", rank: 1, box: 102 }] }],
    store,
  );
  assert(nearly(snapBox(), 102), "t7 display 102");
  assert(r[0].rises.length === 1 && nearly(r[0].rises[0].deltaWan, 0.5), "t7 rise after same");
  passed += 1;

  // 8. 字体 A → B mapping 未 ready：不更新；之后 B 正常
  const beforeFont = snapBox();
  r = simulateBoxRounds(
    [
      {
        businessDate: "2026-09-15",
        fontKey: "B",
        movies: [{ movieId: "1", name: "M1", rank: 1, decodeFail: true, reason: "map_not_ready" }],
      },
    ],
    store,
  );
  assert(nearly(snapBox(), beforeFont), "t8 keep during B not ready");
  r = simulateBoxRounds(
    [{ businessDate: "2026-09-15", fontKey: "B", movies: [{ movieId: "1", name: "M1", rank: 1, box: 103 }] }],
    store,
  );
  assert(nearly(snapBox(), 103), "t8 update after B ready");
  assert(r[0].rises.length === 1, "t8 rise after B");
  passed += 1;

  // 9/10. poll 重叠 → skip
  {
    let resolveMap;
    const mapPromise = new Promise((resolve) => {
      resolveMap = resolve;
    });
    const fakeStore = createBoxStore({ riseEngine: createRiseEngine() });
    let mapReady = false;
    const pipeline = createBoxPipeline({
      store: fakeStore,
      pollIntervalMs: 5000,
      lockPollMs: false,
      fetchDashboardFn: async () => {
        if (!mapReady) {
          await mapPromise;
        }
        return {
          calendar: { today: "2026-09-15" },
          fontStyle: "",
          movieList: {
            list: [
              {
                movieInfo: { movieId: 9, movieName: "T" },
                boxSplitUnit: { num: "110", unit: "万" },
              },
            ],
            nationBoxInfo: {},
            updateInfo: {},
          },
        };
      },
    });

    const p1 = pipeline.runOnce();
    const p2 = pipeline.runOnce();
    const r2 = await p2;
    assert(r2.skipped === true || r2.reason === "overlap_skip", "t9/t10 overlap skip");
    mapReady = true;
    resolveMap();
    await p1;
    passed += 1;
    passed += 1;
  }

  // 11. businessDate 变化 → baseline 重置
  {
    const s2 = createBoxStore({ riseEngine: createRiseEngine() });
    simulateBoxRounds(
      [{ businessDate: "2026-09-15", movies: [{ movieId: "1", rank: 1, box: 200 }] }],
      s2,
    );
    assert(nearly(s2.getMovie("1").lastValidBoxWan, 200), "t11 before date");
    simulateBoxRounds(
      [{ businessDate: "2026-09-16", movies: [{ movieId: "1", rank: 1, box: 50 }] }],
      s2,
    );
    assert(nearly(s2.getMovie("1").displayBoxWan, 50), "t11 reset baseline");
    assert(nearly(s2.getMovie("1").lastValidBoxWan, 50), "t11 new lastValid");
    passed += 1;
  }

  // 12. TOP1 切换 → 冠军来自新 TOP1 有效数据，不继承旧冠军数字
  {
    const s3 = createBoxStore({ riseEngine: createRiseEngine() });
    simulateBoxRounds(
      [
        {
          businessDate: "2026-09-15",
          movies: [
            { movieId: "A", name: "OldChamp", rank: 1, box: 500 },
            { movieId: "B", name: "NewChamp", rank: 2, box: 300 },
          ],
        },
      ],
      s3,
    );
    assert(nearly(s3.getChampion().displayBoxWan, 500), "t12 old champ 500");
    simulateBoxRounds(
      [
        {
          businessDate: "2026-09-15",
          movies: [
    // dashboard-rank 已给出正式 rank；Store 只继承，不按票房重排
            { movieId: "B", name: "NewChamp", rank: 1, box: 520 },
            { movieId: "A", name: "OldChamp", rank: 2, box: 400 },
          ],
        },
      ],
      s3,
    );
    const champ = s3.getChampion();
    assert(champ.movieId === "B", "t12 champ is B");
    assert(nearly(champ.displayBoxWan, 520), "t12 champ box 520 not inherited 500");
    passed += 1;
  }

  // decode result 契约
  {
    const fail = makeDecodeResult({ ok: false, reason: "map_not_ready" });
    assert(fail.ok === false && fail.valueWan === null, "decode fail not zero");
    const ok = makeDecodeResult({ ok: true, valueWan: 143.82, text: "143.82", reason: "verified" });
    assert(ok.ok && nearly(ok.valueWan, 143.82), "decode ok");
    const plain = tryPlainBoxDecode({ todayBoxHtml: "143.82", todayUnit: "万" });
    assert(plain.ok && nearly(plain.valueWan, 143.82) && plain.reason === "plain", "plain decode");
    passed += 1;
  }

  assert(BOX_POLL_MS === 5000, "BOX_POLL_MS fixed 5000");

  // ========== 场景 14~20 ==========

  // 14. 5部全部成功 → publish
  {
    const s = createBoxStore({ riseEngine: createRiseEngine() });
    r = simulateBoxRounds(
      [{ businessDate: "2026-09-15", movies: fiveMovies([500, 400, 300, 200, 100]) }],
      s,
    );
    assert(r[0].committed.ok === true, "s14 publish");
    assert(s.getSnapshot().movies.length === 5, "s14 five movies");
    assert(nearly(s.getChampion().displayBoxWan, 500), "s14 champ 500");
    passed += 1;
  }

  // 15. 5部其中1部 decode fail → 整轮 reject → Store仍保持上一轮5部
  {
    const s = createBoxStore({ riseEngine: createRiseEngine() });
    simulateBoxRounds(
      [{ businessDate: "2026-09-15", movies: fiveMovies([500, 400, 300, 200, 100]) }],
      s,
    );
    const before = s.getSnapshot().movies.map((m) => ({
      id: m.movieId,
      box: m.displayBoxWan,
      rank: m.rank,
    }));
    r = simulateBoxRounds(
      [
        {
          businessDate: "2026-09-15",
          movies: fiveMovies([510, 410, null, 210, 110], { decodeFail: [false, false, true, false, false] }),
        },
      ],
      s,
    );
    assert(r[0].committed.ok === false, "s15 reject");
    assert(r[0].committed.reason === "partial_box_decode", "s15 reason");
    assert((r[0].committed.failedMovieIds || []).includes("3"), "s15 failed id");
    assert(s.getSnapshot().movies.length === 5, "s15 still 5");
    const after = s.getSnapshot().movies;
    for (let i = 0; i < 5; i += 1) {
      assert(after[i].movieId === before[i].id, `s15 id ${i}`);
      assert(nearly(after[i].displayBoxWan, before[i].box), `s15 box ${i}`);
      assert(after[i].rank === before[i].rank, `s15 rank ${i}`);
    }
    passed += 1;
  }

  // 16. 上一轮5部 → 下一轮接口只返回2部 → reject → UI仍5部
  {
    const s = createBoxStore({ riseEngine: createRiseEngine() });
    simulateBoxRounds(
      [{ businessDate: "2026-09-15", movies: fiveMovies([500, 400, 300, 200, 100]) }],
      s,
    );
    r = simulateBoxRounds(
      [
        {
          businessDate: "2026-09-15",
          movies: [
            { movieId: "1", rank: 1, box: 520 },
            { movieId: "2", rank: 2, box: 420 },
          ],
        },
      ],
      s,
    );
    assert(r[0].committed.ok === false, "s16 reject");
    assert(r[0].committed.reason === "partial_movie_list", "s16 reason");
    assert(s.getSnapshot().movies.length === 5, "s16 still 5");
    assert(nearly(s.getMovie("3").displayBoxWan, 300), "s16 keep m3");
    passed += 1;
  }

  // 17. 部分decode失败 → rank完全不变化
  {
    const s = createBoxStore({ riseEngine: createRiseEngine() });
    simulateBoxRounds(
      [
        {
          businessDate: "2026-09-15",
          movies: [
            { movieId: "A", rank: 1, box: 100 },
            { movieId: "B", rank: 2, box: 90 },
            { movieId: "C", rank: 3, box: 80 },
            { movieId: "D", rank: 4, box: 70 },
            { movieId: "E", rank: 5, box: 60 },
          ],
        },
      ],
      s,
    );
    const ranksBefore = s.getSnapshot().movies.map((m) => `${m.movieId}:${m.rank}`).join(",");
    r = simulateBoxRounds(
      [
        {
          businessDate: "2026-09-15",
          movies: [
            { movieId: "B", rank: 1, box: 200 },
            { movieId: "A", rank: 2, box: 150 },
            { movieId: "C", rank: 3, decodeFail: true },
            { movieId: "D", rank: 4, box: 75 },
            { movieId: "E", rank: 5, box: 65 },
          ],
        },
      ],
      s,
    );
    assert(r[0].committed.ok === false, "s17 reject");
    const ranksAfter = s.getSnapshot().movies.map((m) => `${m.movieId}:${m.rank}`).join(",");
    assert(ranksBefore === ranksAfter, `s17 ranks unchanged ${ranksBefore} vs ${ranksAfter}`);
    passed += 1;
  }

  // 18. 无fontStyle 明文100.5 → 正常publish displayBoxWan=100.5
  {
    const s = createBoxStore({ riseEngine: createRiseEngine() });
    const pipeline = createBoxPipeline({
      store: s,
      pollIntervalMs: 5000,
      lockPollMs: false,
      fetchDashboardFn: async () => ({
        calendar: { today: "2026-09-15" },
        fontStyle: "",
        movieList: {
          list: [
            {
              movieInfo: { movieId: 88, movieName: "PlainFilm" },
              boxSplitUnit: { num: "100.5", unit: "万" },
            },
          ],
          nationBoxInfo: {
            nationBoxSplitUnit: { num: "999.1", unit: "万" },
            showCountDesc: "1万",
            viewCountDesc: "2万",
          },
          updateInfo: {},
        },
      }),
    });
    const result = await pipeline.runOnce();
    assert(result.ok === true, `s18 publish got ${result.reason}`);
    assert(nearly(s.getMovie("88").displayBoxWan, 100.5), "s18 display 100.5");
    const entity = { todayBoxHtml: "100.5", todayUnit: "万", todayBox: 0, todayBoxText: "--" };
    const resolved = resolveEntityBoxDecode(entity, "");
    assert(resolved.ok && nearly(resolved.valueWan, 100.5) && resolved.reason === "plain", "s18 plain reason");
    passed += 1;
  }

  // 19. 新电影进入TOP5 但当前box decode fail → 整轮reject → 不能显示新卡片 --
  {
    const s = createBoxStore({ riseEngine: createRiseEngine() });
    simulateBoxRounds(
      [{ businessDate: "2026-09-15", movies: fiveMovies([500, 400, 300, 200, 100]) }],
      s,
    );
    r = simulateBoxRounds(
      [
        {
          businessDate: "2026-09-15",
          movies: [
            { movieId: "1", rank: 1, box: 510 },
            { movieId: "2", rank: 2, box: 410 },
            { movieId: "3", rank: 3, box: 310 },
            { movieId: "4", rank: 4, box: 210 },
            { movieId: "99", name: "NewFilm", rank: 5, decodeFail: true },
          ],
        },
      ],
      s,
    );
    assert(r[0].committed.ok === false, "s19 reject");
    assert(r[0].committed.reason === "partial_box_decode", "s19 reason");
    assert(!s.getMovie("99") || !(s.getMovie("99").rank > 0), "s19 no new card");
    assert(s.getSnapshot().movies.every((m) => m.displayBoxWan > 0), "s19 no zero boxes");
    assert(s.getSnapshot().movies.length === 5, "s19 still 5 old");
    assert(s.getSnapshot().movies.every((m) => m.movieId !== "99"), "s19 new not listed");
    passed += 1;
  }

  // 20. nation decode fail + movie TOP5全部成功 → movie可更新 → nation保持上一轮
  {
    const s = createBoxStore({ riseEngine: createRiseEngine() });
    simulateBoxRounds(
      [
        {
          businessDate: "2026-09-15",
          movies: fiveMovies([500, 400, 300, 200, 100]),
          nation: { box: 8000 },
        },
      ],
      s,
    );
    assert(nearly(s.getSnapshot().nation.displayBoxWan, 8000), "s20 nation init");
    r = simulateBoxRounds(
      [
        {
          businessDate: "2026-09-15",
          movies: fiveMovies([520, 420, 320, 220, 120]),
          nation: { decodeFail: true },
        },
      ],
      s,
    );
    assert(r[0].committed.ok === true, "s20 movies publish");
    assert(nearly(s.getMovie("1").displayBoxWan, 520), "s20 movie updated");
    assert(nearly(s.getSnapshot().nation.displayBoxWan, 8000), "s20 nation kept");
    assert(nearly(s.getSnapshot().nation.lastValidBoxWan, 8000), "s20 nation lastValid");
    passed += 1;
  }

  // validateCandidate 契约
  {
    const s = createBoxStore({ riseEngine: createRiseEngine() });
    const gate = validateCandidate(
      {
        movies: [
          { movieId: "1", box: makeDecodeResult({ ok: true, valueWan: 1, text: "1" }) },
          { movieId: "2", box: makeDecodeResult({ ok: false, reason: "x" }) },
        ],
      },
      s,
    );
    assert(gate.reason === "partial_box_decode", "validate partial");
    assert(gate.moviesTotal === 2 && gate.moviesDecoded === 1, "validate counts");
    assert(gate.failedMovieIds.includes("2"), "validate failed ids");
    passed += 1;
  }

  console.log(`[OK] box-pipeline-v2 tests passed: ${passed}`);
}

main().catch((err) => {
  console.error("[FAIL]", err);
  process.exit(1);
});
