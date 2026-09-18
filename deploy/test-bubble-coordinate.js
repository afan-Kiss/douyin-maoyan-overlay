/**
 * 气泡坐标回归：540×960(scale=0.5) 与 1080×1920 liveOutput(scale=1)
 * 必须校验「对应电影对应列附近」，禁止只看是否被裁切。
 */
const assert = require("assert");
const path = require("path");
const {
  mockMovies,
  startStaticServer,
  launchBrowser,
  openPreview,
  paintMovies,
  diagnoseBubble,
  UI_DIR,
} = require("./ui-preview-harness");

const RANKS = [1, 5, 10];
const OUT = {
  box1: path.join(UI_DIR, "bubble-top1-box.png"),
  box5: path.join(UI_DIR, "bubble-top5-box.png"),
  box10: path.join(UI_DIR, "bubble-top10-box.png"),
  score1: path.join(UI_DIR, "bubble-top1-score.png"),
  score10: path.join(UI_DIR, "bubble-top10-score.png"),
};

function printDiag(label, diag) {
  console.log(`[${label}]`, {
    viewportScale: diag.viewportScale,
    layerRect: diag.layerRect,
    anchorRect: diag.anchorRect,
    bubbleRect: diag.bubbleRect,
    anchorMovieId: diag.anchorMovieId,
    anchorRank: diag.anchorRank,
    anchorColumn: diag.anchorColumn,
    dx: diag.dx,
    dy: diag.dy,
  });
}

function assertNearAnchor(diag, kind) {
  assert.ok(diag.ok, diag.reason || "bubble missing");
  if (kind === "box") {
    assert.ok(diag.absDx <= 8, `${kind} X偏差过大 dx=${diag.dx}`);
    assert.ok(diag.dy < 0, `${kind} 应在锚点上方 dy=${diag.dy}`);
    assert.ok(diag.dy > -120, `${kind} 离锚点过远 dy=${diag.dy}`);
    return;
  }
  // 评分列靠右，宽气泡会被右边界 clamp；要求仍覆盖评分胶囊水平范围，且不漂到票房列
  const overlapsX =
    diag.bubbleRect.left <= diag.anchorRect.right &&
    diag.bubbleRect.right >= diag.anchorRect.left;
  assert.ok(overlapsX, `${kind} 未覆盖评分列 dx=${diag.dx}`);
  assert.ok(diag.bubbleRect.left > 640, `${kind} 漂到票房/片名列 left=${diag.bubbleRect.left}`);
  assert.ok(Math.abs(diag.dy) < 140, `${kind} Y偏差过大 dy=${diag.dy}`);
}

async function showBoxBubble(page, movie) {
  await page.evaluate(({ movieId, amount }) => {
    const api = window.__racePreview;
    const card = api.getCardNode(movieId);
    const el = card?.querySelector(".race-card__delta-float");
    api.pulseInlineDelta(el, amount, `test-box-${movieId}`, { movieId, type: "real" });
    const bubble = document.querySelector(
      `#global-bubble-layer .race-card__delta-float[data-movie-id="${CSS.escape(String(movieId))}"]`,
    );
    if (bubble) {
      bubble.style.animation = "none";
      bubble.classList.add("is-visible");
      bubble.classList.remove("is-animating");
      bubble.style.opacity = "1";
      bubble.style.visibility = "visible";
      bubble.style.transform = "translateX(-50%)";
    }
  }, { movieId: movie.movieId, amount: movie.rank === 4 ? 0.1413 : 0.2 + movie.rank * 0.01 });
  await page.waitForTimeout(40);
}

async function showScoreBubble(page, movie) {
  await page.evaluate(({ movie }) => {
    window.__movieInteraction.clearScoreBubbles?.();
    window.__movieInteraction.showMovieScoreBubble({
      eventId: `score-${movie.movieId}-${Date.now()}`,
      movieId: movie.movieId,
      movieName: movie.name,
      nickname: "张三",
      scoreDelta: 300,
    });
    const bubble = [...document.querySelectorAll(".score-bubble")].find(
      (el) => el.dataset.anchorMovieId === String(movie.movieId),
    );
    if (bubble) {
      bubble.style.animation = "none";
      bubble.style.transform = "none";
      bubble.style.opacity = "1";
    }
  }, { movie });
  await page.waitForTimeout(40);
}

async function runMode(browser, baseUrl, mode) {
  const page = await browser.newPage();
  await openPreview(page, baseUrl, mode);
  const movies = mockMovies(10);
  await paintMovies(page, movies);

  const scale = await page.evaluate(
    () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--viewport-scale")) || 1,
  );
  const expectedScale = mode.liveOutput ? 1 : 0.5;
  assert.ok(Math.abs(scale - expectedScale) < 0.02, `${mode.name} scale=${scale} expected≈${expectedScale}`);

  const reports = [];
  for (const rank of RANKS) {
    const movie = movies.find((m) => m.rank === rank);
    await showBoxBubble(page, movie);
    const boxDiag = await diagnoseBubble(page, { kind: "box", movieId: movie.movieId });
    printDiag(`${mode.name}/box/TOP${rank}`, boxDiag);
    assertNearAnchor(boxDiag, "box");
    reports.push({ mode: mode.name, kind: "box", rank, ...boxDiag });

    if (rank === 1) await page.screenshot({ path: OUT.box1, fullPage: false });
    if (rank === 5) await page.screenshot({ path: OUT.box5, fullPage: false });
    if (rank === 10) await page.screenshot({ path: OUT.box10, fullPage: false });
  }

  for (const rank of [1, 10]) {
    const movie = movies.find((m) => m.rank === rank);
    await showScoreBubble(page, movie);
    const scoreDiag = await diagnoseBubble(page, { kind: "score", movieId: movie.movieId });
    printDiag(`${mode.name}/score/TOP${rank}`, scoreDiag);
    assertNearAnchor(scoreDiag, "score");
    reports.push({ mode: mode.name, kind: "score", rank, ...scoreDiag });
    if (rank === 1) await page.screenshot({ path: OUT.score1, fullPage: false });
    if (rank === 10) await page.screenshot({ path: OUT.score10, fullPage: false });
  }

  await page.close();
  return reports;
}

async function main() {
  const { server, baseUrl } = await startStaticServer();
  const browser = await launchBrowser();
  try {
    const half = await runMode(browser, baseUrl, { name: "540x960", width: 540, height: 960, liveOutput: false });
    const full = await runMode(browser, baseUrl, {
      name: "1080x1920-liveOutput",
      width: 1080,
      height: 1920,
      liveOutput: true,
    });

    for (const rank of RANKS) {
      const a = half.find((r) => r.kind === "box" && r.rank === rank);
      const b = full.find((r) => r.kind === "box" && r.rank === rank);
      assert.ok(a && b, `missing pair TOP${rank}`);
      assert.ok(Math.abs(a.dx - b.dx) <= 8, `scale 不一致 TOP${rank} dx ${a.dx} vs ${b.dx}`);
    }

    console.log("PASS bubble-coordinate");
    console.log("Screenshots:", OUT);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
