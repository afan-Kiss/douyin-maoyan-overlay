/**
 * 字体/响应会话回放：7 类竞态场景 + 发布门控
 * node deploy/test-font-session-replay.js
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");

async function loadRegistry() {
  const mod = await import(pathToFileURL(path.join(root, "ui/font-registry.js")).href);
  return mod;
}

async function loadMaoyanApi() {
  const mod = await import(pathToFileURL(path.join(root, "ui/maoyan-api.js")).href);
  return mod;
}

async function main() {
  const reg = await loadRegistry();
  const api = await loadMaoyanApi();

  // 1. A 字体成功 → B 响应到达：旧 responseId 不能覆盖新发布
  {
    reg.cacheMapForFont("fontA", {
      ok: true,
      confidence: "verified",
      map: new Map([[0xe6d5, "1"]]),
      versionKey: "fontA",
    });
    reg.publishSession({ responseId: 1, contentKey: "fontA", businessDate: "2026-09-15" });
    reg.cacheMapForFont("fontB", {
      ok: true,
      confidence: "verified",
      map: new Map([[0xe6d6, "2"]]),
      versionKey: "fontB",
    });
    reg.publishSession({ responseId: 2, contentKey: "fontB", businessDate: "2026-09-15" });
    const stale = reg.canPublishSession({ responseId: 1, contentKey: "fontA", businessDate: "2026-09-15" });
    assert.equal(stale.ok, false, "stale response cannot publish");
    const newer = reg.canPublishSession({ responseId: 3, contentKey: "fontB", businessDate: "2026-09-15" });
    assert.equal(newer.ok, true, "newer response can publish when font ready");
  }

  // 2. B 已就绪后 A Worker 才返回：A 只进缓存
  {
    const builtA = {
      ok: true,
      confidence: "verified",
      map: new Map([[0xe6d5, "9"]]),
      versionKey: "fontA-worker",
    };
    reg.cacheMapForFont("fontA-worker", builtA);
    const pub = reg.publishSession({ responseId: 1, contentKey: "fontA-worker", businessDate: "2026-09-15" });
    assert.equal(pub.ok, false, "old worker result must not publish over newer response");
    assert.ok(reg.isMapVerified("fontA-worker"), "worker result stays in version cache");
  }

  // 3. 内容 sha256 身份归一
  {
    assert.equal(reg.normalizeFontIdentity("sha256:deadbeef"), "sha256:deadbeef");
    assert.equal(reg.normalizeFontIdentity("mtsi:abc12345"), "url:abc12345");
  }

  // 4. 结构解析不依赖映射
  {
    const raw = {
      calendar: { today: "2026-09-15" },
      fontStyle: "",
      movieList: {
        nationBoxInfo: {
          nationBoxSplitUnit: { num: "123.4", unit: "万" },
          showCountDesc: "1万场",
        },
        list: [
          {
            movieInfo: { movieId: 1, movieName: "测试片" },
            boxSplitUnit: { num: "10.5", unit: "万" },
            boxRate: "12%",
          },
        ],
      },
    };
    const structural = api.parseDashboardStructure(raw, 5);
    assert.equal(structural.nation.todayBox, 0);
    assert.equal(structural.movies[0].name, "测试片");
    assert.equal(structural.movies[0].todayBoxText, "--");
  }

  // 5. scheduleDashboardPuaMap 不直接 apply（Node 无 document 时跳过 Worker）
  if (typeof document !== "undefined") {
    /* browser-only */
  } else {
    assert.equal(typeof api.scheduleDashboardPuaMap, "function");
  }

  // 6. 同字体跨轮响应复用映射缓存
  {
    const key = "font-reuse";
    const map = new Map([[0xe700, "2"]]);
    reg.cacheMapForFont(key, { ok: true, confidence: "verified", map, versionKey: key });
    assert.ok(reg.isMapVerified(key));
    reg.cacheMapForFont(key, { ok: true, confidence: "verified", map, versionKey: key });
    assert.ok(reg.isMapVerified(key));
  }

  // 7. 发布门控：responseId 单调
  {
    reg.cacheMapForFont("fontX", {
      ok: true,
      confidence: "verified",
      map: new Map([[0xe701, "3"]]),
      versionKey: "fontX",
    });
    reg.cacheMapForFont("fontY", {
      ok: true,
      confidence: "verified",
      map: new Map([[0xe702, "4"]]),
      versionKey: "fontY",
    });
    reg.publishSession({ responseId: 10, contentKey: "fontX", businessDate: "2026-09-15" });
    const blocked = reg.publishSession({ responseId: 9, contentKey: "fontY", businessDate: "2026-09-15" });
    assert.equal(blocked.ok, false);
    const allowed = reg.publishSession({ responseId: 11, contentKey: "fontY", businessDate: "2026-09-15" });
    assert.equal(allowed.ok, true);
  }

  console.log("test-font-session-replay: PASS (7 scenarios)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
