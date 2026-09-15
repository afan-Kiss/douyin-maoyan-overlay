/**
 * UI 渲染稳定性：空值不覆盖、卡片 DOM 复用、气泡不被刷新打断。
 * node deploy/test-ui-stability.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

function makeMovie(id, rank, overrides = {}) {
  return {
    movieId: id,
    rank,
    name: `影片${id}`,
    todayBox: 40.1 + rank,
    todayBoxText: String(40.1 + rank),
    todayUnit: "万",
    displayBoxWan: 40.1 + rank,
    lastValidBoxWan: 40.1 + rank,
    boxRate: `${10 + rank}%`,
    showCountRate: `${20 + rank}%`,
    avgShowView: `${100 + rank}`,
    sumBoxDesc: `${rank}亿`,
    decodeStatus: "ok",
    decodeVerified: true,
    ...overrides,
  };
}

function top5(overridesById = {}) {
  return [1, 2, 3, 4, 5].map((rank) => {
    const id = String(1000 + rank);
    return makeMovie(id, rank, overridesById[id] || {});
  });
}

function toCandidate(movies, nation, day = "2026-09-16") {
  return {
    businessDate: day,
    movies: movies.map((m) => ({
      movieId: m.movieId,
      name: m.name,
      rank: m.rank,
      originalRank: m.rank,
      box: { ok: true, valueWan: Number(m.displayBoxWan || m.todayBox) },
      boxRate: m.boxRate,
      showCountRate: m.showCountRate,
      avgShowView: m.avgShowView,
      sumBoxDesc: m.sumBoxDesc,
      raw: m,
    })),
    nation: {
      box: { ok: true, valueWan: Number(nation.displayBoxWan || nation.todayBox) || 9000 },
      showCount: nation.showCountDesc || "",
      views: nation.viewCountDesc || "",
      seatLabel: nation.seatLabel || "场均人次",
      seatValue: nation.seatValue || "",
    },
  };
}

async function main() {
  const root = path.resolve(__dirname, "../ui");
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, "http://localhost").pathname;
    const file = path.join(root, name === "/" ? "index.html" : decodeURIComponent(name));
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end();
      res.setHeader(
        "Content-Type",
        file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html",
      );
      res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  let browser;
  try {
    const executablePath = [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "C:/Users/Administrator/AppData/Local/Google/Chrome/Bin/chrome.exe",
    ].find((p) => fs.existsSync(p));
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    await page.addInitScript(() => {
      window.testSettings = { bubble: { enabled: true, durationMs: 2000, fontSize: 34 } };
      window.overlay = {
        getConfig: async () => ({}),
        getOverlaySettings: async () => window.testSettings,
        getSessionStatus: async () => ({}),
        onSettingsChanged: (callback) => {
          window.changeSettings = callback;
        },
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?preview=1&uiTrace=1`);
    await page.waitForFunction(() => window.__racePreview);

    const nation = {
      todayBox: 9000,
      todayBoxText: "9000",
      todayUnit: "万",
      displayBoxWan: 9000,
      lastValidBoxWan: 9000,
      showCountDesc: "12.3万场",
      viewCountDesc: "45.6万人",
      seatLabel: "场均人次",
      seatValue: "78",
    };

    /** Store 提交 + paint（V2 真实路径） */
    const commitPaint = (movies, nationPatch = {}, day = "2026-09-16") =>
      page.evaluate(
        ({ candidate }) => {
          const result = window.__racePreview.commitAndPaint(candidate);
          if (!result?.ok) throw new Error(`commit failed: ${result?.reason || "unknown"}`);
          return result;
        },
        { candidate: toCandidate(movies, { ...nation, ...nationPatch }, day) },
      );

    /** 仅 UI 层 render（验证空值忽略，不经 Store merge） */
    const renderOnly = (movies, nationPatch = {}, day = "2026-09-16") =>
      page.evaluate(
        ({ movies, nationPatch, day }) => {
          window.__racePreview.renderList(movies, { snapshotId: Date.now() });
          window.__racePreview.updateNation(
            { ...nationPatch },
            { calendar: { today: day } },
          );
        },
        { movies, nationPatch: { ...nation, ...nationPatch }, day },
      );

    const readMetric = (movieId, metric) =>
      page.evaluate(
        ({ movieId, metric }) => {
          const card = document.querySelector(`.race-card[data-movie-id="${movieId}"]`);
          return (
            card?.querySelector(`[data-metric="${metric}"] .metric__value`)?.textContent?.trim() ||
            ""
          );
        },
        { movieId, metric },
      );

    const readNation = () =>
      page.evaluate(() => ({
        box: document.getElementById("nation-box")?.textContent?.trim() || "",
        shows: document.getElementById("nation-shows")?.textContent?.trim() || "",
        views: document.getElementById("nation-views")?.textContent?.trim() || "",
      }));

    // 1) 第一次 snapshot：TOP5 全量
    await commitPaint(top5());
    assert.strictEqual(await readMetric("1001", "boxRate"), "11%");
    assert.ok((await readMetric("1001", "dailyBox")).length > 0, "dailyBox painted");
    const nation1 = await readNation();
    assert.ok(nation1.box && nation1.box !== "--", `nation box=${nation1.box}`);
    assert.strictEqual(nation1.shows, "12.3万场");

    // 2) UI 层字段 null：DOM 保留旧值（不经 Store，直接打到 render）
    await renderOnly(
      top5({
        "1001": {
          boxRate: null,
          avgShowView: "",
          showCountRate: "--",
          todayBox: 41.1,
          todayBoxText: "41.1",
          displayBoxWan: 41.1,
          lastValidBoxWan: 41.1,
        },
      }),
      { showCountDesc: "", viewCountDesc: null },
    );
    assert.strictEqual(await readMetric("1001", "boxRate"), "11%", "null boxRate must keep old");
    assert.strictEqual(await readMetric("1001", "avgShowView"), "101", "empty avg must keep old");
    assert.strictEqual(await readMetric("1001", "showCountRate"), "21%", "dash rate must keep old");
    const nation2 = await readNation();
    assert.strictEqual(nation2.shows, "12.3万场", "null nation shows must keep old");
    assert.strictEqual(nation2.views, "45.6万人", "null nation views must keep old");

    // 3) 正常新数据：应更新
    await commitPaint(
      top5({
        "1001": {
          todayBox: 42.5,
          todayBoxText: "42.5",
          displayBoxWan: 42.5,
          lastValidBoxWan: 42.5,
          boxRate: "15.2%",
        },
      }),
      { showCountDesc: "13.0万场" },
    );
    assert.ok((await readMetric("1001", "dailyBox")).includes("42.5"), "dailyBox updates");
    assert.strictEqual(await readMetric("1001", "boxRate"), "15.2%");
    assert.strictEqual((await readNation()).shows, "13.0万场");

    // 4) 排名不变：DOM 节点不重建
    await page.evaluate(() => {
      window.__stableCard = window.__racePreview.getCardNode("1001");
    });
    await commitPaint(
      top5({
        "1001": {
          todayBox: 42.6,
          todayBoxText: "42.6",
          displayBoxWan: 42.6,
          lastValidBoxWan: 42.6,
          boxRate: "15.3%",
        },
      }),
    );
    const sameNode = await page.evaluate(
      () => window.__stableCard === window.__racePreview.getCardNode("1001"),
    );
    assert.equal(sameNode, true, "same movieId must reuse DOM node");

    // 5) 触发 bubble 后刷新 snapshot：气泡仍正常结束
    await page.evaluate(() => {
      const card = window.__racePreview.getCardNode("1001");
      const bubble = card?.querySelector(".race-card__delta-bubble");
      window.__bubbleEl = bubble;
      window.__racePreview.pulseInlineDelta(bubble, 0.12, "movie-1001");
    });
    const bubbleText = await page.evaluate(() => window.__bubbleEl?.textContent?.trim() || "");
    assert.ok(bubbleText.includes("+"), `bubble text=${bubbleText}`);
    assert.equal(
      await page.evaluate(() => window.__racePreview.isBubbleVisible("movie-1001")),
      true,
    );

    await commitPaint(
      top5({
        "1001": {
          todayBox: 42.7,
          todayBoxText: "42.7",
          displayBoxWan: 42.7,
          lastValidBoxWan: 42.7,
          boxRate: "15.4%",
        },
      }),
    );

    const afterRefresh = await page.evaluate(() => ({
      sameEl: window.__bubbleEl?.isConnected === true,
      text: window.__bubbleEl?.textContent?.trim() || "",
      visible: window.__racePreview.isBubbleVisible("movie-1001"),
    }));
    assert.equal(afterRefresh.sameEl, true, "bubble node must survive refresh");
    assert.ok(afterRefresh.text.includes("+"), `bubble kept text=${afterRefresh.text}`);
    assert.equal(afterRefresh.visible, true, "bubble timer must still be active");

    await page.waitForTimeout(2200);
    const afterHide = await page.evaluate(() => ({
      text: window.__bubbleEl?.textContent?.trim() || "",
      visible: window.__racePreview.isBubbleVisible("movie-1001"),
      animating: window.__bubbleEl?.classList.contains("is-animating") || false,
    }));
    assert.equal(afterHide.visible, false, "bubble should finish after duration");
    assert.equal(afterHide.text, "", "bubble text cleared after hide");
    assert.equal(afterHide.animating, false);

    console.log("PASS ui stability (keep-valid / card reuse / bubble lifecycle)");
  } finally {
    await browser?.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
