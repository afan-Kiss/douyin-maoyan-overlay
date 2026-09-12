const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { getRealExecutablePath, installedExeName } = require("./paths");
const { writePendingUpdate, generateHealthToken } = require("./health");

const APPLY_UPDATE_ARG = "--agent-apply-update";
const WAIT_OLD_PROCESS_TIMEOUT_SECS = 30;
const FILE_UNLOCK_RETRIES = 30;
const FILE_UNLOCK_DELAY_MS = 200;

function applyLog(installDir, line) {
  const logPath = path.join(installDir, "apply-update.log");
  const ts = new Date().toLocaleString("zh-CN", { hour12: false });
  try {
    fs.appendFileSync(logPath, `[${ts}] ${line}\n`, "utf-8");
  } catch {
    /* ignore */
  }
}

function parseApplyUpdateArgs(argv) {
  const args = Array.from(argv || []);
  if (!args.some((a) => a === APPLY_UPDATE_ARG)) return null;

  let oldPid = 0;
  let installDir = ".";
  let exeName = "MaoyanOverlay.exe";
  let targetVersion = "unknown";
  let newExe = null;

  for (const raw of args) {
    if (raw.startsWith("--old-pid=")) oldPid = parseInt(raw.slice(10), 10) || 0;
    else if (raw.startsWith("--install-dir=")) installDir = raw.slice(14);
    else if (raw.startsWith("--exe-name=")) exeName = raw.slice(11);
    else if (raw.startsWith("--version=")) targetVersion = raw.slice(10);
    else if (raw.startsWith("--new-exe=")) newExe = raw.slice(10);
  }

  return { oldPid, installDir, exeName, targetVersion, newExe };
}

