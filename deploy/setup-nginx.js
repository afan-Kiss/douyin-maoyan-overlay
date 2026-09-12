const fs = require("fs");
const path = require("path");
const { Client } = require("ssh2");

const HOST = process.env.DEPLOY_HOST || "47.108.21.50";
const USER = process.env.DEPLOY_USER || "root";
const PASS = process.env.DEPLOY_PASS || "";
const SNIPPET = fs.readFileSync(path.join(__dirname, "maoyan-admin.nginx.conf"), "utf-8");
const MARKER = "# maoyan-overlay-admin";

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

async function patchConfig(conn, file) {
  const check = await exec(conn, `test -f ${file} && grep -q '${MARKER}' ${file} && echo HAS || echo NO`);
  if (check.includes("HAS")) {
    console.log(`已存在: ${file}`);
    return;
  }
  const escaped = SNIPPET.replace(/'/g, `'\\''`);
  await exec(
    conn,
    `cp ${file} ${file}.bak-maoyan-admin && sed -i '/client_max_body_size 50m;/a\\    ${MARKER}' ${file} && sed -i '/${MARKER}/r /tmp/maoyan-admin.nginx.conf' ${file}`
  );
}

async function main() {
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on("ready", resolve).on("error", reject).connect({
      host: HOST,
      port: 22,
      username: USER,
      password: PASS,
      readyTimeout: 20000,
    });
  });

  await exec(conn, `cat > /tmp/maoyan-admin.nginx.conf <<'NGXEOF'\n${SNIPPET}\nNGXEOF`);

  const configs = [
    "/etc/nginx/conf.d/xiangyu-portal.conf",
    "/etc/nginx/conf.d/xiangyu-portal-ssl.conf",
  ];

  for (const file of configs) {
    try {
      await patchConfig(conn, file);
    } catch (e) {
      console.warn(`跳过 ${file}:`, e.message);
    }
  }

  await exec(conn, "nginx -t && systemctl reload nginx");
  await exec(conn, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/maoyan-admin/health");
  conn.end();
  console.log("\nNginx 配置完成");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
