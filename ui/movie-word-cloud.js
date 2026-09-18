/**
 * 3D 弹幕球：昵称:内容，缓慢匀速旋转，增量更新不整球重建。
 */

const MAX_ITEMS = 28;
const MIN_ITEMS = 20;
const ROTATE_SEC = 30;
const TRUNCATE_CHARS = 16;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncateLabel(text, max = TRUNCATE_CHARS) {
  const chars = Array.from(String(text || ""));
  if (chars.length <= max) return chars.join("");
  return `${chars.slice(0, max).join("")}…`;
}

function formatDanmakuLabel({ nickname, content }) {
  const nick = String(nickname || "观众").trim() || "观众";
  const body = String(content || "").trim();
  return truncateLabel(`${nick}:${body}`);
}

/** 斐波那契球面分布 */
function spherePoint(index, total, radius) {
  const n = Math.max(total, 1);
  const offset = 2 / n;
  const y = 1 - (index + 0.5) * offset;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = index * Math.PI * (3 - Math.sqrt(5));
  return {
    x: Math.cos(phi) * r * radius,
    y: y * radius,
    z: Math.sin(phi) * r * radius,
  };
}

const COLORS = ["#ffe08a", "#7ef0ff", "#ff9ad5", "#9dffb0", "#a8c8ff", "#ffd0a8"];

export function createMovieWordCloud(root) {
  if (!root) {
    return {
      addDanmaku() {},
      clear() {},
      destroy() {},
      getCount: () => 0,
    };
  }

  root.classList.add("ix-cloud");
  root.innerHTML = `
    <div class="ix-cloud__glow" aria-hidden="true"></div>
    <div class="ix-cloud__orbit ix-cloud__orbit--a" aria-hidden="true"></div>
    <div class="ix-cloud__orbit ix-cloud__orbit--b" aria-hidden="true"></div>
    <div class="ix-cloud__orbit ix-cloud__orbit--c" aria-hidden="true"></div>
    <div class="ix-cloud__sphere" id="ix-cloud-sphere"></div>
  `;

  const sphere = root.querySelector("#ix-cloud-sphere");
  /** @type {Map<string, { el: HTMLElement, msgId: string, fading?: boolean }>} */
  const items = new Map();
  let seq = 0;
  let destroyed = false;

  function relayout() {
    const list = [...items.values()].filter((it) => !it.fading);
    const total = list.length;
    const radius = 168;
    list.forEach((it, index) => {
      const p = spherePoint(index, total, radius);
      const depth = (p.z + radius) / (radius * 2);
      const scale = 0.55 + depth * 0.75;
      const opacity = 0.22 + depth * 0.78;
      it.el.style.transform = `translate3d(${p.x}px, ${p.y}px, ${p.z}px) scale(${scale})`;
      it.el.style.opacity = String(opacity);
      it.el.style.zIndex = String(Math.round(40 + depth * 60));
      it.el.style.fontSize = `${13 + depth * 11}px`;
      it.el.style.filter = depth > 0.45 ? "none" : "blur(0.35px)";
    });
  }

  function removeOldest() {
    const first = items.keys().next().value;
    if (!first) return;
    const it = items.get(first);
    if (!it) return;
    it.fading = true;
    it.el.classList.add("is-fade-out");
    window.setTimeout(() => {
      it.el.remove();
      items.delete(first);
      relayout();
    }, 480);
  }

  function addDanmaku(payload = {}) {
    if (destroyed) return false;
    const msgId = String(payload.msgId || `dm-${++seq}`);
    if (items.has(msgId)) return false;

    while (items.size >= MAX_ITEMS) removeOldest();

    const el = document.createElement("span");
    el.className = "ix-cloud__item is-fade-in";
    el.dataset.msgId = msgId;
    el.textContent = formatDanmakuLabel(payload);
    el.style.color = COLORS[seq % COLORS.length];
    sphere.appendChild(el);
    items.set(msgId, { el, msgId });
    relayout();
    window.requestAnimationFrame(() => el.classList.remove("is-fade-in"));
    return true;
  }

  function clear() {
    items.clear();
    if (sphere) sphere.innerHTML = "";
  }

  function destroy() {
    destroyed = true;
    clear();
  }

  // 正常模式不预置假弹幕；空球仅保留轨道光效
  return {
    addDanmaku,
    clear,
    destroy,
    getCount: () => items.size,
    formatDanmakuLabel,
    truncateLabel,
  };
}

export const WORD_CLOUD_ROTATE_SEC = ROTATE_SEC;
export { formatDanmakuLabel, truncateLabel };
