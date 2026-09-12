const express = require("express");
const path = require("path");
const {
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  stripSensitiveSettings,
} = require("./lib/settings");
const {
  issueUpdateCommand,
  getPendingCommand,
  readCommandFile,
} = require("./lib/update-command");

let server = null;
let onChange = null;

function checkAuth(req, settings) {
  const pwd = String(req.headers["x-admin-token"] || req.query.token || "");
  const expected = String(settings.admin?.password || "");
  if (!expected) return true;
  return pwd === expected;
}

function startAdminServer(options = {}) {
  if (server) return server;

  onChange = options.onChange || null;
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token");
    if (_req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  const adminDir = path.join(__dirname, "admin");
  const uiDir = path.join(__dirname, "ui");
  app.use(express.static(adminDir));
  app.use("/ui", express.static(uiDir));

  app.get("/api/settings", (_req, res) => {
    res.json(stripSensitiveSettings(loadSettings()));
  });

  app.get("/api/settings/defaults", (_req, res) => {
    res.json(stripSensitiveSettings(DEFAULT_SETTINGS));
  });

  app.post("/api/settings", (req, res) => {
    const current = loadSettings();
    if (!checkAuth(req, current)) {
      res.status(401).json({ detail: "管理密码错误" });
      return;
    }
    try {
      const body = { ...(req.body || {}) };
      if (body.admin?.password === "***" || body.admin?.password === "") {
        delete body.admin.password;
      }
      const saved = saveSettings(body);
      onChange?.(saved);
      res.json({ ok: true, settings: stripSensitiveSettings(saved) });
    } catch (e) {
      res.status(500).json({ detail: e.message || "保存失败" });
    }
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/update/command", (req, res) => {
    const lastAck = String(req.query.lastAck || "");
    const command = getPendingCommand(lastAck);
    res.json({ command });
  });

  app.post("/api/update/ack", (req, res) => {
    const commandId = String(req.body?.commandId || "");
    const current = readCommandFile();
    if (current.commandId && commandId === current.commandId) {
      res.json({ ok: true, acked: commandId });
      return;
    }
    res.json({ ok: true, acked: commandId, note: "no_active_command" });
  });

  app.post("/api/update/push", (req, res) => {
    const current = loadSettings();
    if (!checkAuth(req, current)) {
      res.status(401).json({ detail: "管理密码错误" });
      return;
    }
    const message = String(req.body?.message || "管理员推送更新").trim();
    const command = issueUpdateCommand(message || "管理员推送更新");
    res.json({
      ok: true,
      sent: true,
      message: "已下发更新指令，在线客户端将在数秒内自动检查并安装",
      command,
    });
  });

  app.get("/api/update/status", (_req, res) => {
    res.json({ command: readCommandFile() });
  });

  const settings = loadSettings();
  const port =
    options.port !== undefined && options.port !== null
      ? options.port
      : settings.admin?.port || 8780;

  return new Promise((resolve, reject) => {
    server = app.listen(port, "0.0.0.0", () => {
      const actualPort = server.address()?.port || port;
      resolve({ port: actualPort, url: `http://127.0.0.1:${actualPort}` });
    });
    server.on("error", reject);
  });
}

function stopAdminServer() {
  if (!server) return;
  server.close();
  server = null;
}

module.exports = { startAdminServer, stopAdminServer };
