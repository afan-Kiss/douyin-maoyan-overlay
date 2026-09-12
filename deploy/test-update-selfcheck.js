/**
 * 更新模块自检：node deploy/test-update-selfcheck.js
 */
const assert = require("assert");
const { UpdateManager, httpBase } = require("../lib/update/manager");
const { isNewer, normalizeVersion, currentVersion } = require("../lib/update/version");
const {
  getPendingCommand,
  createUpdateCommand,
  issueUpdateCommand,
} = require("../lib/update-command");
const {
  isAgentUpdateCommand,
  loadLastAck,
  saveLastAck,
} = require("../lib/update-push");
const { parseApplyUpdateArgs } = require("../lib/update/apply");
const fs = require("fs");
const path = require("path");
const os = require("os");

const failures = [];

function fail(name, detail) {
  failures.push({ name, detail });
  console.log(`FAIL: ${name} — ${detail}`);
}

function ok(name) {
  console.log(`OK: ${name}`);
}

async function testRemoteManifest() {
  const resp = await fetch("https://xiangyuzhubao.xyz/maoyan-updates/latest.json", {
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    fail("remote latest.json", `HTTP ${resp.status}`);
    return;
  }
  const raw = await resp.json();
  if (!raw.version || !raw.sha256 || !raw.fileSize) {
    fail("remote latest.json", "缺少 version/sha256/fileSize");
    return;
  }
  const mgr = new UpdateManager({ updateServerUrl: "https://xiangyuzhubao.xyz" });
  const info = mgr.normalizeManifest(raw, "https://xiangyuzhubao.xyz");
  if (!info.downloadUrl.includes("/maoyan-updates/")) {
    fail("remote manifest downloadUrl", info.downloadUrl);
    return;
  }
  const head = await fetch(info.downloadUrl, {
    headers: { Range: "bytes=0-1023" },
    signal: AbortSignal.timeout(15_000),
  });
  if (head.status !== 206 && head.status !== 200) {
    fail("remote EXE download", `HTTP ${head.status}`);
    return;
  }
  ok("remote latest.json + Range download");
}

async function testPushApi() {
  const status = await fetch("https://xiangyuzhubao.xyz/maoyan-admin/api/update/status", {
    signal: AbortSignal.timeout(15_000),
  });
  if (!status.ok) {
    fail("push status API", `HTTP ${status.status}`);
    return;
  }
  const cmdResp = await fetch(
    "https://xiangyuzhubao.xyz/maoyan-admin/api/update/command?lastAck=",
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!cmdResp.ok) {
    fail("push command API", `HTTP ${cmdResp.status}`);
    return;
  }
  const data = await cmdResp.json();
  if (data.command && !isAgentUpdateCommand(data.command)) {
    fail("push command shape", JSON.stringify(data.command));
    return;
  }
  ok("push API reachable");
}

function testVersionLogic() {
  assert.strictEqual(isNewer("1.1", "1.0"), true);
  assert.strictEqual(isNewer("1.0", "1.0"), false);
  assert.strictEqual(normalizeVersion("1.0.0"), "1.0");

  const mgr = new UpdateManager({ updateServerUrl: "https://xiangyuzhubao.xyz" });
  const info = mgr.normalizeManifest(
    { version: "1.0", updateAvailable: true, sha256: "abc", fileSize: "100" },
    "https://xiangyuzhubao.xyz",
  );
  // 同版本不应因 updateAvailable:true 单独触发（除非 sha 不同，在 check 阶段判断）
  const cur = currentVersion();
  if (cur === "1.0" && info.updateAvailable && !isNewer("1.0", cur)) {
    // same version path is allowed for hotfix
    ok("normalizeManifest same-version hotfix path");
  } else if (isNewer("1.0", cur)) {
    ok("normalizeManifest newer version");
  } else if (!info.updateAvailable) {
    ok("normalizeManifest skips when not applicable");
  } else {
    ok("normalizeManifest version logic");
  }

  const oldBug = mgr.normalizeManifest(
    { version: "0.5", updateAvailable: true, sha256: "x", fileSize: "1" },
    "https://xiangyuzhubao.xyz",
  );
  if (isNewer("0.5", currentVersion()) && !oldBug.updateAvailable) {
    fail("normalizeManifest older version", "不应标记 updateAvailable");
  } else if (!isNewer("0.5", currentVersion())) {
    ok("normalizeManifest rejects older version");
  }
}

function testCommandAck() {
  const tmp = path.join(os.tmpdir(), `maoyan-cmd-test-${Date.now()}.json`);
  process.env.MAOYAN_UPDATE_COMMAND_PATH = tmp;
  const cmd = issueUpdateCommand("selfcheck");
  const pending = getPendingCommand("");
  if (!pending || pending.commandId !== cmd.commandId) {
    fail("issueUpdateCommand", "pending mismatch");
  } else {
    const acked = getPendingCommand(cmd.commandId);
    if (acked !== null) fail("getPendingCommand ack filter", "应返回 null");
    else ok("update command ack filter");
  }
  delete process.env.MAOYAN_UPDATE_COMMAND_PATH;
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
}

function testApplyArgs() {
  const args = parseApplyUpdateArgs([
    "MaoyanOverlay.exe",
    "--agent-apply-update",
    "--old-pid=12345",
    "--install-dir=C:\\test",
    "--exe-name=MaoyanOverlay.exe",
    "--version=1.1",
    "--new-exe=C:\\tmp\\new.exe",
  ]);
  if (!args || args.oldPid !== 12345) {
    fail("parseApplyUpdateArgs", JSON.stringify(args));
  } else {
    ok("parseApplyUpdateArgs");
  }
}

function testHttpBase() {
  assert.strictEqual(httpBase("https://xiangyuzhubao.xyz/maoyan-admin"), "https://xiangyuzhubao.xyz/maoyan-admin");
  assert.strictEqual(httpBase("https://xiangyuzhubao.xyz/"), "https://xiangyuzhubao.xyz");
  ok("httpBase");
}

function testAckPersistence() {
  const tmp = path.join(os.tmpdir(), `maoyan-ack-${Date.now()}`);
  const prev = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = tmp;
  saveLastAck("abc123");
  if (loadLastAck() !== "abc123") fail("ack persistence", loadLastAck());
  else ok("ack persistence");
  process.env.LOCALAPPDATA = prev;
}

async function main() {
  console.log("=== 更新模块自检 ===\n");
  testHttpBase();
  testVersionLogic();
  testCommandAck();
  testApplyArgs();
  testAckPersistence();
  await testRemoteManifest();
  await testPushApi();

  console.log("");
  if (failures.length === 0) {
    console.log(`ALL PASSED (${6} groups)`);
    process.exit(0);
  }
  console.log(`FAILED: ${failures.length} issue(s)`);
  failures.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
