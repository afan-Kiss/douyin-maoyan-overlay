/**
 * 猫眼子进程生命周期验收：node deploy/test-maoyan-service-lifecycle.js
 */
const assert = require("assert");
const { EventEmitter } = require("events");

function makeFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => child.emit("exit", 0));
    return true;
  };
  return child;
}

function loadService() {
  delete require.cache[require.resolve("../maoyan-service")];
  return require("../maoyan-service");
}

function testOldChildExitDoesNotPolluteNewChild() {
  const svc = loadService();
  svc._testResetMaoyanState();

  const oldChild = makeFakeChild(1001);
  const newChild = makeFakeChild(1002);

  svc._testSetState({
    maoyanProcess: newChild,
    startedByUs: true,
    apiStatus: { ready: true, error: "" },
  });

  svc._testHandleChildExit(oldChild, 1);
  let state = svc._testGetState();
  assert.strictEqual(state.maoyanProcess, newChild);
  assert.strictEqual(state.startedByUs, true);
  assert.strictEqual(state.apiStatus.ready, true);

  svc._testHandleChildExit(newChild, 0);
  state = svc._testGetState();
  assert.strictEqual(state.maoyanProcess, null);
  assert.strictEqual(state.startedByUs, false);
  assert.strictEqual(state.apiStatus.ready, false);
  console.log("OK: old child exit does not pollute new child state");
}

async function testShutdownWaitBeforeRestart() {
  const svc = loadService();
  svc._testResetMaoyanState();

  const oldChild = makeFakeChild(3001);
  let exitSeen = false;
  oldChild.on("exit", () => {
    exitSeen = true;
  });

  svc._testSetWaitForPidGone(async () => true);
  svc._testSetState({ maoyanProcess: oldChild, startedByUs: true, apiStatus: { ready: true } });
  const stopped = await svc.shutdownMaoyanServiceAndWait(200);

  const state = svc._testGetState();
  assert.strictEqual(stopped, true);
  assert.strictEqual(exitSeen, true);
  assert.strictEqual(state.maoyanProcess, null);
  assert.strictEqual(state.startedByUs, false);
  assert.strictEqual(state.apiStatus.ready, false);
  console.log("OK: shutdownMaoyanServiceAndWait clears own child state after exit");
}

async function testStuckChildBlocksRestart() {
  const svc = loadService();
  svc._testResetMaoyanState();

  const stuckChild = makeFakeChild(4001);
  stuckChild.kill = () => true;

  let maoyanStartCount = 0;
  svc._testSetWaitForPidGone(async () => false);
  svc._testSetSpawn((cmd, args) => {
    if (cmd === "taskkill") return makeFakeChild(0);
    maoyanStartCount += 1;
    return makeFakeChild(4002);
  });
  svc._testSetCheckHealth(async () => false);
  svc._testSetState({
    maoyanProcess: stuckChild,
    startedByUs: true,
    apiStatus: { ready: true, error: "", apiBase: "http://127.0.0.1:8765" },
  });

  const stopped = await svc.shutdownMaoyanServiceAndWait(200);
  assert.strictEqual(stopped, false);

  const status = await svc.ensureMaoyanService({ apiBase: "http://127.0.0.1:8765" });
  assert.strictEqual(status.ready, false);
  assert.match(status.error, /未能退出/);
  assert.strictEqual(maoyanStartCount, 0);
  assert.strictEqual(svc._testGetState().maoyanProcess, stuckChild);
  console.log("OK: stuck own child blocks new maoyan spawn");
}

async function testUnknownServiceNotKilled() {
  const svc = loadService();
  svc._testResetMaoyanState();

  let taskkillCalled = false;
  svc._testSetSpawn((cmd, args) => {
    if (cmd === "taskkill") taskkillCalled = true;
    return makeFakeChild(0);
  });
  svc._testSetCheckHealth(async () => true);
  svc._testSetState({ maoyanProcess: null, startedByUs: false });

  await svc.ensureMaoyanService({ apiBase: "http://127.0.0.1:8765" });
  assert.strictEqual(taskkillCalled, false);
  console.log("OK: unknown external service is not killed");
}

