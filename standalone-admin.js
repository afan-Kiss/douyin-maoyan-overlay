const path = require("path");
const { startAdminServer } = require("./admin-server");
const { loadSettings, saveSettings } = require("./lib/settings");

process.env.MAOYAN_SETTINGS_PATH =
  process.env.MAOYAN_SETTINGS_PATH || path.join(__dirname, "overlay-settings.json");

if (!loadSettings().updatedAt) {
  saveSettings({});
}

const port = Number(process.env.ADMIN_PORT) || 8780;

startAdminServer({ port })
  .then((info) => {
    console.log(`远程后台已启动: http://0.0.0.0:${info.port}`);
  })
  .catch((err) => {
    console.error("后台启动失败:", err.message);
    process.exit(1);
  });
