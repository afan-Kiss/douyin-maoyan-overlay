/**
 * 远程设置 revision 同步验收：node deploy/test-remote-sync.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, options);
  const data = await resp.json();
  return { status: resp.status, data };
}

async function testPasswordMaskRoundTrip(settingsPath) {
  writeSettings(settingsPath, {
    schemaVersion: 2,
    revision: 1,
    admin: { port: 0, password: "abc123" },
    fonts: { heroTitle: 40 },
  });

  const admin = await startAdminWithPath(settingsPath);
  try {
    const get1 = await fetchJson(`${admin.baseUrl}/api/settings`);
    assert.strictEqual(get1.data.admin.password, "***");

    const save = await fetchJson(`${admin.baseUrl}/api/settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": "abc123",
      },
      body: JSON.stringify({
        fonts: { heroTitle: 44 },
        admin: { password: "***" },
      }),
    });
    assert.strictEqual(save.status, 200);

    const disk = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.strictEqual(disk.admin.password, "abc123");
    assert.strictEqual(disk.fonts.heroTitle, 44);

    const saveNew = await fetchJson(`${admin.baseUrl}/api/settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": "abc123",
      },
      body: JSON.stringify({
        admin: { password: "new456" },
      }),
    });
    assert.strictEqual(saveNew.status, 200);
    const disk2 = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.strictEqual(disk2.admin.password, "new456");
    console.log("OK: admin password mask/save chain");
  } finally {
    admin.close();
  }
}

function writeSettings(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

async function startAdminWithPath(settingsPath) {
  process.env.MAOYAN_SETTINGS_PATH = settingsPath;
  delete require.cache[require.resolve("../lib/settings")];
  delete require.cache[require.resolve("../admin-server")];
  const { startAdminServer, stopAdminServer } = require("../admin-server");
  const info = await startAdminServer({ port: 0 });
  return {
    baseUrl: `http://127.0.0.1:${info.port}`,
    close: () => stopAdminServer(),
  };
}

async function testRevisionMonotonic() {
  const settingsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-sync-")), "overlay-settings.json");
  writeSettings(settingsPath, {
    schemaVersion: 2,
    revision: 0,
    admin: { port: 8781, password: "" },
  });

  const admin = await startAdminWithPath(settingsPath);
  try {
    const r1 = await fetchJson(`${admin.baseUrl}/api/settings`);
    const rev1 = r1.data.revision;

    await fetchJson(`${admin.baseUrl}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fonts: { heroTitle: 41 } }),
    });
    await fetchJson(`${admin.baseUrl}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fonts: { heroTitle: 42 } }),
    });

    const r2 = await fetchJson(`${admin.baseUrl}/api/settings`);
    assert.ok(r2.data.revision > rev1);
    assert.strictEqual(r2.data.fonts.heroTitle, 42);
    console.log("OK: revision monotonic on rapid saves");
  } finally {
    admin.close();
  }
}

async function testRemoteSyncClient() {
  const settingsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-sync-")), "overlay-settings.json");
  writeSettings(settingsPath, {
    schemaVersion: 2,
    revision: 1,
    updatedAt: 1000,
    fonts: { heroTitle: 30 },
    admin: { port: 8782, password: "" },
  });

  const admin = await startAdminWithPath(settingsPath);
  delete require.cache[require.resolve("../lib/remote-sync")];
  delete require.cache[require.resolve("../lib/settings")];
  const { pullRemoteSettings } = require("../lib/remote-sync");
  const { loadSettings, saveSettings } = require("../lib/settings");

  try {
    process.env.MAOYAN_SETTINGS_PATH = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-client-")),
      "overlay-settings.json",
    );
    writeSettings(process.env.MAOYAN_SETTINGS_PATH, {
      schemaVersion: 2,
      revision: 1,
      updatedAt: 1000,
      fonts: { heroTitle: 30 },
    });
    delete require.cache[require.resolve("../lib/settings")];
    delete require.cache[require.resolve("../lib/remote-sync")];
    const remoteSync = require("../lib/remote-sync");

    await fetchJson(`${admin.baseUrl}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fonts: { heroTitle: 55 } }),
    });
    const changed = await remoteSync.pullRemoteSettings(admin.baseUrl);
    assert.strictEqual(changed, true);

    delete require.cache[require.resolve("../lib/settings")];
    const client = require("../lib/settings").loadSettings();
    assert.strictEqual(client.fonts.heroTitle, 55);

    const again = await remoteSync.pullRemoteSettings(admin.baseUrl);
    assert.strictEqual(again, false);
    console.log("OK: client applies server revision once");
  } finally {
    admin.close();
    delete process.env.MAOYAN_SETTINGS_PATH;
  }
}

async function testSameRevisionDifferentContent() {
  const settingsPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-sync-")),
    "overlay-settings.json",
  );
  writeSettings(settingsPath, {
    schemaVersion: 2,
    revision: 10,
    fonts: { heroTitle: 50 },
    admin: { port: 8783, password: "" },
  });

  const admin = await startAdminWithPath(settingsPath);
  const clientPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-client-")), "overlay-settings.json");
  writeSettings(clientPath, {
    schemaVersion: 2,
    revision: 10,
    fonts: { heroTitle: 50 },
  });

  try {
    process.env.MAOYAN_SETTINGS_PATH = clientPath;
    delete require.cache[require.resolve("../lib/settings")];
    delete require.cache[require.resolve("../lib/remote-sync")];

    writeSettings(settingsPath, {
      schemaVersion: 2,
      revision: 10,
      fonts: { heroTitle: 64 },
      admin: { port: 8783, password: "" },
    });
    delete require.cache[require.resolve("../lib/settings")];

    const { startRemoteSync, stopRemoteSync } = require("../lib/remote-sync");
    let changed = false;
    startRemoteSync(admin.baseUrl, () => {
      changed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    stopRemoteSync();

    delete require.cache[require.resolve("../lib/settings")];
    const client = require("../lib/settings").loadSettings();
    assert.strictEqual(client.fonts.heroTitle, 64);
    assert.strictEqual(changed, true);
    console.log("OK: first remote sync applies even when revision matches local");
  } finally {
    admin.close();
    delete process.env.MAOYAN_SETTINGS_PATH;
  }
}

async function testStaleRequestDiscardedAfterSwitch() {
  const pathA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-sync-")), "overlay-settings.json");
  const pathB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-sync-")), "overlay-settings.json");
  writeSettings(pathA, {
    schemaVersion: 2,
    revision: 5,
    fonts: { heroTitle: 11 },
    admin: { port: 8784, password: "" },
  });
  writeSettings(pathB, {
    schemaVersion: 2,
    revision: 99,
    fonts: { heroTitle: 77 },
    admin: { port: 8785, password: "" },
  });

  const adminA = await startAdminWithPath(pathA);
  const adminB = await startAdminWithPath(pathB);
  const clientPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-client-")), "overlay-settings.json");
  writeSettings(clientPath, {
    schemaVersion: 2,
    revision: 1,
    fonts: { heroTitle: 30 },
  });

  try {
    process.env.MAOYAN_SETTINGS_PATH = clientPath;
    delete require.cache[require.resolve("../lib/settings")];
    delete require.cache[require.resolve("../lib/remote-sync")];

    const originalFetch = global.fetch;
    let releaseSlowA;
    global.fetch = async (url, options) => {
      const href = String(url);
      if (href.startsWith(adminA.baseUrl)) {
        await new Promise((resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
            return;
          }
          const onAbort = () => {
            signal?.removeEventListener("abort", onAbort);
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          };
          signal?.addEventListener("abort", onAbort);
          releaseSlowA = () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          };
        });
      }
      return originalFetch(url, options);
    };

    const { startRemoteSync, stopRemoteSync } = require("../lib/remote-sync");
    startRemoteSync(adminA.baseUrl);
    await new Promise((resolve) => setTimeout(resolve, 100));
    stopRemoteSync();
    startRemoteSync(adminB.baseUrl);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (releaseSlowA) releaseSlowA();
    await new Promise((resolve) => setTimeout(resolve, 500));
    stopRemoteSync();
    global.fetch = originalFetch;

    delete require.cache[require.resolve("../lib/settings")];
    const client = require("../lib/settings").loadSettings();
    assert.strictEqual(client.fonts.heroTitle, 77);
    console.log("OK: stale remote A response does not override remote B");
  } finally {
    adminA.close();
    adminB.close();
    delete process.env.MAOYAN_SETTINGS_PATH;
  }
}

async function main() {
  const settingsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-sync-")), "overlay-settings.json");
  await testPasswordMaskRoundTrip(settingsPath);
  await testRevisionMonotonic();
  await testRemoteSyncClient();
  await testSameRevisionDifferentContent();
  await testStaleRequestDiscardedAfterSwitch();
  console.log("\nALL PASSED (remote sync)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
