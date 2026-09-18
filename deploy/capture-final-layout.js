/**
 * 验收截图总入口：bubble + final layout。
 * node deploy/capture-final-layout.js
 */
const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function run(script) {
  const result = spawnSync(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.status !== 0) {
    throw new Error(`${script} failed with ${result.status}`);
  }
}

run("deploy/test-final-layout.js");
run("deploy/test-bubble-coordinate.js");
console.log("PASS capture-final-layout");
