/**
 * 更新健康确认与 .bak 保留验收：node deploy/test-updater-health-rollback.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function makeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function withTempEnv(fn) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-health-"));
  const prev = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = appData;
  try {
    return fn(appData);
  } finally {
    if (prev === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prev;
    try {
      fs.rmSync(appData, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function reloadHealthModules() {
  delete require.cache[require.resolve("../lib/update/paths")];
  delete require.cache[require.resolve("../lib/update/apply")];
  delete require.cache[require.resolve("../lib/update/health")];
  delete require.cache[require.resolve("../lib/update/manager")];
}

function testSpawnWithoutHealthKeepsBackup() {
  withTempEnv((appData) => {
    reloadHealthModules();
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-install-"));
    const { replaceExe } = require("../lib/update/apply");
    const { readPendingUpdate } = require("../lib/update/health");
    const { prepareUpdateEnvironmentEarly } = require("../lib/update/manager");

    const target = path.join(installDir, "MaoyanOverlay.exe");
    const source = path.join(installDir, "new.exe");
    const bak = path.join(installDir, "MaoyanOverlay.exe.bak");
    makeFile(target, "old-binary");
    makeFile(source, "new-binary");

    replaceExe(source, installDir, "MaoyanOverlay.exe");
    assert.ok(fs.existsSync(bak), ".bak must exist after replace");

    const { writePendingUpdate } = require("../lib/update/health");
    writePendingUpdate({
      token: "test-token",
      installDir,
      exeName: "MaoyanOverlay.exe",
      targetVersion: "1.0.1",
    });

    prepareUpdateEnvironmentEarly();
    assert.ok(fs.existsSync(bak), ".bak must remain before health confirmation");
    assert.ok(readPendingUpdate(), "pending update must remain");

    try {
      fs.rmSync(installDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  console.log("OK: spawn/replace without health keeps .bak");
}

function testHealthConfirmRemovesBackup() {
  withTempEnv(() => {
    reloadHealthModules();
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-install-"));
    const { replaceExe } = require("../lib/update/apply");
    const { writePendingUpdate, confirmUpdateHealth } = require("../lib/update/health");

    const target = path.join(installDir, "MaoyanOverlay.exe");
    const source = path.join(installDir, "new.exe");
    const bak = path.join(installDir, "MaoyanOverlay.exe.bak");
    makeFile(target, "old-binary");
    makeFile(source, "new-binary");
    replaceExe(source, installDir, "MaoyanOverlay.exe");

    writePendingUpdate({
      token: "health-ok-token",
      installDir,
      exeName: "MaoyanOverlay.exe",
      targetVersion: "1.0.1",
    });

    const ok = confirmUpdateHealth();
    assert.strictEqual(ok, true);
    assert.ok(!fs.existsSync(bak), ".bak must be removed after health confirmation");

    try {
      fs.rmSync(installDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  console.log("OK: health confirmation removes .bak");
}

function main() {
  testSpawnWithoutHealthKeepsBackup();
  testHealthConfirmRemovesBackup();
  console.log("\nALL PASSED (updater health rollback)");
}

main();
