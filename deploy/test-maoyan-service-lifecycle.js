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

async function testHealthFailureKillsOwnProcessOnly() {
  const svc = loadService();
  svc._testResetMaoyanState();

  const child = makeFakeChild(2001);
  let killed = false;
  child.kill = () => {
    killed = true;
    child.killed = true;
    child.emit("exit", 0);
    return true;
  };

  svc._testSetState({
    maoyanProcess: child,
    startedByUs: true,
    apiStatus: { ready: true, error: "", apiBase: "http://127.0.0.1:8765" },
  });
  svc._testSetCheckHealth(async () => false);

  await svc.getApiStatus();
  const state = svc._testGetState();
  assert.strictEqual(killed, true);
  assert.strictEqual(state.maoyanProcess, null);
  assert.strictEqual(state.startedByUs, false);
  console.log("OK: health failure shuts down own child via production code");
}

async function testShutdownWaitBeforeRestart() {
  const svc = loadService();
  svc._testResetMaoyanState();

  const oldChild = makeFakeChild(3001);
  let exitSeen = false;
  oldChild.on("exit", () => {
    exitSeen = true;
  });

  svc._testSetState({ maoyanProcess: oldChild, startedByUs: true, apiStatus: { ready: true } });
  await svc.shutdownMaoyanServiceAndWait(1000);

  const state = svc._testGetState();
  assert.strictEqual(exitSeen, true);
  assert.strictEqual(state.maoyanProcess, null);
  assert.strictEqual(state.startedByUs, false);
  assert.strictEqual(state.apiStatus.ready, false);
  console.log("OK: shutdownMaoyanServiceAndWait clears own child state after exit");
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

async function main() {
  testOldChildExitDoesNotPolluteNewChild();
  await testHealthFailureKillsOwnProcessOnly();
  await testShutdownWaitBeforeRestart();
  await testUnknownServiceNotKilled();
  console.log("\nALL PASSED (maoyan service lifecycle)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