function testHealthDataDirBinding() {
  const svc = loadService();
  const ownDir = "C:\\Users\\test\\AppData\\Roaming\\MaoyanOverlay\\maoyan-data";
  const otherDir = "C:\\Users\\test\\AppData\\Roaming\\douyin-maoyan-overlay\\maoyan-data";
  assert.strictEqual(svc.healthResponseMatches({ ok: true, dataDir: ownDir }, ownDir), true);
  assert.strictEqual(svc.healthResponseMatches({ ok: true, dataDir: otherDir }, ownDir), false);
  assert.strictEqual(svc.healthResponseMatches({ ok: true }, ownDir), false);
  console.log("OK: health response requires matching dataDir when present");
}

async function testMismatchedDataDirTriggersRecover() {
  const svc = loadService();
  svc._testResetMaoyanState();

  let taskkillCalled = false;
  svc._testSetSpawn((cmd, args) => {
    if (cmd === "taskkill") taskkillCalled = true;
    return makeFakeChild(0);
  });
  svc._testSetPortListening(async () => true);
  svc._testSetCheckHealth(async () => false);
  // 无自有 sidecar → 不得杀陌生进程
  svc._testSetFindListeningPids(async () => [9999]);
  svc._testSetState({ maoyanProcess: null, startedByUs: false });

  const result = await svc.recoverStalePort("http://127.0.0.1:8765");
  assert.strictEqual(taskkillCalled, false);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, "PORT_OCCUPIED_BY_FOREIGN_PROCESS");
  console.log("OK: foreign pid occupying 8765 is not killed");
}

async function testOwnSidecarCanBeRecycled() {
  const svc = loadService();
  svc._testResetMaoyanState();

  const own = makeFakeChild(7001);
  let taskkillArgs = null;
  svc._testSetSpawn((cmd, args) => {
    if (cmd === "taskkill") {
      taskkillArgs = args;
      return makeFakeChild(0);
    }
    return makeFakeChild(0);
  });
  svc._testSetPortListening(async () => true);
  svc._testSetCheckHealth(async () => false);
  svc._testSetFindListeningPids(async () => [7001]);
  svc._testSetState({ maoyanProcess: own, startedByUs: true });

  const result = await svc.recoverStalePort("http://127.0.0.1:8765");
  assert.strictEqual(result.ok, true);
  assert.ok(taskkillArgs, "own sidecar should be taskkilled");
  assert.ok(taskkillArgs.includes("7001"));
  console.log("OK: own sidecar pid can be recycled");
}

async function testForeignHealthMismatchStillRefuseKill() {
  const svc = loadService();
  svc._testResetMaoyanState();

  let taskkillCalled = false;
  svc._testSetSpawn((cmd) => {
    if (cmd === "taskkill") taskkillCalled = true;
    return makeFakeChild(0);
  });
  svc._testSetPortListening(async () => true);
  svc._testSetCheckHealth(async () => false);
  svc._testSetFindListeningPids(async () => [8888]);
  svc._testSetState({ maoyanProcess: null, startedByUs: false });

  const result = await svc.recoverStalePort("http://127.0.0.1:8765");
  assert.strictEqual(taskkillCalled, false);
  assert.strictEqual(result.code, "PORT_OCCUPIED_BY_FOREIGN_PROCESS");
  console.log("OK: mismatched foreign health does not trigger taskkill");
}

async function main() {
  testOldChildExitDoesNotPolluteNewChild();
  await testShutdownWaitBeforeRestart();
  await testStuckChildBlocksRestart();
  await testUnknownServiceNotKilled();
  testHealthDataDirBinding();
  await testMismatchedDataDirTriggersRecover();
  await testOwnSidecarCanBeRecycled();
  await testForeignHealthMismatchStillRefuseKill();
  console.log("\nALL PASSED (maoyan service lifecycle)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
