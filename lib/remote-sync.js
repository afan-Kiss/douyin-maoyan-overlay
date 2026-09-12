const { applyRemoteSettings, loadSettings, getSettingsRevision } = require("./settings");

let remoteSyncTimer = null;
let lastAppliedRevision = 0;
let remoteSyncBusy = false;

async function pullRemoteSettings(remoteAdminUrl) {
  const base = String(remoteAdminUrl || "").replace(/\/$/, "");
  if (!base) return false;

  const resp = await fetch(`${base}/api/settings`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) return false;

  const remote = await resp.json();
  const remoteRevision = getSettingsRevision(remote);
  if (remoteRevision === lastAppliedRevision) return false;

  applyRemoteSettings(remote);
  lastAppliedRevision = remoteRevision;
  return true;
}

function startRemoteSync(remoteAdminUrl, onChange) {
  stopRemoteSync();
  const base = String(remoteAdminUrl || "").replace(/\/$/, "");
  if (!base) return;

  lastAppliedRevision = getSettingsRevision(loadSettings());

  const sync = async () => {
    if (remoteSyncBusy) return;
    remoteSyncBusy = true;
    try {
      const changed = await pullRemoteSettings(base);
      if (changed) onChange?.();
    } catch {
      /* 网络异常时静默重试 */
    } finally {
      remoteSyncBusy = false;
    }
  };

  sync();
  remoteSyncTimer = setInterval(sync, 2000);
}

function stopRemoteSync() {
  if (remoteSyncTimer) clearInterval(remoteSyncTimer);
  remoteSyncTimer = null;
  remoteSyncBusy = false;
}

module.exports = { startRemoteSync, stopRemoteSync, pullRemoteSettings };
