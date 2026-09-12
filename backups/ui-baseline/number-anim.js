const activeAnims = new WeakMap();

export function formatWan(value, unit = "万") {
  if (!Number.isFinite(value) || value <= 0) return "--";
  if (unit === "亿" || value >= 10000) {
    return `${(value / 10000).toFixed(2)}亿`;
  }
  return `${value.toFixed(2)}${unit}`;
}

export function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function animateNumber(el, from, to, options = {}) {
  if (!el) return;
  const duration = options.duration ?? 450;
  const formatter = options.formatter ?? ((v) => v.toFixed(2));
  const fromVal = safeNum(from);
  const toVal = safeNum(to);

  if (!Number.isFinite(toVal) || toVal <= 0) {
    el.textContent = "--";
    return;
  }

  if (Math.abs(toVal - fromVal) < 0.001 || options.skipAnim) {
    el.textContent = formatter(toVal);
    return;
  }

  const prev = activeAnims.get(el);
  if (prev) cancelAnimationFrame(prev);

  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = fromVal + (toVal - fromVal) * eased;
    el.textContent = formatter(current);
    if (t < 1) {
      activeAnims.set(el, requestAnimationFrame(tick));
    } else {
      activeAnims.delete(el);
      el.textContent = formatter(toVal);
    }
  };
  activeAnims.set(el, requestAnimationFrame(tick));
}

export function setEncodedBox(el, html, unitEl, unit = "万") {
  if (!el) return;
  if (html) {
    el.classList.add("mtsi-font");
    if (el.innerHTML !== html) el.innerHTML = html;
    if (unitEl) unitEl.textContent = unit;
    return;
  }
  el.classList.remove("mtsi-font");
  el.textContent = "--";
  if (unitEl) unitEl.textContent = unit;
}
