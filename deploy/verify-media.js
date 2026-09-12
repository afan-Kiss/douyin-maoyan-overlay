const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const uiDir = path.join(ROOT, "ui");
const media = JSON.parse(fs.readFileSync(path.join(uiDir, "data", "movie-media.json"), "utf-8"));

let missing = 0;
for (const item of media) {
  for (const key of ["poster", "trailerPoster", "trailer"]) {
    const rel = item[key];
    if (!rel) continue;
    if (rel.endsWith(".mp4")) {
      console.log(`MP4_CFG OK ${item.name} ${rel}`);
      continue;
    }
    const abs = path.join(uiDir, rel.replace(/\//g, path.sep));
    if (fs.existsSync(abs)) {
      console.log(`PASS ${item.name} ${key} ${rel}`);
    } else {
      console.log(`FAIL ${item.name} ${key} ${rel}`);
      missing += 1;
    }
  }
}

if (missing > 0) {
  console.error(`Media missing: ${missing}`);
  process.exit(1);
}
console.log(`All media references OK (${media.length} movies)`);
