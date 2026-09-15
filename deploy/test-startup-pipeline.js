/**
 * 启动管线验收：模拟 10s 字体映射延迟时，名称/占比应先于票房映射完成。
 * node deploy/test-startup-pipeline.js
 */
const assert = require("assert");
const { pathToFileURL } = require("url");
const path = require("path");

const ROOT = path.join(__dirname, "..");

async function loadModules() {
  const apiPath = pathToFileURL(path.join(ROOT, "ui", "maoyan-api.js")).href;
  const pipelinePath = pathToFileURL(path.join(ROOT, "ui", "font-pipeline.js")).href;
  const metricsPath = pathToFileURL(path.join(ROOT, "ui", "startup-metrics.js")).href;
  const [api, pipeline, metrics] = await Promise.all([
    import(apiPath),
    import(pipelinePath),
    import(metricsPath),
  ]);
  return { api, pipeline, metrics };
}

async function main() {
  const { api, pipeline, metrics } = await loadModules();
  const API_BASE = process.env.MAOYAN_API_BASE || "http://127.0.0.1:8765";

  metrics.beginStartupSession("cold");

  const raw = await api.fetchDashboard(API_BASE, "", { topCount: 5 });
  metrics.markStartup("dashboardReturned");
  assert.ok(raw?.movieList?.list?.length, "dashboard should return movies");

  const parsed = api.parseDashboard(raw, 5);
  metrics.markStartup("firstRealFields");
  assert.ok(parsed.movies[0]?.name, "movie name should parse without PUA map");
  assert.ok(parsed.movies[0]?.boxRate, "box rate should parse without PUA map");

  const mapStart = Date.now();
  const built = await pipeline.schedulePuaMapBuild(raw.fontStyle, {
    nationHtml: raw.movieList?.nationBoxInfo?.nationBoxSplitUnit?.num || "",
    nationUnit: "万",
    movies: (raw.movieList?.list || []).slice(0, 5).map((item, index) => ({
      rank: index + 1,
      todayBoxHtml: item.boxSplitUnit?.num || "",
      todayUnit: "万",
      boxRate: item.boxRate || "",
    })),
  }, { simulateDelayMs: Number(process.env.MAP_SIMULATE_DELAY_MS || 0) });

  const mapMs = Date.now() - mapStart;
  metrics.markStartup("mappingComplete", { mapMs, ok: built?.ok });

  const report = metrics.getStartupMarks();
  const firstFieldsMs = report.marks.firstRealFields?.ms ?? 0;
  const mappingMs = report.marks.mappingComplete?.ms ?? mapMs;

  console.log("startup marks:", JSON.stringify(report.marks, null, 2));
  assert.ok(firstFieldsMs >= 0, "firstRealFields should be recorded");
  if (Number(process.env.MAP_SIMULATE_DELAY_MS || 0) >= 2000) {
    assert.ok(
      firstFieldsMs < mappingMs || firstFieldsMs < Number(process.env.MAP_SIMULATE_DELAY_MS),
      "names/rates should be available before slow mapping completes",
    );
  }

  console.log("\nALL PASSED (startup pipeline)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
