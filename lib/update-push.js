const fs = require("fs");
const path = require("path");

const { APP_DIR_NAME, isPackagedApp } = require("./update/paths");

const ACK_FILE = path.join(
  process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd(),
  APP_DIR_NAME,
  "update-ack.json",
);

function loadLastAck() {
  try {
    if (!fs.existsSync(ACK_FILE)) return "";
    const data = JSON.parse(fs.readFileSync(ACK_FILE, "utf-8"));
    return String(data.lastAckCommandId || "");
  } catch {
    return "";
  }
}

function saveLastAck(commandId) {
  const dir = path.dirname(ACK_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    ACK_FILE,
    `${JSON.stringify({ lastAckCommandId: String(commandId || ""), ackAt: Date.now() }, null, 2)}\n`,
    "utf-8",
  );
}

async function ackRemoteCommand(base, commandId) {
  const url = `${base.replace(/\/$/, "")}/api/update/ack`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    /* 本地 ack 已足够，服务端 ack 可选 */
  }
  saveLastAck(commandId);
}

async function pollUpdateCommand(base, lastAck) {
  const root = base.replace(/\/$/, "");
  const url = `${root}/api/update/command?lastAck=${encodeURIComponent(lastAck || "")}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.command || null;
}

function isAgentUpdateCommand(command) {
  if (!command) return false;
  return command.type === "agent.update" && Boolean(command.commandId);
}

/**
 * 轮询后台推送的 agent.update 指令，收到后触发下载安装（同微信 Agent 云端推送）。
 */
function startUpdatePush(remoteAdminUrl, updateManager, options = {}) {
  let stopped = false;
  let busy = false;
  let timer = null;
  const log = options.log || ((msg) => console.log(msg));
  const base = String(remoteAdminUrl || "").replace(/\/$/, "");
  if (!base) return stop;

  const tick = async () => {
    if (stopped || busy || !updateManager) return;
    if (updateManager.isBusy()) return;

    busy = true;
    try {
      let lastAck = loadLastAck();
      const command = await pollUpdateCommand(base, lastAck);
      if (!isAgentUpdateCommand(command)) return;

      lastAck = loadLastAck();
      if (String(command.commandId) === lastAck) return;

      log(`收到云端更新指令 (${command.commandId})，正在检查更新…`);

      if (!isPackagedApp()) {
        log("开发模式，已跳过云端推送更新");
        await ackRemoteCommand(base, command.commandId);
        return;
      }

      try {
        const updated = await updateManager.checkAndApplyIfAvailable();
        if (updated) {
          log("云端触发更新：已开始安装新版本，即将重启…");
          saveLastAck(command.commandId);
          return;
        }
        log("云端触发更新：当前已是最新版本");
        await ackRemoteCommand(base, command.commandId);
      } catch (error) {
        const msg = error?.message || String(error);
        if (msg.includes("进行中")) {
          log("云端触发更新：已有更新任务进行中，稍后重试");
          return;
        }
        log(`云端触发更新失败：${msg}（将重试）`);
      }
    } catch {
      /* 网络异常时静默重试 */
    } finally {
      busy = false;
    }
  };

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  tick();
  timer = setInterval(tick, options.intervalMs || 2000);
  return stop;
}

module.exports = {
  startUpdatePush,
  loadLastAck,
  saveLastAck,
  ackRemoteCommand,
  pollUpdateCommand,
  isAgentUpdateCommand,
};
