const { Client } = require("ssh2");

const HOST = process.env.DEPLOY_HOST || "47.108.21.50";
const PASS = process.env.DEPLOY_PASS || "";

const snippet = `location = /maoyan-admin {
    return 301 /maoyan-admin/;
}
location /maoyan-admin/ {
    proxy_pass http://127.0.0.1:8780/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
}
`;

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
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on("ready", resolve).on("error", reject).connect({
      host: HOST,
      port: 22,
      username: "root",
      password: PASS,
      readyTimeout: 20000,
    });
  });

  await exec(conn, "rm -f /etc/nginx/conf.d/maoyan-admin.conf");
  await exec(
    conn,
    `cp /etc/nginx/conf.d/xiangyu-portal.conf.bak-maoyan-admin /etc/nginx/conf.d/xiangyu-portal.conf
cp /etc/nginx/conf.d/xiangyu-portal-ssl.conf.bak-maoyan-admin /etc/nginx/conf.d/xiangyu-portal-ssl.conf`
  );

  await exec(conn, `cat > /etc/nginx/snippets/maoyan-admin.conf <<'EOF'\n${snippet}\nEOF`);

  const includeLine = "include /etc/nginx/snippets/maoyan-admin.conf;";
  for (const file of [
    "/etc/nginx/conf.d/xiangyu-portal.conf",
    "/etc/nginx/conf.d/xiangyu-portal-ssl.conf",
  ]) {
    await exec(
      conn,
      `grep -q 'maoyan-admin.conf' ${file} || sed -i '0,/^    client_max_body_size 50m;$/s//    client_max_body_size 50m;\\n    ${includeLine}/' ${file}`
    );
  }

  await exec(conn, "nginx -t && systemctl reload nginx");
  await exec(
    conn,
    "curl -s http://127.0.0.1/maoyan-admin/health; echo; curl -sk https://127.0.0.1/maoyan-admin/health -H 'Host: xiangyuzhubao.xyz'; echo"
  );
  conn.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
