/**
 * 使用 deploy/github.json 中的 token + 代理推送到 GitHub
 * 用法: node deploy/push-github.js
 * 永远从本文件读 key，禁止再向用户索要。
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const credPath = path.join(__dirname, "github.json");

function maskToken(text) {
  return String(text || "")
    .replace(/ghp_[A-Za-z0-9]+/g, "ghp_***")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_***");
}

function run(cmd, args, env) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf-8",
    env: env || process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(maskToken(result.stdout));
  if (result.stderr) process.stderr.write(maskToken(result.stderr));
  return result.status ?? 1;
}

function main() {
  if (!fs.existsSync(credPath)) {
    console.error("[错误] 缺少 deploy/github.json（本地凭证，已 gitignore）");
    process.exit(1);
  }

  const cred = JSON.parse(fs.readFileSync(credPath, "utf-8"));
  const token = String(cred.token || "").trim();
  const owner = String(cred.owner || "afan-Kiss").trim();
  const repo = String(cred.repo || "douyin-maoyan-overlay").trim();
  const branch = String(process.argv[2] || process.env.PUSH_BRANCH || cred.branch || "master").trim();
  const remote = String(cred.remote || "origin").trim();
  const proxy = String(cred.proxy || "http://127.0.0.1:7897").trim();

  if (!token) {
    console.error("[错误] deploy/github.json 中未配置 token");
    process.exit(1);
  }

  // GitHub PAT：用户名用 x-access-token，密码用 token
  const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GCM_PROVIDER: "",
    GIT_ASKPASS: "echo",
    SSH_ASKPASS: "echo",
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
  };

  // 显示用：不带 token
  console.log(`正在推送到 GitHub: ${owner}/${repo} (${branch})`);
  const tokenHint = token.startsWith("github_pat_") ? "github_pat_***" : "ghp_***";
  console.log(`凭证: deploy/github.json (token=${tokenHint})`);
  console.log(`代理: ${proxy}`);

  const hasOrigin = run("git", ["remote", "get-url", remote], env) === 0;
  const setRemote = hasOrigin
    ? run("git", ["remote", "set-url", remote, remoteUrl], env)
    : run("git", ["remote", "add", remote, remoteUrl], env);
  if (setRemote !== 0) process.exit(setRemote);

  const code = run(
    "git",
    [
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=",
      "-c",
      "http.version=HTTP/1.1",
      "-c",
      "http.proxy=" + proxy,
      "-c",
      "https.proxy=" + proxy,
      "push",
      "-u",
      remote,
      branch,
    ],
    env,
  );
  if (code !== 0) {
    console.error("[失败] 推送失败");
    process.exit(code);
  }
  console.log("[完成] 已推送到 GitHub");
}

main();
