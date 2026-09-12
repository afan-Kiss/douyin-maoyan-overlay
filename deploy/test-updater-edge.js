/**
 * 更新回滚/恢复验收：node deploy/test-updater-edge.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  replaceExe,
  rollbackFromBackup,
  recoverInterruptedUpdate,
} = require("../lib/update/apply");

function makeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function testCopyFailureRollback() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-upd-"));
  const target = path.join(dir, "MaoyanOverlay.exe");
  const source = path.join(dir, "new.exe");
  makeFile(target, "old-binary");
  makeFile(source, "new-binary");

  const realCopy = fs.copyFileSync;
  fs.copyFileSync = () => {
    throw new Error("disk full");
  };
  try {
    assert.throws(() => replaceExe(source, dir, "MaoyanOverlay.exe"), /copy new exe failed/);
  } finally {
    fs.copyFileSync = realCopy;
  }
  assert.strictEqual(fs.readFileSync(target, "utf-8"), "old-binary");
  assert.ok(!fs.existsSync(path.join(dir, "MaoyanOverlay.exe.bak")));
  console.log("OK: copy failure rolls back to old exe");
}

function testRecoverMissingTargetFromBackup() {
  const { installedExeName } = require("../lib/update/paths");
  const exeName = installedExeName();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-upd-"));
  const target = path.join(dir, exeName);
  const bak = path.join(dir, `${exeName}.bak`);
  makeFile(bak, "restored-binary");
  recoverInterruptedUpdate(dir);
  assert.ok(fs.existsSync(target));
  assert.strictEqual(fs.readFileSync(target, "utf-8"), "restored-binary");
  console.log("OK: recover missing exe from .bak");
}

function testRollbackHelper() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-upd-"));
  const target = path.join(dir, "MaoyanOverlay.exe");
  const bak = path.join(dir, "MaoyanOverlay.exe.bak");
  makeFile(target, "broken-binary");
  makeFile(bak, "good-binary");
  const ok = rollbackFromBackup(target, bak, dir, "unit_test", "launch failed");
  assert.strictEqual(ok, true);
  assert.strictEqual(fs.readFileSync(target, "utf-8"), "good-binary");
  console.log("OK: rollback helper restores backup");
}

function main() {
  testCopyFailureRollback();
  testRecoverMissingTargetFromBackup();
  testRollbackHelper();
  console.log("\nALL PASSED (updater edge)");
}

main();
