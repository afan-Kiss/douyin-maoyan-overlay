/**
 * 获取平台 admin token 并发布 MaoyanOverlay 到更新通道
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const cred = JSON.parse(
  fs.readFileSync(path.join(__dirname, "aliyun.json"), "utf-8"),
);
const ROOT = path.join(__dirname, "..");
const SERVER = cred.updateServerUrl || "https://xiangyuzhubao.xyz";
const PLATFORM = cred.platform || "maoyan-win-x64";
const VERSION = "1.0";

const LOGIN_CANDIDATES = [
  { email: "admin@wechat-scrm.local", password: cred.deployPass },
  { email: "admin@wechat-scrm.local", password: cred.adminPassword },
  { email: cred.adminEmail, password: cred.adminPassword },
].filter((c) => c.email && c.password);

async function tryLogin(base, email, password) {
  const resp = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.token || data.accessToken || null;
}

async function resolveToken() {
  if (cred.adminToken) return cred.adminToken;
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;

  const bases = [
    SERVER.replace(/\/$/, ""),
    "http://81.70.50.5",
  ];
  for (const base of bases) {
    for (const { email, password } of LOGIN_CANDIDATES) {
      try {
        const token = await tryLogin(base, email, password);
        if (token) {
          console.log(`已登录: ${email} @ ${base}`);
          return token;
        }
      } catch {
        /* try next */
      }
    }
  }
  throw new Error("无法获取 adminToken，请在 deploy/aliyun.json 填写 adminToken");
}

function buildRelease() {
  console.log("正在打包 MaoyanOverlay.exe …");
  const ps1 = path.join(__dirname, "build-release.ps1");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
    { cwd: ROOT, stdio: "inherit", env: process.env },
  );
  if (result.status !== 0) throw new Error(`build-release 失败 (${result.status})`);
}

async function publish(token) {
  const exePath = path.join(ROOT, "dist", "MaoyanOverlay.exe");
  if (!fs.existsSync(exePath)) throw new Error(`缺少 ${exePath}`);

  const base = SERVER.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  console.log(`创建草稿 v${VERSION} (${PLATFORM}) …`);
  const draftResp = await fetch(`${base}/api/releases`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: VERSION,
      platform: PLATFORM,
      releaseNotes: "猫眼票房直播展示 v1.0：首版发布，含自启动与自动更新。",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!draftResp.ok) {
    const body = await draftResp.text();
    throw new Error(`创建草稿失败 (${draftResp.status}): ${body}`);
  }
  const draft = await draftResp.json();
  const releaseId = draft.id;
  console.log(`releaseId=${releaseId}`);

  console.log("上传 EXE …");
  const form = new FormData();
  const blob = new Blob([fs.readFileSync(exePath)], {
    type: "application/octet-stream",
  });
  form.append("file", blob, "MaoyanOverlay.exe");

  const uploadResp = await fetch(`${base}/api/releases/${releaseId}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(30 * 60_000),
  });
  const uploadBody = await uploadResp.text();
  if (!uploadResp.ok) {
    throw new Error(`上传失败 (${uploadResp.status}): ${uploadBody}`);
  }
  console.log(uploadBody);

  console.log("发布 …");
  const pubResp = await fetch(`${base}/api/releases/${releaseId}/publish`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!pubResp.ok) {
    const body = await pubResp.text();
    throw new Error(`发布失败 (${pubResp.status}): ${body}`);
  }
  const published = await pubResp.json();
  console.log(JSON.stringify(published, null, 2));

  const latestResp = await fetch(
    `${base}/api/agent-updates/latest?platform=${PLATFORM}&currentVersion=0.0`,
    { signal: AbortSignal.timeout(30_000) },
  );
  const latest = await latestResp.json();
  const downloadUrl = `${base}/api/agent-updates/${releaseId}/download`;
  console.log("\n=== 发布成功 ===");
  console.log(`版本: v${VERSION}`);
  console.log(`下载: ${downloadUrl}`);
  console.log(`latest API: ${JSON.stringify(latest)}`);
  if (latest.downloadUrl) console.log(`CDN: ${latest.downloadUrl}`);
}

async function main() {
  buildRelease();
  const token = await resolveToken();
  await publish(token);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
