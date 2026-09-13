/**
 * TOP10 布局回归：node deploy/test-layout-top10.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

async function main() {
  const { parseDashboard } = await import("../ui/maoyan-api.js");
  const appSource = fs.readFileSync(path.join(__dirname, "..", "ui", "app.js"), "utf-8");

  assert.ok(appSource.includes("const RACE_TOP_COUNT = 10"), "app.js 应使用 TOP10");
  assert.ok(appSource.includes("race-row"), "app.js 应包含紧凑排行行");

  const raw = {
    movieList: {
      list: Array.from({ length: 12 }, (_, i) => ({
        movieInfo: { movieId: i + 1, movieName: `电影${i + 1}` },
        boxSplitUnit: { num: "1", unit: "万" },
        boxRate: "10%",
        showCountRate: "8%",
        avgSeatView: "5%",
      })),
      nationBoxInfo: {},
      updateInfo: { updateTimestamp: Date.now() },
    },
    calendar: { today: "2026-09-13" },
  };

  const parsed = parseDashboard(raw, 10);
  assert.strictEqual(parsed.movies.length, 10);

  const fitMatch = appSource.match(/minSize:\s*30/);
  assert.ok(fitMatch, "电影标题最小字号应 >= 30px");

  console.log("ALL PASSED (layout top10)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
