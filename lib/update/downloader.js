const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CONNECT_TIMEOUT_MS = 20_000;
const IDLE_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 8;
const PROGRESS_EVERY_BYTES = 64 * 1024;
const MAX_PARALLEL_CHUNKS = 4;
const MIN_CHUNK_SIZE = 1024 * 1024;

function partPath(dest) {
  return `${dest}.part`;
}

function chunkPath(dest, index) {
  return `${dest}.part.${String(index).padStart(6, "0")}`;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.floor(n / 1024)} KB`;
  return `${n} B`;
}

function formatSpeed(bps) {
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${Math.floor(bps / 1024)} KB/s`;
  if (bps > 0) return `${bps} B/s`;
  return "…";
}

function downloadMessage(targetVersion, complete, total, speedBps) {
  const pct = total > 0 ? Math.floor((complete / total) * 100) : 0;
  return `正在下载 ${targetVersion}：${formatBytes(complete)} / ${formatBytes(total)}（${pct}%）· ${formatSpeed(speedBps)}`;
}

function calcSpeedBps(startedAt, baseline, complete) {
  const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.05);
  const delta = Math.max(complete - baseline, 0);
  return Math.round(delta / elapsed);
}

function setProgress(progressRef, patch) {
  if (progressRef && typeof progressRef.set === "function") {
    progressRef.set(patch);
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function streamChunkOnce({
  url,
  chunkFile,
  start,
  expectedLen,
  total,
  baseline,
  downloadedCounter,
  startedAt,
  progressRef,
  targetVersion,
  currentVersion,
}) {
  let offset = 0;
  try {
    offset = fs.statSync(chunkFile).size;
  } catch {
    offset = 0;
  }

  const rangeStart = start + offset;
  const rangeEnd = start + expectedLen - 1;
  const response = await fetchWithTimeout(
    url,
    { headers: { Range: `bytes=${rangeStart}-${rangeEnd}` } },
    CONNECT_TIMEOUT_MS + IDLE_TIMEOUT_MS,
  );

  const status = response.status;
  if (!(response.ok || status === 206)) {
    const body = await response.text().catch(() => "");
    throw new Error(`Download failed (${status}): ${body}`);
  }
  if (status === 206) {
    const contentRange = response.headers.get("content-range") || response.headers.get("Content-Range");
    if (!contentRange) {
      throw new Error("Range response missing Content-Range header");
    }
    const match = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
    if (!match) {
      throw new Error(`Invalid Content-Range header: ${contentRange}`);
    }
    const respStart = Number(match[1]);
    const respEnd = Number(match[2]);
    const expectedStart = rangeStart;
    const expectedEnd = rangeEnd;
    if (respStart !== expectedStart || respEnd !== expectedEnd) {
      throw new Error(
        `Content-Range mismatch: expected bytes ${expectedStart}-${expectedEnd}, got ${contentRange}`,
      );
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    const expectedBytes = expectedEnd - expectedStart + 1;
    if (contentLength > 0 && contentLength !== expectedBytes) {
      throw new Error(
        `Content-Length mismatch for range: expected ${expectedBytes}, got ${contentLength}`,
      );
    }
  }
  if (status === 200 && (start !== 0 || expectedLen !== total || offset !== 0)) {
    throw new Error("Update server does not support Range requests");
  }

  const fd = fs.openSync(
    chunkFile,
    offset > 0 ? "a" : "w",
  );
  let sinceReport = 0;
  let idleTimer = null;
  let idleReject = null;
  const idlePromise = new Promise((_, reject) => {
    idleReject = reject;
  });

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleReject(new Error(`Download idle for ${IDLE_TIMEOUT_MS / 1000}s`));
    }, IDLE_TIMEOUT_MS);
  };

  try {
    resetIdle();
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Download stream unavailable");

    while (true) {
      const readResult = await Promise.race([
        reader.read(),
        idlePromise,
      ]);
      const { done, value } = readResult;
      if (done) break;
      if (!value || !value.length) continue;

      resetIdle();
      const remaining = expectedLen - offset;
      const count = Math.min(value.length, remaining);
      if (count <= 0) break;

      fs.writeSync(fd, Buffer.from(value.subarray(0, count)));
      offset += count;
      downloadedCounter.value += count;
      sinceReport += count;

      if (sinceReport >= PROGRESS_EVERY_BYTES) {
        sinceReport = 0;
        fs.fsyncSync(fd);
        const complete = Math.min(downloadedCounter.value, total);
        const speed = calcSpeedBps(startedAt, baseline, complete);
        setProgress(progressRef, {
          phase: "downloading",
          downloaded: complete,
          total,
          speedBps: speed,
          message: downloadMessage(targetVersion, complete, total, speed),
          currentVersion,
          targetVersion,
          error: null,
        });
      }
      if (offset >= expectedLen) break;
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    fs.closeSync(fd);
  }

  const complete = Math.min(downloadedCounter.value, total);
  const speed = calcSpeedBps(startedAt, baseline, complete);
  setProgress(progressRef, {
    phase: "downloading",
    downloaded: complete,
    total,
    speedBps: speed,
    message: downloadMessage(targetVersion, complete, total, speed),
    currentVersion,
    targetVersion,
    error: null,
  });
  return offset;
}

async function downloadChunk(args) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let existing = 0;
    try {
      existing = fs.statSync(args.chunkFile).size;
    } catch {
      existing = 0;
    }
    if (existing === args.expectedLen) return;
    if (existing > args.expectedLen) {
      try {
        fs.unlinkSync(args.chunkFile);
      } catch {
        /* ignore */
      }
      continue;
    }

    try {
      const length = await streamChunkOnce(args);
      if (length === args.expectedLen) return;
      lastError = `chunk incomplete: ${length}/${args.expectedLen} bytes`;
    } catch (error) {
      lastError = error?.message || String(error);
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, attempt * 350));
    }
  }
  throw new Error(
    `Chunk download failed after ${MAX_ATTEMPTS} attempts: ${lastError || "unknown error"}`,
  );
}

