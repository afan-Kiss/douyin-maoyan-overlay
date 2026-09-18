/**
 * 最终布局验收：区块不重叠 + 单元格从左到右不交叉 + TOP10 填满 board。
 * 同时生成 final / posters / interaction 截图。
 */
const assert = require("assert");
const path = require("path");
const {
  mockMovies,
  startStaticServer,
  launchBrowser,
  openPreview,
  paintMovies,
  UI_DIR,
} = require("./ui-preview-harness");

const OUT = {
  final: path.join(UI_DIR, "final-1080x1920.png"),
  posters: path.join(UI_DIR, "posters-resolved.png"),
  guide: path.join(UI_DIR, "interaction-guide.png"),
  votes: path.join(UI_DIR, "final-vote-counts-1080x1920.png"),
};

async function inspectLayout(page) {
  return page.evaluate(() => {
    const overlaps = (a, b) =>
      !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    };
    const header = box(document.querySelector(".ix-header"));
    const board = box(document.querySelector(".ix-board"));
    const bottom = box(document.querySelector(".ix-bottom"));
    const guide = box(document.getElementById("ix-guide"));
    const cloud = box(document.getElementById("ix-word-cloud"));
    const raceList = document.getElementById("race-list");
    const cards = [...(raceList?.querySelectorAll(".race-card:not(.race-card--skeleton)") || [])];
    const issues = [];

    if (!(header && board && bottom && guide && cloud)) issues.push("missing-main-blocks");
    if (header && board && header.bottom > board.top + 1) issues.push("header overlaps board");
    if (board && bottom && board.bottom > bottom.top + 1) issues.push("board overlaps bottom");
    if (guide && cloud && overlaps(guide, cloud)) issues.push("guide overlaps cloud");
    if (guide && guide.bottom > 1920.5) issues.push("guide below 1920");
    if (cloud && cloud.bottom > 1920.5) issues.push("cloud below 1920");

    const listRect = box(raceList);
    const last = cards[cards.length - 1];
    const lastRect = box(last);
    const rowHeights = cards.map((c) => c.getBoundingClientRect().height);
    const fillGap = listRect && lastRect ? listRect.bottom - lastRect.bottom : 999;
    if (fillGap > 24) issues.push(`TOP10 not filled, gap=${fillGap.toFixed(1)}`);

    const cellIssues = [];
    for (const card of cards) {
      const rank = Number(card.dataset.rank);
      const cells = {
        rank: box(card.querySelector(".race-row__rank")),
        film: box(card.querySelector(".race-row__film")),
        box: box(card.querySelector('[data-metric="dailyBox"]')),
        boxRate: box(card.querySelector('[data-field="boxRate"]')),
        showRate: box(card.querySelector('[data-field="showCountRate"]')),
        good: box(card.querySelector("[data-good-user-count]")),
        bad: box(card.querySelector("[data-bad-user-count]")),
        score: box(card.querySelector("[data-live-score]")),
      };
      const order = ["rank", "film", "box", "boxRate", "showRate", "good", "bad", "score"];
      for (let i = 0; i < order.length - 1; i++) {
        const a = cells[order[i]];
        const b = cells[order[i + 1]];
        if (!a || !b) {
          cellIssues.push(`rank${rank} missing ${order[i]}/${order[i + 1]}`);
          continue;
        }
        if (a.right > b.left + 1) {
          cellIssues.push(`rank${rank} ${order[i]} overlaps ${order[i + 1]}`);
        }
      }
    }

    const posters = cards.map((card) => {
      const img = card.querySelector(".race-row__poster");
      return {
        rank: Number(card.dataset.rank),
        name: card.querySelector(".race-card__title")?.textContent || "",
        src: img?.getAttribute("src") || "",
      };
    });

    return {
      issues: [...issues, ...cellIssues],
      header,
      board,
      bottom,
      guide,
      cloud,
      fillGap,
      rowHeights,
      avgRowHeight: rowHeights.length
        ? rowHeights.reduce((s, n) => s + n, 0) / rowHeights.length
        : 0,
      posters,
      guideText: document.getElementById("ix-guide")?.innerText || "",
      hasGuideList: Boolean(document.querySelector("#ix-guide ul")),
    };
  });
}

