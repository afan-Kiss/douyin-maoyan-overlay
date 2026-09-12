/**
 * 下载票房榜 TOP1–TOP10 预告片到 ui/trailers/
 * 用法: node ui/scripts/download-trailers.js
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TRAILER_DIR = path.join(ROOT, "trailers");

const SOURCES = [
  {
    file: "welcome.mp4",
    url: "https://www.youtube.com/watch?v=PLACEHOLDER_WELCOME",
    note: "欢迎来龙餐馆（若本地已有 welcome.mp4 可跳过）",
    skipIfExists: true,
  },
  {
    file: "kungfu-football.mp4",
    url: "https://www.youtube.com/watch?v=x-HE-g5YwZE",
    cover: "kungfu-football-cover.webp",
    skipIfExists: true,
  },
  {
    file: "baxian.mp4",
    url: "https://www.youtube.com/watch?v=238buK9Iu_o",
    cover: "baxian-cover.webp",
    skipIfExists: true,
  },
  {
    file: "odyssey.mp4",
    url: "https://www.youtube.com/watch?v=f_bKjZeJBBI",
    cover: "odyssey-cover.webp",
  },
  {
    file: "empty-gun.mp4",
    url: "https://www.youtube.com/watch?v=evxXCCxVg6Q",
    cover: "empty-gun-cover.webp",
  },
  {
    file: "to-your-island.mp4",
    url: "https://www.youtube.com/watch?v=dp2X540fRHs",
    cover: "to-your-island-cover.webp",
  },
  {
    file: "spiderman.mp4",
    url: "https://www.youtube.com/watch?v=aBlsrtxuwss",
    cover: "spiderman-cover.webp",
  },
  {
    file: "obsession.mp4",
    url: "https://www.youtube.com/watch?v=gMC8kkwbIQQ",
    cover: "obsession-cover.webp",
  },
  {
    file: "annual-meeting.mp4",
    url: "https://www.youtube.com/watch?v=8guXPPhUVzU",
    cover: "annual-meeting-cover.webp",
  },
  {
    file: "paw-patrol.mp4",
    url: "https://www.youtube.com/watch?v=kucJz6njtao",
    cover: "paw-patrol-cover.webp",
  },
];

function runYtDlp(args) {
  const r = spawnSync("yt-dlp", args, { stdio: "inherit", shell: true });
  if (r.status !== 0) {
    throw new Error(`yt-dlp failed: ${args.join(" ")}`);
  }
}

function downloadTrailer(item) {
  const out = path.join(TRAILER_DIR, item.file);
  if (item.skipIfExists && fs.existsSync(out) && fs.statSync(out).size > 1024 * 1024) {
    console.log(`跳过 ${item.file}（已存在）`);
    return;
  }

  console.log(`\n下载 ${item.file} …`);
  runYtDlp([
    "--force-overwrites",
    "-f",
    "bestvideo[ext=mp4]/best[ext=mp4]/best",
    "--no-playlist",
    "-o",
    out,
    item.url,
  ]);

  if (item.cover) {
    const coverBase = path.join(TRAILER_DIR, path.basename(item.cover, path.extname(item.cover)));
    runYtDlp([
      "--write-thumbnail",
      "--skip-download",
      "-o",
      coverBase,
      item.url,
    ]);
  }
}

function main() {
  fs.mkdirSync(TRAILER_DIR, { recursive: true });

  const ytdlp = spawnSync("yt-dlp", ["--version"], { encoding: "utf-8", shell: true });
  if (ytdlp.status !== 0) {
    console.error("请先安装 yt-dlp: pip install yt-dlp");
    process.exit(1);
  }

  for (const item of SOURCES) {
    if (item.url.includes("PLACEHOLDER")) continue;
    downloadTrailer(item);
  }

  console.log("\n完成。请确认 ui/data/movie-media.json 中片名与票房榜 TOP1–10 一致。");
}

main();
