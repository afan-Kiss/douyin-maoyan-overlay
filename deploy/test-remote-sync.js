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

async function main() {
  const settingsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "maoyan-sync-")), "overlay-settings.json");
  await testPasswordMaskRoundTrip(settingsPath);
  await testRevisionMonotonic();
  await testRemoteSyncClient();
  console.log("\nALL PASSED (remote sync)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
