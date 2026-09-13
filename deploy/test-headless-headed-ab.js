/**
 * headless vs headed A/B 诊断
 * node deploy/test-headless-headed-ab.js
 */
const fs = require("fs");
const path = require("path");
const { runHeadlessHeadedDiagnostic } = require("../lib/production-verify");

function resolveStorageState() {
  if (process.env.MAOYAN_DATA_DIR) {
    const p = path.join(process.env.MAOYAN_DATA_DIR, "browser_state.json");
    if (fs.existsSync(p)) return p;
  }
  const local =
    process.env.LOCALAPPDATA &&
    path.join(process.env.LOCALAPPDATA, "MaoyanOverlay", "maoyan-data", "browser_state.json");
  if (local && fs.existsSync(local)) return local;
  const legacy = path.join(__dirname, "..", "data", "browser_state.json");
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

async function main() {
  const storageStatePath = resolveStorageState();
  if (!storageStatePath) {
    console.log("SKIP: browser_state.json not found");
    process.exit(0);
  }

  const movieId = process.env.VERIFY_MOVIE_ID || "1462628";
  const dataDir = path.dirname(storageStatePath);
  const report = await runHeadlessHeadedDiagnostic(storageStatePath, { dataDir, movieId });

  for (const row of report.results) {
    console.log(
      JSON.stringify({
        mode: row.mode,
        dashboardLoaded: row.dashboardLoaded,
        boxPageLoaded: row.boxPageLoaded,
        finalUrlHost: row.finalUrlHost,
        finalPath: row.finalPath,
        getBoxShowRequestSeen: row.getBoxShowRequestSeen,
        signatureCaptured: row.signatureCaptured,
        detailHttpStatus: row.detailHttpStatus,
        detailPayloadValid: row.detailPayloadValid,
        lastVerifyError: row.lastVerifyError,
      }),
    );
  }

  console.log(`DIAGNOSIS: ${report.diagnosis}`);
  if (report.diagnosis === "HEADLESS_PATH_INCOMPATIBLE") {
    console.log("HEADLESS_PATH_INCOMPATIBLE: headed 成功但 headless 失败，根因是生产浏览器模式，不是用户账号登录问题");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
