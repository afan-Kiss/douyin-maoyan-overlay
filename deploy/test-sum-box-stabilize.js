/**
 * 累计票房解析与跳变保护
 * node deploy/test-sum-box-stabilize.js
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

async function main() {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "ui", "dashboard-rank.js")).href);
  const { resolveMaoyanSumBoxWan, stabilizeSumBoxWan, parseBoxNum } = mod;

  // desc 优先：带亿/万
  assert.strictEqual(resolveMaoyanSumBoxWan({ sumBoxDesc: "3.39亿" }), 33900);
  assert.strictEqual(resolveMaoyanSumBoxWan({ sumBoxDesc: "6452.9万" }), 6452.9);
  assert.strictEqual(parseBoxNum("21.77亿"), 217700);

  // desc 优先于错误数字字段
  assert.strictEqual(
    resolveMaoyanSumBoxWan({ sumBoxDesc: "21.77亿", sumBox: 2100 }),
    217700,
    "desc with 亿 must beat bare numeric",
  );

  // 元量级数字回退
  assert.strictEqual(resolveMaoyanSumBoxWan({ sumBox: 339_000_000 }), 33900);

  // 累计 < 实时 → 保留旧值
  const lt = stabilizeSumBoxWan(100, { prevWan: 20000, todayBoxWan: 500 });
  assert.strictEqual(lt.ok, false);
  assert.strictEqual(lt.reason, "sum_lt_today");
  assert.strictEqual(lt.valueWan, 20000);
  assert.strictEqual(lt.keptPrevious, true);

  // 1亿 → 7亿 暴跳
  const jump = stabilizeSumBoxWan(70000, { prevWan: 10000, todayBoxWan: 100 });
  assert.strictEqual(jump.ok, false);
  assert.strictEqual(jump.reason, "sudden_jump");
  assert.strictEqual(jump.valueWan, 10000);

  // 正常增长
  const ok = stabilizeSumBoxWan(218000, {
    prevWan: 217700,
    todayBoxWan: 43,
    rawDesc: "21.80亿",
  });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.valueWan, 218000);

  // 数值偏离 desc → 对齐 desc
  const align = stabilizeSumBoxWan(2100, {
    prevWan: 0,
    todayBoxWan: 40,
    rawDesc: "21.77亿",
  });
  assert.strictEqual(align.valueWan, 217700);
  assert.strictEqual(align.reason, "aligned_to_desc");

  console.log("PASS sum box stabilize");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
