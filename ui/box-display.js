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

export function formatWanForDisplay(amountWan) {
  if (!Number.isFinite(amountWan) || amountWan <= 0) {
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
