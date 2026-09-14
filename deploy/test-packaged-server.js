/**
 * 打包后冒烟：确认便携版票房服务能启动（换机必测）。
 * 用法：先 electron-builder 出 dist/win-unpacked，再 node deploy/test-packaged-server.js
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const unpacked = path.join(ROOT, "dist", "win-unpacked");
const exe = path.join(unpacked, "MaoyanOverlay.exe");
const serverJs = path.join(unpacked, "resources", "maoyan", "server", "index.js");
const rankInServer = path.join(unpacked, "resources", "maoyan", "server", "lib", "dashboard-rank.js");

function fail(msg) {
  console.error("[FAIL]", msg);
  process.exit(1);
}

function check(cond, msg) {
  if (!cond) fail(msg);
  console.log("[OK]", msg);
}

async function waitHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function main() {
  check(fs.existsSync(exe), `存在 ${exe}`);
  check(fs.existsSync(serverJs), `存在 ${serverJs}`);
  check(fs.existsSync(rankInServer), `存在 dashboard-rank.js（否则服务秒退）`);

  const dataDir = path.join(require("os").tmpdir(), `maoyan-packaged-smoke-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const port = 18765;
  fs.writeFileSync(
    path.join(dataDir, "config.ini"),
    `[browser]\npath=\n\n[server]\nport=${port}\n`,
    "utf-8",
  );

  const nodeModules = path.join(unpacked, "resources", "app.asar", "node_modules");
  const child = spawn(exe, [serverJs], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      MAOYAN_DATA_DIR: dataDir,
      // 与 maoyan-service.resolveRuntime 一致：依赖在 asar 内
      NODE_PATH: nodeModules,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let err = "";
  child.stderr.on("data", (d) => {
    err += String(d);
  });
  child.stdout.on("data", () => {});

  const healthy = await waitHealth(port, 25000); // hits /health
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* ignore */
    }
  }

  if (!healthy) {
    fail(`票房服务未就绪。stderr=\n${err.slice(0, 1500)}`);
  }
  console.log("[OK] 打包票房服务已监听并响应 /health");
}

main().catch((e) => fail(e?.stack || String(e)));
