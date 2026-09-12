/**
 * 将后台管理服务部署到远程 Linux 服务器
 * 用法: node deploy/deploy-admin.js [--overwrite-settings]
 */
const fs = require("fs");
const path = require("path");
const { Client } = require("ssh2");

const HOST = process.env.DEPLOY_HOST || "47.108.21.50";
const USER = process.env.DEPLOY_USER || "root";
const credPath = path.join(__dirname, "aliyun.json");
const cred = fs.existsSync(credPath)
  ? JSON.parse(fs.readFileSync(credPath, "utf-8"))
  : {};
const PASS = process.env.DEPLOY_PASS || cred.deployPass || "";
const REMOTE_DIR = "/opt/maoyan-overlay-admin";
const ADMIN_PORT = 8780;

const ROOT = path.join(__dirname, "..");
const OVERWRITE_SETTINGS = process.argv.includes("--overwrite-settings");

const FILES = [
  "admin-server.js",
  "standalone-admin.js",
  "lib/settings.js",
  "lib/update-command.js",
  "admin/index.html",
  "admin/admin.js",
  "admin/admin.css",
  "ui/index.html",
  "ui/styles.css",
  "ui/admin-preview.js",
  "ui/settings-applier.js",
  "ui/dashboard-view.js",
  "ui/number-anim.js",
  "ui/data/movie-media.js",
  "ui/data/movie-media.json",
  "ui/assets/default-movie-poster.svg",
  "ui/fonts/harmonyos-sans.css",
  "ui/fonts/mtsi-font.css",
];

function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream
        .on("close", (code) => {
          if (code !== 0) reject(new Error(`命令失败(${code}): ${cmd}\n${out}`));
          else resolve(out);
        })
        .on("data", (d) => {
          out += d.toString();
          process.stdout.write(d);
        })
        .stderr.on("data", (d) => {
          out += d.toString();
          process.stderr.write(d);
        });
    });
  });
}

function uploadFile(sftp, local, remote) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve()));
  });
}

function mkdirp(sftp, dir) {
  return new Promise((resolve) => {
    sftp.mkdir(dir, (err) => {
      if (!err) return resolve();
      const parent = path.posix.dirname(dir);
      if (parent === dir) return resolve();
      mkdirp(sftp, parent).then(() => {
        sftp.mkdir(dir, () => resolve());
      });
    });
  });
}

async function deploy() {
  if (!PASS) {
    console.error("请设置环境变量 DEPLOY_PASS");
    process.exit(1);
  }

  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn
      .on("ready", resolve)
      .on("error", reject)
      .connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 20000 });
  });

  console.log(`已连接 ${USER}@${HOST}`);

  await exec(conn, `mkdir -p ${REMOTE_DIR}/lib ${REMOTE_DIR}/admin ${REMOTE_DIR}/ui/data ${REMOTE_DIR}/ui/assets ${REMOTE_DIR}/ui/fonts`);

  const sftp = await new Promise((resolve, reject) => {
    conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
  });

  for (const rel of FILES) {
    const local = path.join(ROOT, rel);
    const remote = `${REMOTE_DIR}/${rel.replace(/\\/g, "/")}`;
    const remoteDir = path.posix.dirname(remote);
    await mkdirp(sftp, remoteDir);
    console.log(`上传 ${rel}`);
    await uploadFile(sftp, local, remote);
  }

  const pkg = {
    name: "maoyan-overlay-admin",
    version: "1.0.0",
    private: true,
    main: "standalone-admin.js",
    scripts: { start: "node standalone-admin.js" },
    dependencies: { express: "^4.21.2" },
  };
  const pkgPath = path.join(ROOT, "deploy", ".package.json");
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  await uploadFile(sftp, pkgPath, `${REMOTE_DIR}/package.json`);

  const settingsPath = path.join(ROOT, "overlay-settings.json");
  const remoteSettings = `${REMOTE_DIR}/overlay-settings.json`;
  const remoteSettingsExists = await new Promise((resolve) => {
    sftp.stat(remoteSettings, (err) => resolve(!err));
  });

  if (OVERWRITE_SETTINGS && fs.existsSync(settingsPath)) {
    console.log("上传 overlay-settings.json（--overwrite-settings）");
    await uploadFile(sftp, settingsPath, remoteSettings);
  } else if (!remoteSettingsExists) {
    if (fs.existsSync(settingsPath)) {
      console.log("首次部署：初始化 overlay-settings.json");
      await uploadFile(sftp, settingsPath, remoteSettings);
    } else {
      console.log("首次部署：服务器将使用默认设置模板");
    }
  } else {
    console.log("保留服务器现有 overlay-settings.json（未使用 --overwrite-settings）");
  }

  const setupCmd = `
set -e
cd ${REMOTE_DIR}
export PATH="/usr/local/bin:/usr/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - || true
  yum install -y nodejs 2>/dev/null || apt-get update && apt-get install -y nodejs npm 2>/dev/null || true
fi
node -v || (echo "Node 未安装" && exit 1)
npm install --registry=https://registry.npmmirror.com --production
node -e "const s=require('./lib/settings'); if(!s.loadSettings().updatedAt) s.saveSettings({});"
if ! command -v pm2 >/dev/null 2>&1; then npm install -g pm2 --registry=https://registry.npmmirror.com; fi
pm2 delete maoyan-admin 2>/dev/null || true
MAOYAN_SETTINGS_PATH=${REMOTE_DIR}/overlay-settings.json ADMIN_PORT=${ADMIN_PORT} pm2 start standalone-admin.js --name maoyan-admin
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true
(firewall-cmd --permanent --add-port=${ADMIN_PORT}/tcp 2>/dev/null && firewall-cmd --reload 2>/dev/null) || true
(ufw allow ${ADMIN_PORT}/tcp 2>/dev/null) || true
curl -s http://127.0.0.1:${ADMIN_PORT}/health || echo "health check pending"
echo "DEPLOY_OK"
`;

  await exec(conn, setupCmd);
  conn.end();
  console.log(`\n部署完成: http://${HOST}:${ADMIN_PORT}`);
}

deploy().catch((e) => {
  console.error("部署失败:", e.message);
  process.exit(1);
});
