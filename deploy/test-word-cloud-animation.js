/**
 * 词云球动画回归：轨道/辉光 CSS 动画存在；JS 球面旋转位置随时间变化。
 * node deploy/test-word-cloud-animation.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");

async function main() {
  const css = fs.readFileSync(path.join(ROOT, "ui", "styles.css"), "utf8");
  assert.ok(css.includes("cloudOrbitSpinA"), "missing orbit A keyframes");
  assert.ok(css.includes("cloudOrbitSpinB"), "missing orbit B keyframes");
  assert.ok(css.includes("cloudOrbitSpinC"), "missing orbit C keyframes");
  assert.ok(css.includes("cloudGlowPulse"), "missing glow pulse");
  assert.ok(/animation:\s*cloudOrbitSpinA\s+21s\s+linear\s+infinite/.test(css));
  assert.ok(/animation:\s*cloudOrbitSpinB\s+30s\s+linear\s+infinite/.test(css));
  assert.ok(/animation:\s*cloudOrbitSpinC\s+24s\s+linear\s+infinite/.test(css));
  assert.ok(/animation:\s*cloudGlowPulse\s+5s/.test(css));
  assert.ok(!/ix-cloud__sphere\s*\{[^}]*animation:\s*cloudSpin/s.test(css), "sphere should use JS spin, not CSS cloudSpin");

  // JS 模块：旋转后坐标应变化
  const { JSDOM } = (() => {
    try {
      return require("jsdom");
    } catch {
      return { JSDOM: null };
    }
  })();

  if (!JSDOM) {
    // 无 jsdom 时仅校验 CSS + 源码包含 rAF 旋转
    const src = fs.readFileSync(path.join(ROOT, "ui", "movie-word-cloud.js"), "utf8");
    assert.ok(src.includes("requestAnimationFrame"), "word cloud must animate via rAF");
    assert.ok(src.includes("rotateY"), "word cloud must rotate around Y");
    assert.ok(src.includes("getItemPositions"), "expose positions for visual checks");
    console.log("PASS word-cloud animation (css + source, no jsdom)");
    return;
  }

  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    pretendToBeVisual: true,
    url: "http://127.0.0.1/",
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  global.performance = dom.window.performance;

  const mod = await import(pathToFileURL(path.join(ROOT, "ui", "movie-word-cloud.js")).href);
  const cloud = mod.createMovieWordCloud(document.getElementById("root"));
  for (let i = 0; i < 24; i += 1) {
    cloud.addDanmaku({ msgId: `t-${i}`, nickname: `U${i}`, content: `弹幕${i}` });
  }
  assert.strictEqual(cloud.getCount(), 24);
  const p0 = cloud.getItemPositions()[0];
  await new Promise((r) => setTimeout(r, 1200));
  const p1 = cloud.getItemPositions().find((p) => p.msgId === p0.msgId) || cloud.getItemPositions()[0];
  const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  assert.ok(moved > 5, `expected visible orbit move, got ${moved}`);
  cloud.destroy();
  console.log("PASS word-cloud animation (css + jsdom rotation)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
