/**
 * 打包并上传 MaoyanOverlay 到 47.108.21.50 静态更新目录
 * 用法: node deploy/upload-release.js [--skip-build]
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { Client } = require("ssh2");

const ROOT = path.join(__dirname, "..");
const cred = JSON.parse(fs.readFileSync(path.join(__dirname, "aliyun.json"), "utf-8"));
const HOST = process.env.DEPLOY_HOST || cred.deployHost || "47.108.21.50";
const USER = process.env.DEPLOY_USER || cred.deployUser || "root";
const PASS = process.env.DEPLOY_PASS || cred.deployPass || "";
const REMOTE_DIR = "/opt/maoyan-updates";
const PUBLIC_BASE = cred.updateServerUrl || "https://xiangyuzhubao.xyz";
const SKIP_BUILD = process.argv.includes("--skip-build");

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

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
        .stderr.on("data", (d) => process.stderr.write(d));
    });
  });
}

function uploadFile(sftp, local, remote) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve()));
  });
}

function buildRelease() {
  console.log("正在打包 MaoyanOverlay.exe …");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(__dirname, "build-release.ps1"),
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`build-release 失败 (${result.status})`);
}

async function ensureNginx(conn) {
  const snippet = fs.readFileSync(
    path.join(__dirname, "maoyan-updates.nginx.conf"),
    "utf-8",
  );
  const marker = "maoyan-updates.conf";
  await exec(conn, `mkdir -p ${REMOTE_DIR}`);
  await exec(conn, `cat > /etc/nginx/snippets/${marker} <<'EOF'\n${snippet}\nEOF`);
  for (const file of [
    "/etc/nginx/conf.d/xiangyu-portal.conf",
    "/etc/nginx/conf.d/xiangyu-portal-ssl.conf",
  ]) {
    await exec(
      conn,
      `grep -q '${marker}' ${file} || awk 'BEGIN{done=0} {print} !done && /client_max_body_size 50m;/ {print "    include /etc/nginx/snippets/${marker};"; done=1}' ${file} > ${file}.tmp && mv ${file}.tmp ${file}`,
    );
  }
  await exec(conn, "nginx -t && systemctl reload nginx");
}

async function pushUpdateCommand(conn, version) {
  const { createUpdateCommand } = require("../lib/update-command");
  const cmd = createUpdateCommand(`发布 v${version} 后自动推送`);
  const remotePath = "/opt/maoyan-overlay-admin/update-command.json";
  const localTmp = path.join(ROOT, "deploy", ".update-command.json");
  fs.writeFileSync(localTmp, `${JSON.stringify(cmd, null, 2)}\n`, "utf-8");
  const sftp = await new Promise((resolve, reject) => {
    conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
  });
  await uploadFile(sftp, localTmp, remotePath);
  console.log(`已下发云端更新指令: ${cmd.commandId}`);
}

async function main() {
  if (!PASS) throw new Error("缺少 deployPass，请检查 deploy/aliyun.json");

  if (!SKIP_BUILD) buildRelease();

  const exePath = path.join(ROOT, "dist", "MaoyanOverlay.exe");
  if (!fs.existsSync(exePath)) {
    throw new Error(`缺少安装包: ${exePath}，请先运行 build:release`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
  let version = String(pkg.version || "1.0.0");
  const verMatch = version.match(/^(\d+\.\d+)\.0+$/);
  if (verMatch) version = verMatch[1];

  const sha256 = await hashFile(exePath);
  const fileSize = fs.statSync(exePath).size;
  const base = PUBLIC_BASE.replace(/\/+$/, "");
  const uniqueName = `MaoyanOverlay-${version}-${sha256.slice(0, 12)}.exe`;
  const downloadUrl = `${base}/maoyan-updates/${uniqueName}`;
  const manifest = {
    version,
    fileName: uniqueName,
    fileSize: String(fileSize),
    sha256,
    chunkSize: 5 * 1024 * 1024,
    releaseNotes: `猫眼票房直播展示 v${version}`,
    downloadUrl,
    publishedAt: new Date().toISOString(),
  };

  const manifestPath = path.join(ROOT, "dist", "latest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn
      .on("ready", resolve)
      .on("error", reject)
      .connect({ host: HOST, port: 22, username: USER, password: PASS, readyTimeout: 30000 });
  });

  console.log(`已连接 ${USER}@${HOST}`);
  await ensureNginx(conn);

  const sftp = await new Promise((resolve, reject) => {
    conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
  });

  console.log(`上传 ${uniqueName} (${(fileSize / 1024 / 1024).toFixed(1)} MB) …`);
  await uploadFile(sftp, exePath, `${REMOTE_DIR}/${uniqueName}`);

  const remoteExe = `${REMOTE_DIR}/${uniqueName}`;
  const statOut = await exec(conn, `stat -c '%s' '${remoteExe}'`);
  const remoteSize = Number(String(statOut).trim());
  if (!Number.isFinite(remoteSize) || remoteSize !== fileSize) {
    throw new Error(
      `远程 EXE 大小校验失败: local=${fileSize} remote=${statOut.trim()}`,
    );
  }
  console.log(`远程 EXE 大小校验通过: ${remoteSize} bytes`);

  const exeVerify = await exec(
    conn,
    `curl -sk 'https://127.0.0.1/maoyan-updates/${uniqueName}' -H 'Host: xiangyuzhubao.xyz' -o /dev/null -w 'EXE_HTTP=%{http_code} SIZE=%{size_download}\\n'`,
  );
  const exeHttpMatch = /EXE_HTTP=(\d+)/.exec(exeVerify);
  const exeSizeMatch = /SIZE=(\d+)/.exec(exeVerify);
  const exeHttp = exeHttpMatch ? Number(exeHttpMatch[1]) : 0;
  const exeDownloaded = exeSizeMatch ? Number(exeSizeMatch[1]) : 0;
  if (exeHttp !== 200 || exeDownloaded !== fileSize) {
    throw new Error(
      `远程 EXE HTTP 校验失败: http=${exeHttp} size=${exeDownloaded} expected=${fileSize}`,
    );
  }
  console.log("远程 EXE HTTP/大小校验通过");

  const remoteManifestTmp = `${REMOTE_DIR}/latest.json.tmp`;
  const remoteManifest = `${REMOTE_DIR}/latest.json`;
  console.log("上传 latest.json（临时文件）…");
  await uploadFile(sftp, manifestPath, remoteManifestTmp);
  await exec(conn, `mv -f '${remoteManifestTmp}' '${remoteManifest}'`);

  const manifestVerify = await exec(
    conn,
    `curl -sk 'https://127.0.0.1/maoyan-updates/latest.json' -H 'Host: xiangyuzhubao.xyz'`,
  );
  const parsed = JSON.parse(manifestVerify);
  if (String(parsed.sha256).toLowerCase() !== sha256.toLowerCase()) {
    throw new Error("latest.json manifest sha256 校验失败");
  }
  if (String(parsed.fileName) !== uniqueName) {
    throw new Error("latest.json manifest fileName 校验失败");
  }
  console.log("latest.json manifest 校验通过");

  await pushUpdateCommand(conn, version);
  conn.end();

  console.log("\n=== 上传完成 ===");
  console.log(`版本: v${version}`);
  console.log(`下载: ${downloadUrl}`);
  console.log(`清单: ${base}/maoyan-updates/latest.json`);
  console.log(`SHA256: ${sha256}`);
  console.log("旧版 EXE 已保留在服务器目录，供已开始下载的客户端继续拉取");
}

main().catch((err) => {
  console.error("上传失败:", err.message);
  process.exit(1);
});
