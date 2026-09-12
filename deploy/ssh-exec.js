const { Client } = require("ssh2");
const cmd = process.argv.slice(2).join(" ") || "pm2 logs maoyan-admin --lines 20 --nostream";
const conn = new Client();
conn
  .on("ready", () => {
    conn.exec(cmd, (err, stream) => {
      if (err) throw err;
      stream.on("close", () => conn.end()).pipe(process.stdout);
      stream.stderr.pipe(process.stderr);
    });
  })
  .connect({
    host: process.env.DEPLOY_HOST || "47.108.21.50",
    port: 22,
    username: process.env.DEPLOY_USER || "root",
    password: process.env.DEPLOY_PASS,
    readyTimeout: 20000,
  });
