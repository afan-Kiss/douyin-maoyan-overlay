const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// 部署在 /opt/maoyan-overlay-admin 时落在项目根目录
const COMMAND_PATH =
  process.env.MAOYAN_UPDATE_COMMAND_PATH ||
  path.join(__dirname, "..", "update-command.json");

const DEFAULT_COMMAND = {
  commandId: "",
  type: "",
  issuedAt: 0,
  message: "",
};

function readCommandFile() {
  try {
    if (!fs.existsSync(COMMAND_PATH)) return { ...DEFAULT_COMMAND };
    return { ...DEFAULT_COMMAND, ...JSON.parse(fs.readFileSync(COMMAND_PATH, "utf-8")) };
  } catch {
    return { ...DEFAULT_COMMAND };
  }
}

function writeCommandFile(data) {
  fs.writeFileSync(COMMAND_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function createUpdateCommand(message = "管理员推送更新") {
  return {
    commandId: crypto.randomBytes(8).toString("hex"),
    type: "agent.update",
    issuedAt: Date.now(),
    message,
  };
}

function issueUpdateCommand(message = "管理员推送更新") {
  const cmd = createUpdateCommand(message);
  writeCommandFile(cmd);
  return cmd;
}

function getPendingCommand(lastAck = "") {
  const cmd = readCommandFile();
  if (!cmd.commandId || cmd.type !== "agent.update") {
    return null;
  }
  if (String(lastAck) === String(cmd.commandId)) {
    return null;
  }
  return cmd;
}

module.exports = {
  COMMAND_PATH,
  createUpdateCommand,
  issueUpdateCommand,
  getPendingCommand,
  readCommandFile,
};
