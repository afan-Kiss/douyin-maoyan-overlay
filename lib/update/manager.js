const fs = require("fs");
const path = require("path");

const { downloadRelease, hashFile } = require("./downloader");
const {
  scheduleApplyAndExit,
  cleanupLegacyApplyArtifacts,
  cleanupSuccessfulUpdateBackup,
  recoverInterruptedUpdate,
} = require("./apply");
const { hasPendingHealthUpdate } = require("./health");
const {
  currentVersion,
  currentVersionDisplay,
  displayVersion,
  isNewer,
  normalizeVersion,
  skipAutoUpdate,
} = require("./version");
const {
  installDir,
  updatesDir,
  getRealExecutablePath,
  isPackagedApp,
  ensureDir,
} = require("./paths");
const {
  isInstalledReleaseMeta,
  rememberInstalledRelease,
} = require("./install-state");

const APP_PLATFORM = "maoyan-win-x64";
const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;
const DEFAULT_UPDATE_SERVER = "https://xiangyuzhubao.xyz";

function httpBase(serverUrl) {
  let base = String(serverUrl || "").trim().replace(/\/+$/, "");
  if (base.endsWith("/ws/agent")) {
    base = base.slice(0, -"/ws/agent".length);
  }
  if (base.startsWith("wss://")) base = base.replace(/^wss:\/\//, "https://");
  else if (base.startsWith("ws://")) base = base.replace(/^ws:\/\//, "http://");
  else if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  return base.replace(/\/+$/, "");
}

function resolveUpdateServer(config) {
  return (
    process.env.MAOYAN_UPDATE_SERVER ||
    process.env.AGENT_UPDATE_SERVER ||
    config?.updateServerUrl ||
    config?.serverUrl ||
    DEFAULT_UPDATE_SERVER
  );
}

function createProgressRef(initial) {
  let snapshot = { ...initial };
  return {
    get: () => ({ ...snapshot }),
    set: (patch) => {
      snapshot = { ...snapshot, ...patch };
    },
  };
}

function buildDownloadFileName(version, sha256) {
  const ver = normalizeVersion(version || "latest");
  const sha = String(sha256 || "").trim().toLowerCase();
  const shaTag = sha ? sha.slice(0, 12) : "unknown";
  return `MaoyanOverlay-${ver}-${shaTag}.exe`;
}

class UpdateManager {
  constructor(config = {}) {
    this.config = config;
    this.serverUrl = resolveUpdateServer(config);
    this.progress = createProgressRef({
      phase: "idle",
      message: "暂无更新任务",
      downloaded: 0,
      total: 0,
      speedBps: 0,
      currentVersion: currentVersionDisplay(),
      targetVersion: null,
      error: null,
    });
    this.busy = false;
  }

  isBusy() {
    return this.busy;
  }

  tryBeginJob() {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }

  endJob() {
    this.busy = false;
  }

  updateCheckConfigured() {
    const url = String(this.serverUrl || "").trim();
    return Boolean(url) && url !== "http://localhost:3000";
  }

  setProgress(patch) {
    this.progress.set(patch);
  }

  getProgress() {
    return this.progress.get();
  }

  baseProgress(phase, message) {
    return {
      phase,
      message,
      currentVersion: currentVersionDisplay(),
      downloaded: 0,
      total: 0,
      speedBps: 0,
      targetVersion: null,
      error: null,
    };
  }

  async autoUpdateIfNeeded() {
    if (!isPackagedApp()) {
      this.setProgress(this.baseProgress("idle", "开发模式，已跳过自动更新"));
      return false;
    }
    if (skipAutoUpdate()) {
      this.setProgress(this.baseProgress("idle", "已跳过自动更新"));
      return false;
    }
    if (!this.updateCheckConfigured()) {
      this.setProgress(this.baseProgress("idle", "未配置服务器，已跳过更新检查"));
      return false;
    }
    if (!this.tryBeginJob()) return false;

    try {
      const info = await this.check().catch((error) => {
        this.setProgress(
          this.baseProgress("idle", `更新检查未完成：${error.message || error}`),
        );
        return null;
      });
      if (!info?.updateAvailable) {
        this.endJob();
        return false;
      }
      await this.downloadAndApply(info);
      return true;
    } catch (error) {
      this.endJob();
      throw error;
    }
  }

  async checkAndApplyIfAvailable(options = {}) {
    if (!this.tryBeginJob()) {
      throw new Error("已有更新任务在进行中");
    }
    try {
      const info = await this.check();
      if (!info.updateAvailable) return false;
      await this.downloadAndApply(info, options);
      return true;
    } finally {
      this.endJob();
    }
  }

  async currentExeMatchesSha(expectedSha256) {
    const expected = String(expectedSha256 || "").trim().toLowerCase();
    if (!expected) return false;
    // 优先读安装态缓存，避免每次对 ~80MB EXE 全量哈希
    if (isInstalledReleaseMeta(expected)) return true;
    try {
      const actual = await hashFile(getRealExecutablePath());
      const ok = actual.toLowerCase() === expected;
      if (ok) {
        rememberInstalledRelease({
          version: currentVersion(),
          sha256: expected,
          exePath: getRealExecutablePath(),
        });
      }
      return ok;
    } catch {
      return false;
    }
  }

  normalizeManifest(raw, base) {
    const version = normalizeVersion(raw.version || "");
    const current = currentVersion();
    const fileName = raw.fileName || "MaoyanOverlay.exe";
    const downloadUrl =
      String(raw.downloadUrl || "").trim() ||
      `${base}/maoyan-updates/${fileName}`;
    const versionNewer = Boolean(version) && isNewer(version, current);
    const sameVersion = Boolean(version) && normalizeVersion(version) === current;
    const sha256 = String(raw.sha256 || "").trim().toLowerCase();
    const fileSize = Number(raw.fileSize) || 0;
    // 同版本但内容哈希已安装过 → 不当作待更新，避免启动时无意义哈希/重下
    const sameContentInstalled = sameVersion && isInstalledReleaseMeta(sha256, fileSize);
    const updateAvailable =
      raw.updateAvailable !== false &&
      version &&
      (versionNewer || (sameVersion && !sameContentInstalled));
    return {
      updateAvailable,
      version: version || null,
      releaseId: raw.releaseId || version || "latest",
      fileSize,
      sha256,
      chunkSize: Number(raw.chunkSize) || DEFAULT_CHUNK_SIZE,
      releaseNotes: raw.releaseNotes || null,
      downloadUrl,
      fileName,
    };
  }

  async check() {
    if (!this.updateCheckConfigured()) {
      const msg = "未配置服务器地址，无法检查更新";
      this.setProgress(this.baseProgress("idle", msg));
      throw new Error(msg);
    }

    this.setProgress(this.baseProgress("checking", "正在检查更新…"));
    const base = httpBase(this.serverUrl);
    const version = currentVersion();
    const url = `${base}/maoyan-updates/latest.json`;

    let resp;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      this.setProgress({
        ...this.baseProgress("error", "无法连接更新服务器"),
        error: error.message || String(error),
      });
      throw error;
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      this.setProgress({
        ...this.baseProgress("error", `检查更新失败 (${resp.status})`),
        error: body,
      });
      throw new Error(`检查更新失败 (${resp.status}): ${body}`);
    }

    const raw = await resp.json();
    const info = this.normalizeManifest(raw, base);
    // 日常检查只比版本号，避免每次对整包 EXE 做 SHA256（约 80MB 读盘会卡整机）
    // 内容哈希仅在 downloadAndApply 安装前校验
    if (!info.updateAvailable) {
      this.setProgress({
        phase: "idle",
        message: `当前 ${currentVersionDisplay()} 已是最新版本`,
        currentVersion: currentVersionDisplay(),
        targetVersion: info.version ? displayVersion(info.version) : null,
        downloaded: 0,
        total: Number(info.fileSize) || 0,
        speedBps: 0,
        error: null,
      });
      return info;
    }

    const target = info.version ? displayVersion(info.version) : "";
    this.setProgress({
      phase: "available",
      message: `发现新版本 ${target}，准备自动更新…`,
      currentVersion: currentVersionDisplay(),
      targetVersion: info.version ? displayVersion(info.version) : null,
      downloaded: 0,
      total: Number(info.fileSize) || 0,
      speedBps: 0,
      error: null,
    });
    return info;
  }

  async downloadAndApply(info, options = {}) {
    if (!info?.updateAvailable) {
      throw new Error("当前已是最新版本，无需安装");
    }

    if (hasPendingHealthUpdate(installDir())) {
      throw new Error("UPDATE_PENDING_HEALTH");
    }

    const sha256 = info.sha256;
    const fileSize = Number(info.fileSize);
    const chunkSize = Number(info.chunkSize || DEFAULT_CHUNK_SIZE);
    const targetVersion = info.version || "latest";
    const targetDisplay = displayVersion(targetVersion);
    const current = currentVersion();

    if (isInstalledReleaseMeta(sha256, fileSize) && !isNewer(targetVersion, current)) {
      this.setProgress({
        ...this.baseProgress("idle", `当前 ${currentVersionDisplay()} 已是最新版本`),
        targetVersion: targetDisplay,
      });
      throw new Error("当前已是最新版本，无需安装");
    }

    const hashMatches = await this.currentExeMatchesSha(sha256);
    if (!isNewer(targetVersion, current) && hashMatches) {
      this.setProgress({
        ...this.baseProgress("idle", `当前 ${currentVersionDisplay()} 已是最新版本`),
        targetVersion: targetDisplay,
      });
      throw new Error("当前已是最新版本，无需安装");
    }
    if (hashMatches) {
      this.setProgress({
        ...this.baseProgress(
          "idle",
          `当前 ${currentVersionDisplay()} 与发布包内容相同，跳过重复安装`,
        ),
        targetVersion: targetDisplay,
      });
      throw new Error("当前安装包与发布包内容相同，无需重复更新");
    }

    const base = httpBase(this.serverUrl);
    const downloadUrl =
      String(info.downloadUrl || "").trim() ||
      `${base}/maoyan-updates/${info.fileName || "MaoyanOverlay.exe"}`;

    const dir = updatesDir();
    ensureDir(dir);
    const newExe = path.join(dir, buildDownloadFileName(targetVersion, sha256));

    try {
      await downloadRelease({
        url: downloadUrl,
        dest: newExe,
        total: fileSize,
        chunkSize,
        expectedSha256: sha256,
        progressRef: this.progress,
        targetVersion: targetDisplay,
        currentVersion: currentVersionDisplay(),
      });
    } catch (error) {
      try {
        if (fs.existsSync(newExe)) fs.unlinkSync(newExe);
      } catch {
        /* ignore */
      }
      this.setProgress({
        phase: "error",
        downloaded: 0,
        total: fileSize,
        speedBps: 0,
        message: "更新失败",
        error: error.message || String(error),
        currentVersion: currentVersionDisplay(),
        targetVersion: targetDisplay,
      });
      throw error;
    }

    this.setProgress({
      phase: "applying",
      downloaded: fileSize,
      total: fileSize,
      speedBps: 0,
      message: `正在安装 ${targetDisplay}，即将重启…`,
      currentVersion: currentVersionDisplay(),
      targetVersion: targetDisplay,
      error: null,
    });

    await scheduleApplyAndExit(
      newExe,
      installDir(),
      normalizeVersion(targetVersion),
      String(sha256 || "").toLowerCase(),
      { beforeExit: options.beforeExit },
    );
    return true;
  }
}

function prepareUpdateEnvironmentEarly() {
  const dir = installDir();
  recoverInterruptedUpdate(dir);
  cleanupLegacyApplyArtifacts(dir);
}

function prepareUpdateEnvironment() {
  prepareUpdateEnvironmentEarly();
}

module.exports = {
  UpdateManager,
  httpBase,
  APP_PLATFORM,
  DEFAULT_UPDATE_SERVER,
  buildDownloadFileName,
  prepareUpdateEnvironment,
  prepareUpdateEnvironmentEarly,
  cleanupSuccessfulUpdateBackup,
};
