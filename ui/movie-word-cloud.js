/**
 * 3D 弹幕球：昵称:内容，Y 轴连续旋转；每帧按深度更新 scale/opacity/zIndex。
 * 空球时轨道/辉光由 CSS 持续动画（不造假弹幕）。
 */

const MAX_ITEMS = 28;
const MIN_ITEMS = 20;
const ROTATE_SEC = 30;
const TRUNCATE_CHARS = 16;
const SPHERE_RADIUS = 150;
const TILT_X_DEG = 8;

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

/** 斐波那契球面分布（本地坐标，未旋转） */
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

function rotateY(point, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: point.x * cos + point.z * sin,
    y: point.y,
    z: -point.x * sin + point.z * cos,
  };
}

function rotateX(point, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: point.x,
    y: point.y * cos - point.z * sin,
    z: point.y * sin + point.z * cos,
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
      getItemPositions: () => [],
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
  /** @type {Map<string, { el: HTMLElement, msgId: string, base: {x:number,y:number,z:number}, fading?: boolean }>} */
  const items = new Map();
  let seq = 0;
  let destroyed = false;
  let rotationY = 0;
  let lastTs = 0;
  let rafId = 0;
  const tiltX = (TILT_X_DEG * Math.PI) / 180;
  const radPerMs = (Math.PI * 2) / (ROTATE_SEC * 1000);

  function visibleItems() {
    return [...items.values()].filter((it) => !it.fading);
  }

  function assignBasePositions() {
    const list = visibleItems();
    const total = list.length;
    list.forEach((it, index) => {
      it.base = spherePoint(index, total, SPHERE_RADIUS);
    });
  }

  function paintFrame() {
    const list = visibleItems();
    for (const it of list) {
      const base = it.base || { x: 0, y: 0, z: 0 };
      const spun = rotateX(rotateY(base, rotationY), tiltX);
      const depth = (spun.z + SPHERE_RADIUS) / (SPHERE_RADIUS * 2);
      // 前景 28~40；中景 22~28；后景最低 18~20；最前可达 ~40
      const fontSize = 18 + depth * 22;
      it.el.style.fontSize = `${fontSize.toFixed(1)}px`;
      // 深度缩放收窄，主要靠字号分层，避免字被二次放大糊掉
      const scale = 0.88 + depth * 0.18;
      const opacity = 0.42 + depth * 0.58;
      it.el.style.transform = `translate3d(${spun.x.toFixed(2)}px, ${spun.y.toFixed(2)}px, ${spun.z.toFixed(2)}px) scale(${scale.toFixed(3)})`;
      it.el.style.opacity = String(opacity.toFixed(3));
      it.el.style.zIndex = String(Math.round(40 + depth * 60));
      it.el.style.filter = "none";
    }
  }

  function tick(ts) {
    if (destroyed) return;
    if (!lastTs) lastTs = ts;
    const dt = Math.min(64, ts - lastTs);
    lastTs = ts;
    rotationY = (rotationY + dt * radPerMs) % (Math.PI * 2);
    if (items.size) paintFrame();
    rafId = window.requestAnimationFrame(tick);
  }

  function ensureSpinning() {
    if (destroyed || rafId) return;
    lastTs = 0;
    rafId = window.requestAnimationFrame(tick);
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
      assignBasePositions();
      paintFrame();
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
    items.set(msgId, { el, msgId, base: { x: 0, y: 0, z: 0 } });
    assignBasePositions();
    paintFrame();
    ensureSpinning();
    window.requestAnimationFrame(() => el.classList.remove("is-fade-in"));
    return true;
  }

  function clear() {
    items.clear();
    if (sphere) sphere.innerHTML = "";
  }

  function destroy() {
    destroyed = true;
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
    clear();
  }

  function getItemPositions() {
    return visibleItems().map((it) => {
      const spun = rotateX(rotateY(it.base || { x: 0, y: 0, z: 0 }, rotationY), tiltX);
      return {
        msgId: it.msgId,
        x: spun.x,
        y: spun.y,
        z: spun.z,
        text: it.el.textContent || "",
      };
    });
  }

  // 空球也持续跑 rAF（几乎空转），保证后续弹幕立刻进入旋转相位；轨道靠 CSS
  ensureSpinning();

  return {
    addDanmaku,
    clear,
    destroy,
    getCount: () => items.size,
    getItemPositions,
    getRotationY: () => rotationY,
    formatDanmakuLabel,
    truncateLabel,
  };
}

export const WORD_CLOUD_ROTATE_SEC = ROTATE_SEC;
export const WORD_CLOUD_MIN_ITEMS = MIN_ITEMS;
export const WORD_CLOUD_MAX_ITEMS = MAX_ITEMS;
export { formatDanmakuLabel, truncateLabel, escapeHtml };
