const fs = require("fs");
const path = require("path");

function getLoginLockPath(dataDir) {
  return path.join(dataDir, "login.lock");
}

function writeLoginLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(getLoginLockPath(dataDir), String(process.pid));
}

function clearLoginLock(dataDir) {
  try {
    fs.unlinkSync(getLoginLockPath(dataDir));
  } catch {
    /* ignore */
  }
}

function isLoginLockActive(dataDir) {
  try {
    return fs.existsSync(getLoginLockPath(dataDir));
  } catch {
    return false;
  }
}

module.exports = {
  getLoginLockPath,
  writeLoginLock,
  clearLoginLock,
  isLoginLockActive,
};
