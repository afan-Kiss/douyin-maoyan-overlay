const { applyRemoteSettings, getSettingsRevision } = require("./settings");

let remoteSyncTimer = null;
let lastAppliedRevision = null;
let remoteSyncBusy = false;
let syncGeneration = 0;
let abortController = null;

async function pullRemoteSettings(remoteAdminUrl, expectedGeneration) {
  if (expectedGeneration != null && expectedGeneration !== syncGeneration) return false;

  const base = String(remoteAdminUrl || "").replace(/\/$/, "");
  if (!base) return false;

  const timeoutSignal = AbortSignal.timeout(8000);
  const signal =
    abortController?.signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([abortController.signal, timeoutSignal])
      : abortController?.signal || timeoutSignal;

  const resp = await fetch(`${base}/api/settings`, { signal });
  if (!resp.ok) return false;

  if (expectedGeneration != null && expectedGeneration !== syncGeneration) return false;

  const remote = await resp.json();
  const remoteRevision = getSettingsRevision(remote);

  if (lastAppliedRevision !== null && remoteRevision === lastAppliedRevision) return false;

  if (expectedGeneration != null && expectedGeneration !== syncGeneration) return false;

  applyRemoteSettings(remote);
  lastAppliedRevision = remoteRevision;
  return true;
}

function startRemoteSync(remoteAdminUrl, onChange) {
  stopRemoteSync();
  const base = String(remoteAdminUrl || "").replace(/\/$/, "");
  if (!base) return;

  syncGeneration += 1;
  const myGeneration = syncGeneration;
  lastAppliedRevision = null;
  abortController = new AbortController();

  const sync = async () => {
    if (myGeneration !== syncGeneration) return;
    if (remoteSyncBusy) return;
    remoteSyncBusy = true;
    try {
      const changed = await pullRemoteSettings(base, myGeneration);
      if (changed && myGeneration === syncGeneration) onChange?.();
    } catch (error) {
      if (error?.name === "AbortError") return;
      /* 网络异常时静默重试 */
    } finally {
      remoteSyncBusy = false;
    }
  };

  sync();
  remoteSyncTimer = setInterval(sync, 2000);
}

function stopRemoteSync() {
  syncGeneration += 1;
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  if (remoteSyncTimer) clearInterval(remoteSyncTimer);
  remoteSyncTimer = null;
  remoteSyncBusy = false;
}

function getSyncGeneration() {
  return syncGeneration;
}

function getLastAppliedRevision() {
  return lastAppliedRevision;
}

module.exports = {
  startRemoteSync,
  stopRemoteSync,
  pullRemoteSettings,
  getSyncGeneration,
  getLastAppliedRevision,
};
