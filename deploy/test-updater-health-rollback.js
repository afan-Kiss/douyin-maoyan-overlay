/**
 * 更新健康确认顺序/回滚验收：node deploy/test-updater-health-rollback.js
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

function makeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function sha256Of(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function withTempEnv(fn) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-health-"));
  const prev = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = appData;
  try {
    return await fn(appData);
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

function reloadModules() {
  for (const mod of [
    "../lib/update/paths",
    "../lib/update/downloader",
    "../lib/update/apply",
    "../lib/update/health",
    "../lib/update/manager",
    "../lib/update/version",
  ]) {
    delete require.cache[require.resolve(mod)];
  }
}

async function testApplyOrderAndHealthFlow() {
  await withTempEnv(async () => {
    reloadModules();
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-install-"));
    const {
      runApplyUpdate,
      _resetApplyTestState,
      _setApplyTestDeps,
      _getApplyActionLog,
    } = require("../lib/update/apply");
    const health = require("../lib/update/health");

    _resetApplyTestState();

    const oldBinary = "old-binary-v1.0";
    const newBinary = "new-binary-v1.1";
    const expectedSha = sha256Of(newBinary);
    const target = path.join(installDir, "MaoyanOverlay.exe");
    const source = path.join(installDir, "new.exe");
    const bak = path.join(installDir, "MaoyanOverlay.exe.bak");
    const versionFile = path.join(installDir, "version.txt");

    makeFile(target, oldBinary);
    makeFile(source, newBinary);
    makeFile(versionFile, "1.0");

    let launchCalled = false;
    let pendingBeforeLaunch = false;

    _setApplyTestDeps({
      waitForPidExit: async () => "EXITED",
      killProcess: async () => {},
      sleep: async (ms) => {
        if (ms > 100) return;
        await new Promise((r) => setTimeout(r, ms));
      },
      launchExeOnce: () => {
        pendingBeforeLaunch = Boolean(health.readPendingUpdate()?.token);
        launchCalled = true;
        return 4242;
      },
      readHealthOk: (token) => {
        if (!launchCalled) return null;
        return { ok: true, token };
      },
    });

    const code = await runApplyUpdate({
      oldPid: 9999,
      installDir,
      exeName: "MaoyanOverlay.exe",
      targetVersion: "1.1",
      newExe: source,
      expectedSha256: expectedSha,
      previousVersion: "1.0",
    });

    const log = _getApplyActionLog();
    const launchIdx = log.indexOf("LAUNCH_NEW");
    const pendingIdx = log.indexOf("WRITE_PENDING");
    assert.ok(pendingIdx >= 0 && launchIdx > pendingIdx, `bad order: ${log.join(">")}`);
    assert.strictEqual(pendingBeforeLaunch, true, "pending must exist before launch");
    assert.strictEqual(code, 0);
    assert.ok(fs.existsSync(bak), ".bak kept until new app confirms health");

    process.env.PORTABLE_EXECUTABLE_FILE = target;
    const confirmed = await health.confirmUpdateHealth();
    assert.strictEqual(confirmed, true);
    assert.ok(!fs.existsSync(bak), ".bak removed after new app confirms health");
    assert.strictEqual(fs.readFileSync(versionFile, "utf-8"), "1.1");
    assert.strictEqual(fs.readFileSync(target, "utf-8"), newBinary);
    assert.ok(!health.readPendingUpdate());
    delete process.env.PORTABLE_EXECUTABLE_FILE;

    fs.rmSync(installDir, { recursive: true, force: true });
  });
  console.log("OK: apply order pending-before-launch and health flow");
}

async function testHealthTimeoutRollback() {
  await withTempEnv(async () => {
    reloadModules();
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-install-"));
    const {
      runApplyUpdate,
      _resetApplyTestState,
      _setApplyTestDeps,
    } = require("../lib/update/apply");
    const health = require("../lib/update/health");

    _resetApplyTestState();

    const oldBinary = "old-binary-v1.0";
    const newBinary = "new-binary-v1.1";
    const target = path.join(installDir, "MaoyanOverlay.exe");
    const source = path.join(installDir, "new.exe");
    const bak = path.join(installDir, "MaoyanOverlay.exe.bak");
    const versionFile = path.join(installDir, "version.txt");

    makeFile(target, oldBinary);
    makeFile(source, newBinary);
    makeFile(versionFile, "1.0");

    let killedPid = 0;
    _setApplyTestDeps({
      waitForPidExit: async () => "EXITED",
      killProcess: async (pid) => {
        killedPid = pid;
      },
      sleep: async () => {},
      launchExeOnce: () => 5151,
      readHealthOk: () => null,
    });

    const code = await runApplyUpdate({
      oldPid: 9999,
      installDir,
      exeName: "MaoyanOverlay.exe",
      targetVersion: "1.1",
      newExe: source,
      expectedSha256: sha256Of(newBinary),
      previousVersion: "1.0",
    });

    assert.strictEqual(code, 10);
    assert.strictEqual(killedPid, 5151);
    assert.strictEqual(fs.readFileSync(target, "utf-8"), oldBinary);
    assert.ok(!fs.existsSync(bak));
    assert.strictEqual(fs.readFileSync(versionFile, "utf-8"), "1.0");
    assert.ok(!health.readPendingUpdate());
    fs.rmSync(installDir, { recursive: true, force: true });
  });
  console.log("OK: health timeout rolls back exe and version.txt");
}

async function testStalePendingShaRejected() {
  await withTempEnv(async () => {
    reloadModules();
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-install-"));
    const health = require("../lib/update/health");
    const { hashFile } = require("../lib/update/downloader");

    const exePath = path.join(installDir, "MaoyanOverlay.exe");
    const bak = path.join(installDir, "MaoyanOverlay.exe.bak");
    makeFile(exePath, "old-live-binary");
    makeFile(bak, "backup-old");

    health.writePendingUpdate({
      token: "stale-token",
      installDir,
      exeName: "MaoyanOverlay.exe",
      targetVersion: "9.9",
      previousVersion: "1.0",
      expectedSha256: "deadbeef".repeat(8),
    });
    assert.ok(health.readPendingUpdate(), "pending must exist before confirm");

    process.env.PORTABLE_EXECUTABLE_FILE = exePath;
    delete require.cache[require.resolve("../lib/update/paths")];
    delete require.cache[require.resolve("../lib/update/health")];
    const healthLive = require("../lib/update/health");

    const ok = await healthLive.confirmUpdateHealth();
    assert.strictEqual(ok, false);
    assert.ok(fs.existsSync(bak), "stale pending must not delete backup");
    assert.ok(healthLive.readPendingUpdate(), "stale pending must remain after failed confirm");
    delete process.env.PORTABLE_EXECUTABLE_FILE;
    fs.rmSync(installDir, { recursive: true, force: true });
  });
  console.log("OK: stale pending rejected by sha256 mismatch");
}

async function testPendingBlocksSecondReplace() {
  await withTempEnv(async () => {
    reloadModules();
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-install-"));
    const { replaceExe } = require("../lib/update/apply");
    const health = require("../lib/update/health");

    makeFile(path.join(installDir, "MaoyanOverlay.exe"), "current");
    makeFile(path.join(installDir, "MaoyanOverlay.exe.bak"), "backup");
    makeFile(path.join(installDir, "new.exe"), "next");
    health.writePendingUpdate({
      token: "block",
      installDir,
      exeName: "MaoyanOverlay.exe",
      targetVersion: "2.0",
      expectedSha256: "aa",
    });

    assert.throws(
      () => replaceExe(path.join(installDir, "new.exe"), installDir, "MaoyanOverlay.exe"),
      /UPDATE_PENDING_HEALTH/,
    );
    fs.rmSync(installDir, { recursive: true, force: true });
  });
  console.log("OK: pending health blocks second replace");
}

async function main() {
  await testApplyOrderAndHealthFlow();
  await testHealthTimeoutRollback();
  await testStalePendingShaRejected();
  await testPendingBlocksSecondReplace();
  console.log("\nALL PASSED (updater health rollback)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
