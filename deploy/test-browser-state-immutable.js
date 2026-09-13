/**
 * sigManager 不得直接覆盖正式 browser_state.json
 * node deploy/test-browser-state-immutable.js
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-state-immutable-"));
}

async function testSigManagerSourceHasNoOfficialWrite() {
  const sigSource = fs.readFileSync(
    path.join(__dirname, "..", "server", "lib", "sigManager.js"),
    "utf-8",
  );
  assert.ok(
    !sigSource.match(/storageState\(\s*\{\s*path:\s*STORAGE_STATE\s*\}/),
    "sigManager must not contain storageState({ path: STORAGE_STATE })",
  );
  console.log("PASS sigManager source has no official browser_state write");
}

async function testSigManagerRuntimeDoesNotMutateOfficialState() {
  const dir = tempDir();
  const storagePath = path.join(dir, "browser_state.json");
  const content = JSON.stringify({
    cookies: [
      { name: "passport_token", value: "immutable-token", domain: ".maoyan.com" },
      { name: "csrfToken", value: "csrf", domain: ".maoyan.com" },
    ],
    origins: [],
  });
  fs.writeFileSync(storagePath, content);
  fs.writeFileSync(path.join(dir, "config.ini"), "port=8765\nchromePath=\n");
  const oldHash = sha256File(storagePath);

  process.env.MAOYAN_DATA_DIR = dir;
  const { manager } = await import("../server/lib/sigManager.js");

  const fakePage = {
    goto: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => true,
    close: async () => {},
    on() {},
    off() {},
  };

  manager.launchBrowserContext = async () => ({
    browser: { close: async () => {} },
    context: {
      newPage: async () => fakePage,
      storageState: async (opts) => {
        if (opts?.path?.includes("browser_state.json")) {
          fs.writeFileSync(
            opts.path,
            JSON.stringify({ cookies: [{ name: "hacked", value: "x", domain: ".maoyan.com" }] }),
          );
        }
      },
      close: async () => {},
    },
  });
  manager.closeBrowserSession = async () => {};

  manager.rememberMovieRequest = () => ({
    headers: { mtgsig: '{"a":1}' },
    url: "https://piaofang.maoyan.com/i/api/movie/getBoxShow?movieId=1462628&boxLevel=1",
  });
  manager.countWuKongSigs = () => 0;

  await manager.withBrowserPage("1462628", "https://piaofang.maoyan.com/dashboard", async () => ({}));
  await manager.captureMtgsig("1462628", "1").catch(() => {});
  await manager._captureApiMtgsig("1462628", "/i/api/movie/getPredictionBox", { movieId: "1462628" }, {}).catch(() => {});
  await manager.captureMtgsig("1462628", "1").catch(() => {});

  assert.strictEqual(sha256File(storagePath), oldHash, "official browser_state.json must stay unchanged");
  console.log("PASS runtime sigManager operations keep official browser_state SHA256");
}

async function main() {
  await testSigManagerSourceHasNoOfficialWrite();
  await testSigManagerRuntimeDoesNotMutateOfficialState();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
