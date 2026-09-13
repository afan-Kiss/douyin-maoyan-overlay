/**
 * 回归：实时票房解码失败时不得清掉已缓存可信数字（避免一会有一会没有）
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

async function loadRank() {
  const mod = await import(
    pathToFileURL(path.join(__dirname, "..", "ui", "dashboard-rank.js")).href
  );
  return mod;
}

function stabilizeNationLike(nation, lastGoodNation, isUntrustedBoxDecode) {
  const isEmptyField = (val) => {
    if (val == null) return true;
    const text = String(val).trim();
    return !text || text === "--" || text === "-";
  };
  const stable = { ...nation };
  for (const field of ["todayBoxHtml", "todayUnit", "todayBoxText"]) {
    if (isEmptyField(stable[field])) {
      const cached = lastGoodNation[field];
      if (!isEmptyField(cached)) stable[field] = cached;
    }
  }
  if (
    stable.todayBox <= 0 &&
    lastGoodNation.todayBox > 0 &&
    !isUntrustedBoxDecode(String(lastGoodNation.todayBoxText || lastGoodNation.todayBox))
  ) {
    stable.todayBox = lastGoodNation.todayBox;
    if (isEmptyField(stable.todayBoxText) && !isEmptyField(lastGoodNation.todayBoxText)) {
      stable.todayBoxText = lastGoodNation.todayBoxText;
    }
  }
  const boxText = String(stable.todayBoxText || "").trim();
  if (stable.todayBox > 0 && boxText && boxText !== "--" && isUntrustedBoxDecode(boxText)) {
    stable.todayBox = 0;
  }
  return stable;
}

function shouldPreferEncodedBoxLike(movie, isUntrustedBoxDecode) {
  if (!movie?.todayBoxHtml) return false;
  const text = String(movie.todayBoxText || "").trim();
  const amount = Number(movie.todayBox) || 0;
  if (amount > 0 && text && text !== "--" && !isUntrustedBoxDecode(text)) return false;
  if (amount > 0 && !isUntrustedBoxDecode(String(amount))) return false;
  return true; // 模拟字体就绪且有编码 html
}

async function main() {
  const { isUntrustedBoxDecode } = await loadRank();

  // 旧逻辑 bug：todayBoxText="--" 会把刚回填的 todayBox 再次清零
  const lastGood = { todayBox: 1234.5, todayBoxText: "1234.5", todayUnit: "万" };
  const failedRound = {
    todayBox: 0,
    todayBoxText: "--",
    todayBoxHtml: "&#xe601;",
    todayUnit: "万",
  };
  const stable = stabilizeNationLike(failedRound, lastGood, isUntrustedBoxDecode);
  assert.strictEqual(stable.todayBox, 1234.5, "解码失败应回填 lastGood.todayBox");
  assert.strictEqual(stable.todayBoxText, "1234.5", "应同步回填 todayBoxText");

  // 有可信明文时不得优先乱码
  const prefer = shouldPreferEncodedBoxLike(
    {
      todayBox: 1234.5,
      todayBoxText: "1234.5",
      todayBoxHtml: "&#xe601;",
      decodeStatus: "encoded",
    },
    isUntrustedBoxDecode,
  );
  assert.strictEqual(prefer, false, "有缓存明文时禁止走编码字形");

  // "--" 本身不能否掉已有数字（isUntrusted 对空数字串为 true，但新逻辑要忽略）
  assert.strictEqual(isUntrustedBoxDecode("--"), true, "前置：-- 被判定 untrusted");
  const notCleared = stabilizeNationLike(
    { todayBox: 88.8, todayBoxText: "--", todayBoxHtml: "" },
    {},
    isUntrustedBoxDecode,
  );
  assert.strictEqual(notCleared.todayBox, 88.8, '"--" 文本不得把 todayBox 清零');

  console.log("test-box-stabilize: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
