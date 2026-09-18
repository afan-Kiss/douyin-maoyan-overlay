/**
 * 窗口 9:16 比例归一化
 * node deploy/test-window-aspect-ratio.js
 */
const assert = require("assert");
const path = require("path");

// electron 的 screen 在纯 Node 下不可用；为测试注入假 display
const Module = require("module");
const electronStub = {
  screen: {
    getPrimaryDisplay() {
      return {
        workArea: { width: 1920, height: 1040, x: 0, y: 0 },
        workAreaSize: { width: 1920, height: 1040 },
        size: { width: 1920, height: 1080 },
      };
    },
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronStub;
  return originalLoad(request, parent, isMain);
};

const {
  resolveWindowSize,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  LIVE_OUTPUT_WIDTH,
  LIVE_OUTPUT_HEIGHT,
  ASPECT_RATIO,
  DESIGN_WIDTH,
  DESIGN_HEIGHT,
  isNearAspect,
} = require(path.join(__dirname, "..", "lib", "window-size.js"));

Module._load = originalLoad;

function nearlyAspect(w, h) {
  const got = w / h;
  const expect = DESIGN_WIDTH / DESIGN_HEIGHT;
  return Math.abs(got - expect) < 0.01;
}

function main() {
  // 默认 540×960
  const def = resolveWindowSize(DEFAULT_WIDTH, DEFAULT_HEIGHT);
  assert.strictEqual(def.width, 540, "default width 540");
  assert.strictEqual(def.height, 960, "default height 960");
  assert.ok(nearlyAspect(def.width, def.height), "default 9:16");
  assert.strictEqual(def.liveOutput, false);

  // 525×1080 错误比例 → 回退默认可视 540×960（不再沿用错误宽度）
  const bad = resolveWindowSize(525, 1080);
  assert.strictEqual(bad.width, 540, "bad aspect resets to default width");
  assert.strictEqual(bad.height, 960, "bad aspect resets to default height");
  assert.ok(nearlyAspect(bad.width, bad.height), "525×1080 normalized to 9:16");
  assert.ok(!isNearAspect(525, 1080), "525×1080 is not near 9:16");

  // 1000×900 / 1920×1080 横向错误尺寸 → 同样回退默认
  const landscape = resolveWindowSize(1000, 900);
  assert.strictEqual(landscape.width, 540);
  assert.strictEqual(landscape.height, 960);

  // 已是 9:16 的 600×1067：工作区足够时保持宽 600
  const tallDisplay = {
    workArea: { width: 1920, height: 1400, x: 0, y: 0 },
  };
  const wide = resolveWindowSize(600, Math.round((600 * 16) / 9), tallDisplay);
  assert.strictEqual(wide.width, 600);
  assert.strictEqual(wide.height, Math.round((600 * 16) / 9)); // 1067
  assert.ok(nearlyAspect(wide.width, wide.height), "600×1067 stays 9:16");

  // 工作区不够高时：限高后反推宽度，仍保持 9:16
  const shortDisplay = {
    workArea: { width: 1920, height: 1040, x: 0, y: 0 },
  };
  const wideClamped = resolveWindowSize(600, Math.round((600 * 16) / 9), shortDisplay);
  assert.ok(wideClamped.height <= 1040 - 60, "600 height clamped to work area");
  assert.ok(nearlyAspect(wideClamped.width, wideClamped.height), "600 clamped still 9:16");
  assert.ok(Math.abs(wideClamped.width / wideClamped.height - 1080 / 1920) < 0.01);

  // liveOutput 保持 1080×1920
  const live = resolveWindowSize(525, 1080, null, { liveOutput: true });
  assert.strictEqual(live.width, LIVE_OUTPUT_WIDTH);
  assert.strictEqual(live.height, LIVE_OUTPUT_HEIGHT);
  assert.strictEqual(live.liveOutput, true);

  // 比例常数
  assert.ok(Math.abs(ASPECT_RATIO - 9 / 16) < 1e-9);
  assert.ok(Math.abs(DESIGN_WIDTH / DESIGN_HEIGHT - 9 / 16) < 1e-9);

  // 超高工作区受限时反推宽度
  const tinyDisplay = {
    workArea: { width: 800, height: 500, x: 0, y: 0 },
  };
  const clamped = resolveWindowSize(540, 960, tinyDisplay);
  assert.ok(clamped.height <= 500 - 60, "height within work area");
  assert.ok(nearlyAspect(clamped.width, clamped.height), "clamped still 9:16");

  console.log("test-window-aspect-ratio: OK");
  console.log(`  540×960 default`);
  console.log(`  525×1080 → ${bad.width}×${bad.height}`);
  console.log(`  600×1067 → ${wide.width}×${wide.height}`);
  console.log(`  liveOutput ${live.width}×${live.height}`);
}

main();
