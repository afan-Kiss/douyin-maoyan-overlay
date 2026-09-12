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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForPending(health, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = health.readPendingUpdate();
    if (pending?.token) return pending;
    await sleep(20);
  }
  throw new Error("pending update never appeared");
}

async function testApplyOrderAndHealthHandshake() {
  await withTempEnv(async () => {
    reloadModules();
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-install-"));
    const health = require("../lib/update/health");
    const realConsumeHealthOk = health.consumeHealthOk;
    const {
      runApplyUpdate,
      _resetApplyTestState,
      _setApplyTestDeps,
      _getApplyActionLog,
    } = require("../lib/update/apply");

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

    let pendingBeforeLaunch = false;
    let allowHelperConsume = false;

    _setApplyTestDeps({
      waitForPidExit: async () => "EXITED",
      killProcess: async () => true,
      sleep,
      consumeHealthOk: (token) => {
        if (!allowHelperConsume) return null;
        return realConsumeHealthOk(token);
      },
      launchExeOnce: () => {
        pendingBeforeLaunch = Boolean(health.readPendingUpdate()?.token);
        return 4242;
      },
    });

    process.env.PORTABLE_EXECUTABLE_FILE = target;

    const applyPromise = runApplyUpdate({
      oldPid: 9999,
      installDir,
      exeName: "MaoyanOverlay.exe",
      targetVersion: "1.1",
      newExe: source,
      expectedSha256: expectedSha,
      previousVersion: "1.0",
    });

    const pending = await waitForPending(health);
    const token = pending.token;
    assert.strictEqual(pendingBeforeLaunch, true, "pending must exist before launch");
    assert.ok(!fs.existsSync(health.healthOkPath(token)), "health ack must not exist before confirm");

    const confirmed = await health.confirmUpdateHealth();
    assert.strictEqual(confirmed, true);
    assert.ok(
      fs.existsSync(health.healthOkPath(token)),
      "confirmUpdateHealth must leave health ack for helper to consume",
    );

    allowHelperConsume = true;

    const code = await applyPromise;
    const log = _getApplyActionLog();
    const launchIdx = log.indexOf("LAUNCH_NEW");
    const pendingIdx = log.indexOf("WRITE_PENDING");
    assert.ok(pendingIdx >= 0 && launchIdx > pendingIdx, `bad order: ${log.join(">")}`);
    assert.strictEqual(code, 0);
    assert.ok(!fs.existsSync(bak));
    assert.ok(!health.readPendingUpdate());
    assert.ok(!fs.existsSync(health.healthOkPath(token)), "helper must consume health ack");
    assert.strictEqual(fs.readFileSync(versionFile, "utf-8"), "1.1");
    assert.strictEqual(fs.readFileSync(target, "utf-8"), newBinary);

    delete process.env.PORTABLE_EXECUTABLE_FILE;
    fs.rmSync(installDir, { recursive: true, force: true });
  });
  console.log("OK: real confirmUpdateHealth handshake consumed by helper");
}