async function runPool(items, worker, concurrency) {
  let index = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await worker(current);
    }
  });
  await Promise.all(workers);
}

async function downloadFull({
  url,
  dest,
  total,
  expectedSha256,
  progressRef,
  targetVersion,
  currentVersion,
}) {
  const part = partPath(dest);
  if (fs.existsSync(part)) {
    try {
      fs.unlinkSync(part);
    } catch {
      /* ignore */
    }
  }

  const response = await fetchWithTimeout(url, {}, CONNECT_TIMEOUT_MS + IDLE_TIMEOUT_MS);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Download failed (${response.status}): ${body}`);
  }

  const headerTotal = Number(response.headers.get("content-length") || 0);
  const trustedTotal = total > 0 ? total : headerTotal > 0 ? headerTotal : 0;
  const startedAt = Date.now();
  const fd = fs.openSync(part, "w");
  let downloaded = 0;
  let idleTimer = null;
  let idleReject = null;
  const idlePromise = new Promise((_, reject) => {
    idleReject = reject;
  });
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleReject(new Error(`Download idle for ${IDLE_TIMEOUT_MS / 1000}s`));
    }, IDLE_TIMEOUT_MS);
  };

  try {
    resetIdle();
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Download stream unavailable");
    while (true) {
      const readResult = await Promise.race([reader.read(), idlePromise]);
      const { done, value } = readResult;
      if (done) break;
      if (!value || !value.length) continue;
      resetIdle();
      fs.writeSync(fd, Buffer.from(value));
      downloaded += value.length;
      const speed = calcSpeedBps(startedAt, 0, downloaded);
      setProgress(progressRef, {
        phase: "downloading",
        downloaded,
        total: trustedTotal || downloaded,
        speedBps: speed,
        message: downloadMessage(targetVersion, downloaded, trustedTotal || downloaded, speed),
        currentVersion,
        targetVersion,
        error: null,
      });
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    fs.closeSync(fd);
  }

  if (trustedTotal > 0 && downloaded !== trustedTotal) {
    try {
      fs.unlinkSync(part);
    } catch {
      /* ignore */
    }
    throw new Error(`Size mismatch: expected ${trustedTotal} bytes, got ${downloaded}`);
  }

  const actual = await hashFile(part);
  if (actual.toLowerCase() !== expectedSha256.trim().toLowerCase()) {
    try {
      fs.unlinkSync(part);
    } catch {
      /* ignore */
    }
    throw new Error(`Checksum mismatch: expected ${expectedSha256}, got ${actual}`);
  }

  fs.renameSync(part, dest);
  setProgress(progressRef, {
    phase: "verified",
    downloaded,
    total: trustedTotal || downloaded,
    speedBps: 0,
    message: `${targetVersion} 安装包校验通过`,
    currentVersion,
    targetVersion,
    error: null,
  });
}

async function downloadRelease({
  url,
  dest,
  total,
  chunkSize,
  expectedSha256,
  progressRef,
  targetVersion,
  currentVersion,
}) {
  if (!expectedSha256) throw new Error("Update package missing sha256");
  if (!total) {
    await downloadFull({
      url,
      dest,
      total: 0,
      expectedSha256,
      progressRef,
      targetVersion,
      currentVersion,
    });
    return;
  }
  if (fs.existsSync(dest)) {
    try {
      fs.unlinkSync(dest);
    } catch {
      /* ignore */
    }
  }

  const effectiveChunkSize = Math.max(chunkSize || MIN_CHUNK_SIZE, MIN_CHUNK_SIZE);
  const chunkCount = Math.ceil(total / effectiveChunkSize);
  const downloadedCounter = { value: 0 };
  const pending = [];

  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * effectiveChunkSize;
    const expectedLen = Math.min(total - start, effectiveChunkSize);
    const chunkFile = chunkPath(dest, index);
    let existing = 0;
    try {
      existing = fs.statSync(chunkFile).size;
    } catch {
      existing = 0;
    }
    if (existing > expectedLen) {
      try {
        fs.unlinkSync(chunkFile);
      } catch {
        /* ignore */
      }
      pending.push({ index, start, expectedLen, chunkFile });
    } else {
      downloadedCounter.value += existing;
      if (existing < expectedLen) {
        pending.push({ index, start, expectedLen, chunkFile });
      }
    }
  }

  const baseline = downloadedCounter.value;
  const startedAt = Date.now();
  setProgress(progressRef, {
    phase: "downloading",
    downloaded: baseline,
    total,
    speedBps: 0,
    message: downloadMessage(targetVersion, baseline, total, 0),
    currentVersion,
    targetVersion,
    error: null,
  });

  const cleanupChunkArtifacts = () => {
    for (let index = 0; index < chunkCount; index += 1) {
      try {
        fs.unlinkSync(chunkPath(dest, index));
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(partPath(dest));
    } catch {
      /* ignore */
    }
  };

  const isRangeFallbackError = (error) => {
    const msg = String(error?.message || error);
    return (
      msg.includes("does not support Range") ||
      msg.includes("Content-Range") ||
      msg.includes("Range response")
    );
  };

  try {
    await runPool(
      pending,
      (item) =>
        downloadChunk({
          url,
          chunkFile: item.chunkFile,
          start: item.start,
          expectedLen: item.expectedLen,
          total,
          baseline,
          downloadedCounter,
          startedAt,
          progressRef,
          targetVersion,
          currentVersion,
        }),
      MAX_PARALLEL_CHUNKS,
    );

    const part = partPath(dest);
    const outFd = fs.openSync(part, "w");
    try {
      for (let index = 0; index < chunkCount; index += 1) {
        const start = index * effectiveChunkSize;
        const expectedLen = Math.min(total - start, effectiveChunkSize);
        const chunkFile = chunkPath(dest, index);
        const size = fs.statSync(chunkFile).size;
        if (size !== expectedLen) {
          throw new Error("Downloaded chunk has an invalid length");
        }
        const data = fs.readFileSync(chunkFile);
        fs.writeSync(outFd, data);
        try {
          fs.unlinkSync(chunkFile);
        } catch {
          /* ignore */
        }
      }
      fs.fsyncSync(outFd);
    } finally {
      fs.closeSync(outFd);
    }

    setProgress(progressRef, {
      phase: "verifying",
      downloaded: total,
      total,
      speedBps: 0,
      message: `正在校验 ${targetVersion} 安装包…`,
      currentVersion,
      targetVersion,
      error: null,
    });

    const partSize = fs.statSync(part).size;
    if (total > 0 && partSize !== total) {
      try {
        fs.unlinkSync(part);
      } catch {
        /* ignore */
      }
      throw new Error(`Size mismatch: expected ${total} bytes, got ${partSize}`);
    }

    const actual = await hashFile(part);
    if (actual.toLowerCase() !== expectedSha256.trim().toLowerCase()) {
      try {
        fs.unlinkSync(part);
      } catch {
        /* ignore */
      }
      throw new Error(`Checksum mismatch: expected ${expectedSha256}, got ${actual}`);
    }

    fs.renameSync(part, dest);
    setProgress(progressRef, {
      phase: "verified",
      downloaded: total,
      total,
      speedBps: 0,
      message: `${targetVersion} 安装包校验通过`,
      currentVersion,
      targetVersion,
      error: null,
    });
  } catch (error) {
    if (!isRangeFallbackError(error)) throw error;
    cleanupChunkArtifacts();
    await downloadFull({
      url,
      dest,
      total,
      expectedSha256,
      progressRef,
      targetVersion,
      currentVersion,
    });
  }
}

module.exports = {
  downloadRelease,
  downloadFull,
  hashFile,
  partPath,
  chunkPath,
};