async function main() {
  const { server, baseUrl } = await startStaticServer();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await openPreview(page, baseUrl, { width: 1080, height: 1920, liveOutput: true });
    const movies = mockMovies(10);
    await paintMovies(page, movies);

    const report = await inspectLayout(page);
    assert.strictEqual(report.issues.length, 0, report.issues.join("; "));
    assert.ok(report.avgRowHeight >= 118 && report.avgRowHeight <= 140, `rowH=${report.avgRowHeight}`);
    assert.ok(/互动方式/.test(report.guideText), "missing guide title");
    assert.ok(/1钻\s*=\s*10分/.test(report.guideText.replace(/\s+/g, "")), "missing diamond tag");
    assert.ok(/有效期3分钟/.test(report.guideText.replace(/\s+/g, "")), "missing expiry tag");
    assert.ok(/电影名\+好评/.test(report.guideText.replace(/\s+/g, "")), "missing pos cmd");
    assert.ok(/仅供娱乐/.test(report.guideText), "missing disclaimer");
    assert.strictEqual(report.hasGuideList, false, "guide must not use ul list");

    await page.screenshot({ path: OUT.final, fullPage: false });
    await page.screenshot({ path: OUT.posters, fullPage: false });
    const guideClip = report.guide;
    await page.screenshot({
      path: OUT.guide,
      clip: {
        x: Math.max(0, guideClip.left - 8),
        y: Math.max(0, guideClip.top - 8),
        width: Math.min(1080 - guideClip.left + 8, guideClip.width + 16),
        height: Math.min(1920 - guideClip.top + 8, guideClip.height + 16),
      },
    });

    await page.evaluate((movies) => {
      const samples = [
        { goodUserCount: 128, badUserCount: 23 },
        { goodUserCount: 12000, badUserCount: 999 },
        { goodUserCount: 0, badUserCount: 0 },
      ];
      movies.forEach((movie, index) => {
        const sample = samples[index] || { goodUserCount: 8, badUserCount: 1 };
        window.__movieInteraction.setMovieStats(movie.movieId, sample);
        window.__racePreview.renderList(movies);
      });
    }, movies);
    const voteSnap = await page.evaluate(() =>
      [...document.querySelectorAll(".race-card")].slice(0, 3).map((card) => ({
        good: card.querySelector("[data-good-user-count]")?.textContent?.trim(),
        bad: card.querySelector("[data-bad-user-count]")?.textContent?.trim(),
      })),
    );
    assert.deepStrictEqual(voteSnap[0], { good: "128", bad: "23" });
    assert.deepStrictEqual(voteSnap[1], { good: "1.2万", bad: "999" });
    assert.deepStrictEqual(voteSnap[2], { good: "0", bad: "0" });
    const afterVotes = await inspectLayout(page);
    assert.strictEqual(afterVotes.issues.length, 0, afterVotes.issues.join("; "));
    await page.screenshot({ path: OUT.votes, fullPage: false });

    const half = await browser.newPage();
    await openPreview(half, baseUrl, { width: 540, height: 960, liveOutput: false });
    await paintMovies(half, movies);
    const halfReport = await inspectLayout(half);
    assert.strictEqual(halfReport.issues.length, 0, `540: ${halfReport.issues.join("; ")}`);
    await half.close();

    console.log("PASS final-layout");
    console.log("Layout:", {
      fillGap: report.fillGap,
      avgRowHeight: report.avgRowHeight,
      posters: report.posters.map((p) => ({
        rank: p.rank,
        name: p.name,
        fallback: /default-movie-poster/.test(p.src),
        src: p.src,
      })),
    });
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
