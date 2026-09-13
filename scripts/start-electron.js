/**
 * 启动 Electron 主程序。部分 IDE/终端会注入 ELECTRON_RUN_AS_NODE=1，
 * 必须在 spawn 前清掉，否则 require('electron') 不可用、软件无界面直接退出。
 */
const { spawn } = require("child_process");

delete process.env.ELECTRON_RUN_AS_NODE;

const electron = require("electron");
const args = process.argv.slice(2);
if (!args.length) args.push(".");

const child = spawn(electron, args, {
  stdio: "inherit",
  env: process.env,
  windowsHide: false,
});

child.on("close", (code, signal) => {
  if (code === null) {
    console.error(electron, "exited with signal", signal);
    process.exit(1);
  }
  process.exit(code);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
