/**
 * Chrome 路径动态发现：LOCALAPPDATA / Program Files / 不存在。
 * 禁止硬编码 C:\\Users\\Administrator。
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromeCandidates, findChrome } = require("../lib/poster-search");

function main() {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "poster-search.js"), "utf-8");
  assert.ok(!/C:\\Users\\Administrator/i.test(src), "must not hardcode Administrator Chrome path");
  assert.ok(/LOCALAPPDATA/.test(src), "must use LOCALAPPDATA");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-disc-"));
  const localRoot = path.join(tmp, "Local");
  const appChrome = path.join(localRoot, "Google", "Chrome", "Application");
  const binChrome = path.join(localRoot, "Google", "Chrome", "Bin");
  fs.mkdirSync(appChrome, { recursive: true });
  fs.mkdirSync(binChrome, { recursive: true });
  const appExe = path.join(appChrome, "chrome.exe");
  const binExe = path.join(binChrome, "chrome.exe");
  fs.writeFileSync(appExe, "fake");

  const envLocal = {
    LOCALAPPDATA: localRoot,
    PROGRAMFILES: path.join(tmp, "missing-pf"),
    "PROGRAMFILES(X86)": path.join(tmp, "missing-pfx86"),
  };
  const candidates = chromeCandidates(envLocal);
  assert.ok(candidates.some((p) => p === appExe));
  assert.ok(candidates.some((p) => p === binExe));
  assert.strictEqual(findChrome(envLocal), appExe);

  fs.unlinkSync(appExe);
  fs.writeFileSync(binExe, "fake");
  assert.strictEqual(findChrome(envLocal), binExe);

  const pfRoot = path.join(tmp, "ProgramFiles");
  const pfChrome = path.join(pfRoot, "Google", "Chrome", "Application");
  fs.mkdirSync(pfChrome, { recursive: true });
  const pfExe = path.join(pfChrome, "chrome.exe");
  fs.writeFileSync(pfExe, "fake");
  fs.unlinkSync(binExe);

  const envPf = {
    LOCALAPPDATA: path.join(tmp, "empty-local"),
    PROGRAMFILES: pfRoot,
    "PROGRAMFILES(X86)": path.join(tmp, "missing-pfx86"),
  };
  assert.strictEqual(findChrome(envPf), pfExe);

  const envMissing = {
    LOCALAPPDATA: path.join(tmp, "no-chrome-local"),
    PROGRAMFILES: path.join(tmp, "no-chrome-pf"),
    "PROGRAMFILES(X86)": path.join(tmp, "no-chrome-pfx86"),
  };
  assert.strictEqual(findChrome(envMissing), "");

  const real = findChrome();
  console.log("PASS chrome-discovery");
  console.log({
    realChromePath: real || "(not installed on this machine)",
    candidateCount: chromeCandidates().length,
    sampleCandidates: chromeCandidates().slice(0, 4),
  });
}

main();
