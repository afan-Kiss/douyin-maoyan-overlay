/**
 * 在 xiangyuzhubao.xyz nginx 上反代 agent-updates / releases 到微信聊天平台
 * 用法: node deploy/setup-update-proxy.js
 */
const fs = require("fs");
const path = require("path");
const { Client } = require("ssh2");

const credPath = path.join(__dirname, "aliyun.json");
const cred = JSON.parse(fs.readFileSync(credPath, "utf-8"));
const HOST = process.env.DEPLOY_HOST || cred.deployHost || "47.108.21.50";
const PASS = process.env.DEPLOY_PASS || cred.deployPass || "";
const SNIPPET = fs.readFileSync(path.join(__dirname, "maoyan-update.nginx.conf"), "utf-8");
const MARKER = "maoyan-update.conf";

function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream
        .on("close", (code) => (code ? reject(new Error(out || `exit ${code}`)) : resolve(out)))
        .on("data", (d) => {
          out += d.toString();
          process.stdout.write(d);
        })
        .stderr.on("data", (d) => process.stderr.write(d));
    });
  });
}

async function main() {
  if (!PASS) throw new Error("缺少 deployPass，请检查 deploy/aliyun.json");

  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn
      .on("ready", resolve)
      .on("error", reject)
      .connect({ host: HOST, port: 22, username: "root", password: PASS, readyTimeout: 20000 });
  });

  await exec(conn, `cat > /etc/nginx/snippets/${MARKER} <<'EOF'\n${SNIPPET}\nEOF`);

  for (const file of [
    "/etc/nginx/conf.d/xiangyu-portal.conf",
    "/etc/nginx/conf.d/xiangyu-portal-ssl.conf",
  ]) {
    await exec(
      conn,
      `grep -q '${MARKER}' ${file} || awk 'BEGIN{done=0} {print} !done && /client_max_body_size 50m;/ {print "    include /etc/nginx/snippets/${MARKER};"; done=1}' ${file} > ${file}.tmp && mv ${file}.tmp ${file}`,
    );
  }

  await exec(conn, "nginx -t && systemctl reload nginx");
  await exec(
    conn,
    `curl -sk 'https://127.0.0.1/api/agent-updates/latest?platform=maoyan-win-x64&currentVersion=1.0' -H 'Host: xiangyuzhubao.xyz'`,
  );
  conn.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