async function testHealthTimeoutRollbackSuccess() {
  await withTempEnv(async () => {
    reloadModules();
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-install-"));
    const {
      runApplyUpdate,
      _resetApplyTestState,
      _setApplyTestDeps,
      _setHealthWaitTimeoutMs,
    } = require("../lib/update/apply");
    const health = require("../lib/update/health");

    _resetApplyTestState();
    _setHealthWaitTimeoutMs(400);

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
        return true;
      },
      sleep,
      launchExeOnce: () => 5151,
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
  console.log("OK: health timeout rollback success path");
}

async function testRollbackBlockedWhenKillFails() {
  await withTempEnv(async () => {
    reloadModules();
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-install-"));
    const {
      rollbackFailedHealthUpdate,
      _resetApplyTestState,
      _setApplyTestDeps,
      UPDATE_ROLLBACK_BLOCKED_PROCESS_ALIVE,
    } = require("../lib/update/apply");
    const health = require("../lib/update/health");

    _resetApplyTestState();
    makeFile(path.join(installDir, "MaoyanOverlay.exe"), "broken-new");
    makeFile(path.join(installDir, "MaoyanOverlay.exe.bak"), "old-good");
    makeFile(path.join(installDir, "version.txt"), "1.0");
    health.writePendingUpdate({
      token: "blocked",
      installDir,
      exeName: "MaoyanOverlay.exe",
      targetVersion: "1.1",
      previousVersion: "1.0",
      expectedSha256: "aa",
    });

    _setApplyTestDeps({
      killProcess: async () => false,
      sleep,
    });

    const code = await rollbackFailedHealthUpdate({
      installDir,
      exeName: "MaoyanOverlay.exe",
      target: path.join(installDir, "MaoyanOverlay.exe"),
      bak: path.join(installDir, "MaoyanOverlay.exe.bak"),
      previousVersion: "1.0",
      newPid: 7777,
      reason: "test kill blocked",
    });

    assert.strictEqual(code, UPDATE_ROLLBACK_BLOCKED_PROCESS_ALIVE);
    assert.ok(fs.existsSync(path.join(installDir, "MaoyanOverlay.exe.bak")));
    assert.ok(health.readPendingUpdate());
    assert.strictEqual(fs.readFileSync(path.join(installDir, "MaoyanOverlay.exe"), "utf-8"), "broken-new");
    fs.rmSync(installDir, { recursive: true, force: true });
  });
  console.log("OK: kill failure keeps pending and bak");
}

async function testRollbackBlockedWhenRestoreFails() {
  await withTempEnv(async () => {
    reloadModules();
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-install-"));
    const {
      rollbackFailedHealthUpdate,
      _resetApplyTestState,
      _setApplyTestDeps,
      UPDATE_ROLLBACK_FAILED,
    } = require("../lib/update/apply");
    const health = require("../lib/update/health");

    _resetApplyTestState();
    const target = path.join(installDir, "MaoyanOverlay.exe");
    makeFile(target, "broken-new");
    makeFile(path.join(installDir, "version.txt"), "1.0");
    health.writePendingUpdate({
      token: "restore-fail",
      installDir,
      exeName: "MaoyanOverlay.exe",
      targetVersion: "1.1",
      previousVersion: "1.0",
      expectedSha256: "aa",
    });

    _setApplyTestDeps({
      killProcess: async () => true,
      sleep,
    });

    const code = await rollbackFailedHealthUpdate({
      installDir,
      exeName: "MaoyanOverlay.exe",
      target,
      bak: path.join(installDir, "MaoyanOverlay.exe.bak"),
      previousVersion: "1.0",
      newPid: 8888,
      reason: "test restore fail",
    });

    assert.strictEqual(code, UPDATE_ROLLBACK_FAILED);
    assert.ok(health.readPendingUpdate());
    assert.strictEqual(fs.readFileSync(target, "utf-8"), "broken-new");
    assert.strictEqual(fs.readFileSync(path.join(installDir, "version.txt"), "utf-8"), "1.0");
    fs.rmSync(installDir, { recursive: true, force: true });
  });
  console.log("OK: rollbackFromBackup failure keeps pending and bak");
}

async function testStalePendingShaRejected() {
  await withTempEnv(async () => {
    reloadModules();
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-install-"));
    const health = require("../lib/update/health");

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

    process.env.PORTABLE_EXECUTABLE_FILE = exePath;
    delete require.cache[require.resolve("../lib/update/paths")];
    delete require.cache[require.resolve("../lib/update/health")];
    const healthLive = require("../lib/update/health");

    const ok = await healthLive.confirmUpdateHealth();
    assert.strictEqual(ok, false);
    assert.ok(fs.existsSync(bak));
    assert.ok(healthLive.readPendingUpdate());
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
  await testApplyOrderAndHealthHandshake();
  await testHealthTimeoutRollbackSuccess();
  await testRollbackBlockedWhenKillFails();
  await testRollbackBlockedWhenRestoreFails();
  await testStalePendingShaRejected();
  await testPendingBlocksSecondReplace();
  console.log("\nALL PASSED (updater health rollback)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
