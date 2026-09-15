/** 内部票房统一为「万」；显示单位由数值自行决定 */

function formatAmountDigits(n) {
  if (n >= 1000) {
    // 接近整数时不显示 .1 噪声（例如 1100.04 → 1100）
    if (Math.abs(n - Math.round(n)) < 0.05) return String(Math.round(n));
    const text = n.toFixed(1);
    return text.endsWith(".0") ? text.slice(0, -2) : text;
  }
  return n.toFixed(2);
}

/** 只允许可见的「万/亿」；PUA/空串一律回落万，避免数字后单位空白 */
export function sanitizeBoxUnit(unit) {
  const raw = String(unit || "").trim();
  if (!raw) return "万";
  if (raw.includes("亿")) return "亿";
  if (raw.includes("万")) return "万";
  // 反爬未解码的私用区字符不能当单位写进 DOM
  if (/[\uE000-\uF8FF]/.test(raw)) return "万";
  return "万";
}

export function formatWanForDisplay(amountWan) {
  if (!Number.isFinite(amountWan) || amountWan <= 0) {
    // 占位时仍保留「万」，防止 unit 节点被清空后看起来像「万字没了」
    return { valueText: "--", unit: "万" };
  }

  if (amountWan >= 10000) {
    const yi = amountWan / 10000;
    const valueText = yi >= 1000 ? formatAmountDigits(yi) : yi.toFixed(2);
    return { valueText, unit: "亿" };
  }

  return { valueText: formatAmountDigits(amountWan), unit: "万" };
}

export function formatWanDisplayText(amountWan) {
  const { valueText, unit } = formatWanForDisplay(amountWan);
  return `${valueText}${unit}`;
}

/** 去掉整数部分前导 0，保留猫眼原始小数精度（避免 1028.94 → 1028.9） */
export function stripLeadingZerosFromBoxText(text, unit = "万") {
  const raw = String(text).trim();
  if (!raw) return "";
  const safeUnit = sanitizeBoxUnit(unit);
  const withUnit = raw.includes("万") || raw.includes("亿") ? raw : `${raw}${safeUnit}`;
  return withUnit.replace(/^0+(\d)/, "$1");
}

/** 将解码文本（可能带前导 0）规范为统一显示，内部单位：万 */
export function formatBoxTextForDisplay(text, unit = "万", parseBoxNum) {
  if (!text || text === "--") return "";
  const safeUnit = sanitizeBoxUnit(unit);
  const cleaned = stripLeadingZerosFromBoxText(text, safeUnit);
  if (!cleaned) return "";
  if (typeof parseBoxNum === "function") {
    const amountWan = parseBoxNum(cleaned, safeUnit);
    if (!Number.isFinite(amountWan) || amountWan <= 0) return "";
  }
  // 再保险：最终串必须带可见万/亿
  if (!cleaned.includes("万") && !cleaned.includes("亿")) return `${cleaned}${safeUnit}`;
  return cleaned;
}