function waitForPidExitWindows(pid, timeoutMs) {
  return new Promise((resolve) => {
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
$targetPid = ${pid}
$deadline = (Get-Date).AddMilliseconds(${timeoutMs})
while ((Get-Date) -lt $deadline) {
  $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if (-not $p) { Write-Output 'EXITED'; exit 0 }
  Start-Sleep -Milliseconds 200
}
Write-Output 'TIMEOUT'
exit 3
`;
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("close", (code) => {
      if (out.includes("EXITED") || code === 0) resolve("EXITED");
      else if (out.includes("TIMEOUT") || code === 3) resolve("TIMEOUT");
      else resolve("ERROR");
    });
    child.on("error", () => resolve("ERROR"));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFileUnlocked(filePath, installDir) {
  for (let attempt = 1; attempt <= FILE_UNLOCK_RETRIES; attempt += 1) {
    try {
      const fd = fs.openSync(filePath, "r+");
      fs.closeSync(fd);
      applyLog(installDir, `UPDATE_FILE_UNLOCKED ${filePath} attempt=${attempt}`);
      return true;
    } catch (error) {
      if (attempt === FILE_UNLOCK_RETRIES) {
        applyLog(
          installDir,
          `UPDATE_FILE_LOCK_TIMEOUT ${filePath}: ${error.message}`,
        );
        return false;
      }
      await sleep(FILE_UNLOCK_DELAY_MS);
    }
  }
  return false;
}

function rollbackFromBackup(target, bak, installDir, step, reason) {
  if (!fs.existsSync(bak)) {
    applyLog(
      installDir,
      `UPDATE_ROLLBACK_SKIP step=${step} targetExe=${target} backupExe=${bak} error=${reason} rollback=missing_backup`,
    );
    return false;
  }
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    fs.renameSync(bak, target);
    applyLog(
      installDir,
      `UPDATE_ROLLBACK_OK step=${step} targetExe=${target} backupExe=${bak} error=${reason}`,
    );
    return true;
  } catch (error) {
    applyLog(
      installDir,
      `UPDATE_ROLLBACK_FAILED step=${step} targetExe=${target} backupExe=${bak} error=${reason} rollbackError=${error.message}`,
    );
    return false;
  }
}

function replaceExe(source, installDir, exeName) {
  if (!fs.existsSync(source)) {
    throw new Error(`new exe missing: ${source}`);
  }
  const target = path.join(installDir, exeName);
  const bak = path.join(installDir, `${exeName}.bak`);

  applyLog(
    installDir,
    `UPDATE_REPLACE_BEGIN targetExe=${target} newExe=${source} backupExe=${bak} step=prepare`,
  );

  try {
    if (fs.existsSync(bak)) fs.unlinkSync(bak);
  } catch (error) {
    applyLog(installDir, `UPDATE_REPLACE_WARN step=clear_old_backup backupExe=${bak} error=${error.message}`);
  }

  if (fs.existsSync(target)) {
    applyLog(installDir, `UPDATE_REPLACE step=rename_to_backup targetExe=${target} backupExe=${bak}`);
    fs.renameSync(target, bak);
  }

  try {
    applyLog(installDir, `UPDATE_REPLACE step=copy_new targetExe=${target} newExe=${source}`);
    fs.copyFileSync(source, target);
    applyLog(installDir, `UPDATE_REPLACE_OK targetExe=${target} newExe=${source} backupExe=${bak}`);
    return { target, bak };
  } catch (error) {
    rollbackFromBackup(target, bak, installDir, "copy_new", error.message);
    throw new Error(`copy new exe failed: ${error.message}`);
  }
}

function launchExeOnce(target, installDir) {
  if (!fs.existsSync(target)) {
    throw new Error(`target missing after replace: ${target}`);
  }
  const child = spawn(target, [], {
    cwd: installDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function runApplyUpdate(args) {
  const installDir = path.resolve(args.installDir);
  applyLog(
    installDir,
    `APPLY_STARTED oldPid=${args.oldPid} version=${args.targetVersion} exe=${args.exeName}`,
  );

  if (!args.oldPid) {
    applyLog(installDir, "UPDATE_FAILED invalid oldPid=0");
    return 2;
  }
  if (args.oldPid === process.pid) {
    applyLog(installDir, `UPDATE_FAILED oldPid equals helper pid=${process.pid}`);
    return 2;
  }

  const outcome = await waitForPidExitWindows(
    args.oldPid,
    WAIT_OLD_PROCESS_TIMEOUT_SECS * 1000,
  );
  if (outcome === "TIMEOUT") {
    applyLog(
      installDir,
      `UPDATE_WAIT_OLD_PROCESS_TIMEOUT pid=${args.oldPid} secs=${WAIT_OLD_PROCESS_TIMEOUT_SECS}`,
    );
    return 3;
  }
  if (outcome === "ERROR") {
    applyLog(installDir, "UPDATE_FAILED wait error");
    return 4;
  }

  applyLog(installDir, `UPDATE_OLD_PROCESS_EXITED pid=${args.oldPid}`);

  const source = args.newExe || getRealExecutablePath();
  const target = path.join(installDir, args.exeName);

  const unlocked = await waitForFileUnlocked(target, installDir);
  if (!unlocked && fs.existsSync(target)) {
    applyLog(installDir, `UPDATE_FAILED file still locked: ${target}`);
    return 5;
  }

  try {
    replaceExe(source, installDir, args.exeName);
  } catch (error) {
    applyLog(installDir, `UPDATE_FAILED replace: ${error.message}`);
    return 6;
  }
  applyLog(installDir, "UPDATE_REPLACED");

  try {
    fs.writeFileSync(path.join(installDir, "version.txt"), args.targetVersion, "utf-8");
  } catch (error) {
    applyLog(installDir, `UPDATE_FAILED write version.txt: ${error.message}`);
    return 7;
  }

  const bak = path.join(installDir, `${args.exeName}.bak`);
  try {
    launchExeOnce(target, installDir);
  } catch (error) {
    applyLog(
      installDir,
      `UPDATE_FAILED step=restart targetExe=${target} newExe=${source} backupExe=${bak} error=${error.message}`,
    );
    rollbackFromBackup(target, bak, installDir, "restart", error.message);
    return 8;
  }
  const healthToken = generateHealthToken();
  try {
    writePendingUpdate({
      token: healthToken,
      installDir,
      exeName: args.exeName,
      targetVersion: args.targetVersion,
    });
    applyLog(
      installDir,
      `UPDATE_PENDING_HEALTH token=${healthToken} backupKept=${bak}`,
    );
  } catch (error) {
    applyLog(installDir, `UPDATE_FAILED write pending health: ${error.message}`);
    rollbackFromBackup(target, bak, installDir, "pending_health", error.message);
    return 9;
  }

  applyLog(installDir, `UPDATE_RESTARTED ${target} awaitingHealth=${healthToken}`);

  if (path.resolve(source) !== path.resolve(target)) {
    try {
      fs.unlinkSync(source);
    } catch {
      /* ignore */
    }
  }

  try {
    fs.unlinkSync(path.join(installDir, "_apply_update.bat"));
  } catch {
    /* ignore */
  }

  applyLog(installDir, "UPDATE_DONE");
  return 0;
}

function scheduleApplyAndExit(newExe, installDir, targetVersion) {
  const exeName = installedExeName();
  const oldPid = process.pid;

  if (!fs.existsSync(newExe)) {
    throw new Error(`更新包不存在: ${newExe}`);
  }

  try {
    fs.unlinkSync(path.join(installDir, "_apply_update.bat"));
  } catch {
    /* ignore */
  }

  applyLog(
    installDir,
    `UPDATE_APPLY_SCHEDULED oldPid=${oldPid} new=${newExe} version=${targetVersion} targetExe=${path.join(installDir, exeName)}`,
  );

  const args = [
    APPLY_UPDATE_ARG,
    `--old-pid=${oldPid}`,
    `--install-dir=${installDir}`,
    `--exe-name=${exeName}`,
    `--version=${targetVersion}`,
    `--new-exe=${newExe}`,
  ];

  const child = spawn(newExe, args, {
    cwd: installDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  process.exit(0);
}

function cleanupLegacyApplyArtifacts(installDir) {
  for (const name of ["_apply_update.bat", "apply_update.bat"]) {
    try {
      fs.unlinkSync(path.join(installDir, name));
    } catch {
      /* ignore */
    }
  }
}

function cleanupSuccessfulUpdateBackup(installDir, exeName = installedExeName()) {
  const bak = path.join(installDir, `${exeName}.bak`);
  try {
    if (fs.existsSync(bak)) fs.unlinkSync(bak);
  } catch {
    /* ignore */
  }
}

function recoverInterruptedUpdate(installDir) {
  const exeName = installedExeName();
  const target = path.join(installDir, exeName);
  const bak = path.join(installDir, `${exeName}.bak`);
  const staleNew = path.join(installDir, `${exeName}.new`);

  if (!fs.existsSync(target) && fs.existsSync(bak)) {
    try {
      fs.renameSync(bak, target);
      applyLog(
        installDir,
        `UPDATE_RECOVER_OK step=restore_missing_target targetExe=${target} backupExe=${bak}`,
      );
    } catch (error) {
      applyLog(
        installDir,
        `UPDATE_RECOVER_FAILED step=restore_missing_target targetExe=${target} backupExe=${bak} error=${error.message}`,
      );
    }
  }

  if (fs.existsSync(staleNew)) {
    try {
      fs.unlinkSync(staleNew);
      applyLog(installDir, `UPDATE_RECOVER step=remove_stale_new newExe=${staleNew}`);
    } catch (error) {
      applyLog(installDir, `UPDATE_RECOVER_WARN step=remove_stale_new newExe=${staleNew} error=${error.message}`);
    }
  }
}

module.exports = {
  APPLY_UPDATE_ARG,
  WAIT_OLD_PROCESS_TIMEOUT_SECS,
  parseApplyUpdateArgs,
  runApplyUpdate,
  scheduleApplyAndExit,
  cleanupLegacyApplyArtifacts,
  cleanupSuccessfulUpdateBackup,
  recoverInterruptedUpdate,
  rollbackFromBackup,
  replaceExe,
};
