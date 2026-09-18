/**
 * 电影互动 cursor / aliases 单元测试（无需 Chrome）
 * node deploy/test-movie-interaction-cursor-aliases.js
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

async function loadService() {
  const mod = await import(
    pathToFileURL(path.join(__dirname, "../ui/movie-interaction-service.js")).href
  );
  return mod;
}

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

async function testAliasesPublished() {
  const {
    toCatalogPayload,
    normalizeAliases,
  } = await loadService();

  const media = [
    { name: "哪吒之魔童闹海", aliases: ["哪吒", "哪吒2", "哪吒之魔童闹海"] },
    { name: "空枪", aliases: ["空枪", "Empty Gun"] },
  ];
  const movies = [
    { movieId: "1", name: "哪吒之魔童闹海", rank: 1 },
    { movieId: "2", movieName: "空枪", rank: 2, aliases: [" 空枪 ", "Empty Gun", ""] },
  ];
  const payload = toCatalogPayload(movies, media);
  assert.strictEqual(payload[0].movieId, "1");
  assert.deepStrictEqual(payload[0].aliases, ["哪吒", "哪吒2"]);
  assert.ok(!payload[0].aliases.includes("哪吒之魔童闹海"), "标准片名不应重复塞 alias");
  assert.deepStrictEqual(payload[1].aliases, ["Empty Gun"]);

  assert.deepStrictEqual(
    normalizeAliases(["  a ", "A", "b", ""], "Title"),
    ["a", "b"],
  );
  console.log("OK: aliases published and normalized");
}

async function testCursorResetAndCommitSemantics() {
  const {
    createMovieInteractionService,
    createMovieInteractionPoller,
    CURSOR_STORAGE_KEY,
    writeEventCursor,
    readEventCursor,
  } = await loadService();

  const storage = memoryStorage({ [CURSOR_STORAGE_KEY]: "50000" });
  globalThis.localStorage = storage;

  let call = 0;
  const responses = [
    {
      ok: true,
      after: 50000,
      cursor: 0,
      serverMaxSeq: 10,
      streamEpoch: "epoch-new",
      reset: true,
      events: [],
    },
    {
      ok: true,
      after: 0,
      cursor: 10,
      serverMaxSeq: 10,
      streamEpoch: "epoch-new",
      reset: false,
      events: [
        { seq: 1, type: "danmaku", data: { msgId: "m1", nickname: "a", content: "hi" } },
        { seq: 10, type: "danmaku", data: { msgId: "m10", nickname: "b", content: "yo" } },
      ],
    },
  ];

  globalThis.fetch = async () => {
    const body = responses[Math.min(call, responses.length - 1)];
    call += 1;
    const text = JSON.stringify(body);
    return {
      ok: true,
      status: 200,
      async text() {
        return text;
      },
      async json() {
        return body;
      },
    };
  };

  const service = createMovieInteractionService({
    baseUrl: "http://127.0.0.1:9/api/movie-interaction",
  });

  const result = await service.fetchEvents();
  assert.strictEqual(result.ok, true);
  assert.ok(result.events.length >= 1, "reset 后应重新拉到事件");
  assert.strictEqual(String(result.candidateCursor), "10");
  // fetchEvents 本身不得永久提交
  assert.strictEqual(readEventCursor(storage), "");

  // 模拟 poller：onEvents 抛错 → 不 commit；成功 → commit
  async function runOnce(onEvents) {
    const r = await service.fetchEvents();
    assert.strictEqual(r.ok, true);
    const events = r.events || [];
    const candidate = r.candidateCursor ?? r.cursor;
    if (events.length) {
      await Promise.resolve(onEvents(events));
    }
    if (candidate != null && candidate !== "") {
      const prev = service.readEventCursor();
      if (String(candidate) !== String(prev)) {
        (service.commitEventCursor || service.writeEventCursor)(candidate);
      }
    }
    return events.length;
  }

  call = 1;
  writeEventCursor("", storage);
  let threw = false;
  try {
    await runOnce(() => {
      throw new Error("boom");
    });
  } catch {
    threw = true;
  }
  assert.strictEqual(threw, true);
  assert.strictEqual(readEventCursor(storage), "", "onEvents 抛错不推进 cursor");

  call = 1;
  const n = await runOnce(() => {});
  assert.strictEqual(n, 2);
  assert.strictEqual(String(readEventCursor(storage)), "10", "成功处理后推进 cursor");

  // 再用真实 poller 验一次成功路径
  writeEventCursor("", storage);
  call = 1;
  const poller = createMovieInteractionPoller({
    service,
    onEvents: () => {},
  });
  await poller.pollEvents();
  assert.strictEqual(String(readEventCursor(storage)), "10");
  console.log("OK: cursor reset + commit-after-onEvents");
}

async function main() {
  await testAliasesPublished();
  await testCursorResetAndCommitSemantics();
  console.log("\nALL PASSED (movie interaction cursor/aliases)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
