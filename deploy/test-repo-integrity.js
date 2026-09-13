/**
 * Git 仓库完整性：运行时 require/import 目标必须已纳入 Git tree
 * node deploy/test-repo-integrity.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

function gitTrackedFiles() {
  const headOut = execSync("git ls-tree -r HEAD --name-only", {
    cwd: ROOT,
    encoding: "utf-8",
  });
  const indexOut = execSync("git ls-files", { cwd: ROOT, encoding: "utf-8" });
  const files = new Set();
  for (const line of `${headOut}\n${indexOut}`.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) files.add(trimmed);
  }
  return files;
}

function posixJoin(...parts) {
  return parts.join("/").replace(/\\/g, "/");
}

function resolveRelative(baseFile, target) {
  let spec = String(target || "").trim();
  if (!spec || spec.startsWith("node:")) return null;
  if (spec.startsWith("electron")) return null;
  spec = spec.split("?")[0];
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;

  const baseDir = path.dirname(baseFile);
  let resolved = path.normalize(path.join(baseDir, spec));
  const candidates = [];

  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    for (const name of ["index.js", "index.mjs", "index.cjs"]) {
      candidates.push(path.join(resolved, name));
    }
  } else {
    candidates.push(resolved);
    for (const ext of ["", ".js", ".mjs", ".cjs", ".json"]) {
      candidates.push(`${resolved}${ext}`);
    }
  }

  for (const file of candidates) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return posixJoin(path.relative(ROOT, file));
    }
  }
  return posixJoin(path.relative(ROOT, resolved));
}

const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_FROM_RE = /\bfrom\s+['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function collectDeps(fileRel) {
  const abs = path.join(ROOT, fileRel);
  if (!fs.existsSync(abs)) return { file: fileRel, missing: true, deps: [] };
  const text = fs.readFileSync(abs, "utf-8");
  const deps = new Set();
  for (const re of [REQUIRE_RE, IMPORT_FROM_RE, SIDE_EFFECT_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text))) {
      const resolved = resolveRelative(fileRel, match[1]);
      if (resolved) deps.add(resolved);
    }
  }
  return { file: fileRel, missing: false, deps: [...deps] };
}

function walkDeps(entryFiles) {
  const seen = new Set();
  const queue = [...entryFiles];
  const edges = [];

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);

    const info = collectDeps(file);
    if (info.missing) {
      edges.push({ from: file, to: file, missing: true });
      continue;
    }
    for (const dep of info.deps) {
      edges.push({ from: file, to: dep, missing: !fs.existsSync(path.join(ROOT, dep)) });
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return edges;
}

function packageScriptTargets() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
  const targets = [];
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    const text = String(cmd);
    const nodeRe = /\bnode\s+([^\s]+)/g;
    let match;
    while ((match = nodeRe.exec(text))) {
      if (match[1].endsWith(".js")) targets.push({ script: name, file: match[1] });
    }
    if (text.includes("scripts/start-electron.js")) {
      targets.push({ script: name, file: "scripts/start-electron.js" });
    }
  }
  return targets;
}

function main() {
  const tracked = gitTrackedFiles();
  const entryFiles = [
    "bootstrap.js",
    "main.js",
    "maoyan-service.js",
    "lib/maoyan-login.js",
    "lib/login-browser.js",
    "preload.js",
    "preload-splash.js",
    "server/index.js",
    "admin-server.js",
    "standalone-admin.js",
    "scripts/start-electron.js",
  ];

  const missingEntries = entryFiles.filter((f) => !tracked.has(f));
  assert.strictEqual(missingEntries.length, 0, `entry files not in git: ${missingEntries.join(", ")}`);

  const edges = walkDeps(entryFiles);
  const missingOnDisk = edges.filter((e) => e.missing);
  assert.strictEqual(
    missingOnDisk.length,
    0,
    `unresolved local deps:\n${missingOnDisk.map((e) => `${e.from} -> ${e.to}`).join("\n")}`,
  );

  const notTracked = edges
    .map((e) => e.to)
    .filter((dep) => dep && !dep.includes("node_modules"))
    .filter((dep) => !tracked.has(dep));
  assert.strictEqual(
    notTracked.length,
    0,
    `deps exist locally but not in git ls-tree:\n${[...new Set(notTracked)].sort().join("\n")}`,
  );

  const scriptTargets = packageScriptTargets();
  const missingScripts = [];
  for (const { script, file } of scriptTargets) {
    if (!tracked.has(file)) missingScripts.push(`${script} -> ${file}`);
    if (!fs.existsSync(path.join(ROOT, file))) missingScripts.push(`${script} -> ${file} (missing on disk)`);
  }
  assert.strictEqual(missingScripts.length, 0, `npm script targets broken:\n${missingScripts.join("\n")}`);

  console.log("PASS repo integrity");
  console.log(`  tracked files: ${tracked.size}`);
  console.log(`  scanned deps from ${entryFiles.length} entrypoints: ${edges.length}`);
  console.log(`  npm script targets: ${scriptTargets.length}`);
  console.log("\nALL PASSED (repo integrity)");
}

main();
