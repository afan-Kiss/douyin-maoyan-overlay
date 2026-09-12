const {
  UpdateManager,
  prepareUpdateEnvironment,
  prepareUpdateEnvironmentEarly,
  APP_PLATFORM,
  DEFAULT_UPDATE_SERVER,
} = require("./manager");
const {
  confirmUpdateHealth,
  readPendingUpdate,
  hasPendingHealthUpdate,
} = require("./health");
const {
  parseApplyUpdateArgs,
  runApplyUpdate,
  scheduleApplyAndExit,
  cleanupLegacyApplyArtifacts,
  cleanupSuccessfulUpdateBackup,
  APPLY_UPDATE_ARG,
} = require("./apply");
const { downloadRelease, hashFile } = require("./downloader");
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
  installedExeName,
  isPackagedApp,
  getRealExecutablePath,
} = require("./paths");

module.exports = {
  UpdateManager,
  prepareUpdateEnvironment,
  prepareUpdateEnvironmentEarly,
  confirmUpdateHealth,
  readPendingUpdate,
  hasPendingHealthUpdate,
  APP_PLATFORM,
  DEFAULT_UPDATE_SERVER,
  parseApplyUpdateArgs,
  runApplyUpdate,
  scheduleApplyAndExit,
  cleanupLegacyApplyArtifacts,
  cleanupSuccessfulUpdateBackup,
  APPLY_UPDATE_ARG,
  downloadRelease,
  hashFile,
  currentVersion,
  currentVersionDisplay,
  displayVersion,
  isNewer,
  normalizeVersion,
  skipAutoUpdate,
  installDir,
  updatesDir,
  installedExeName,
  isPackagedApp,
  getRealExecutablePath,
};
