/**
 * 使用 deploy/github.json 中的 token 推送到 GitHub
 * 用法: node deploy/push-github.js
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const credPath = path.join(__dirname, "github.json");

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf-8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

function main() {
  if (!fs.existsSync(credPath)) {
    console.error("[错误] 缺少 deploy/github.json");
    process.exit(1);
  }

  const cred = JSON.parse(fs.readFileSync(credPath, "utf-8"));
  const token = String(cred.token || "").trim();
  const owner = String(cred.owner || "afan-Kiss").trim();
  const repo = String(cred.repo || "douyin-maoyan-overlay").trim();
  const branch = String(cred.branch || "master").trim();
  const remote = String(cred.remote || "origin").trim();

  if (!token) {
    console.error("[错误] deploy/github.json 中未配置 token");
    process.exit(1);
  }

  const remoteUrl = `https://${token}@github.com/${owner}/${repo}.git`;

  const hasOrigin = run("git", ["remote", "get-url", remote]) === 0;
  const setRemote = hasOrigin
    ? run("git", ["remote", "set-url", remote, remoteUrl])
    : run("git", ["remote", "add", remote, remoteUrl]);
  if (setRemote !== 0) process.exit(setRemote);

  console.log(`正在推送到 GitHub: ${owner}/${repo} (${branch})`);
  const code = run("git", ["push", "-u", remote, branch]);
  if (code !== 0) {
    console.error("[失败] 推送失败");
    process.exit(code);
  }
  console.log("[完成] 已推送到 GitHub");
}

main();
