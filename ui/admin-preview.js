import { applyOverlaySettings } from "./settings-applier.js";
import { renderDashboard } from "./dashboard-view.js";

const DESIGN_W = 1080;
const DESIGN_H = 1920;

const TARGET_SELECTORS = {
  heroTitle: ".live-header__title",
  heroSubtitle: ".live-header__subtitle",
  nationValue: "#nation-value",
  nationLabel: ".summary-bar__item--primary .summary-bar__label",
  summaryCard: "#top-card",
  liveBadge: ".live-badge",
  podiumCard: ".podium-card--r1",
  rankSection: ".ranking-section",
  trailerTitle: ".trailer-section__title",
  footer: ".live-footer__note",
  bubble: ".bubble-edit-hotspot",
};

const MOCK_MOVIES = [
  {
    movieId: 101,
    rank: 1,
    name: "《哪吒之魔童闹海》",
    todayBox: 3256.82,
    todayUnit: "万",
    boxRate: "32.5%",
    showCountRate: "28.1%",
    avgSeatView: "42.3%",
    dynamicForecast: "¥12.8亿",
  },
  {
    movieId: 102,
    rank: 2,
    name: "《唐探1900》",
    todayBox: 2188.45,
    todayUnit: "万",
    boxRate: "21.8%",
    showCountRate: "22.4%",
    avgSeatView: "38.6%",
    dynamicForecast: "¥8.5亿",
  },
  {
    movieId: 103,
    rank: 3,
    name: "《封神第二部》",
    todayBox: 1566.2,
    todayUnit: "万",
    boxRate: "15.6%",
    showCountRate: "18.2%",
    avgSeatView: "35.1%",
    dynamicForecast: "¥6.2亿",
  },
  {
    movieId: 104,
    rank: 4,
    name: "《熊出没·重启未来》",
    todayBox: 886.3,
    todayUnit: "万",
    boxRate: "8.8%",
    showCountRate: "12.5%",
    avgSeatView: "31.4%",
  },
  {
    movieId: 105,
    rank: 5,
    name: "《射雕英雄传》",
    todayBox: 654.1,
    todayUnit: "万",
    boxRate: "6.5%",
    showCountRate: "9.8%",
    avgSeatView: "28.9%",
  },
  {
    movieId: 106,
    rank: 6,
    name: "《蛟龙行动》",
    todayBox: 432.5,
    todayUnit: "万",
    boxRate: "4.3%",
    showCountRate: "7.2%",
    avgSeatView: "26.5%",
  },
  {
    movieId: 107,
    rank: 7,
    name: "《美国队长4》",
    todayBox: 298.7,
    todayUnit: "万",
    boxRate: "3.0%",
    showCountRate: "5.6%",
    avgSeatView: "24.1%",
  },
];

const MOCK_NATION = {
  todayBox: 9876.5,
  todayUnit: "万",
  viewCountDesc: "1234.5万",
  showCountDesc: "98.6万",
};

let currentSettings = null;
let selectedTarget = null;

function fitViewport() {
  const scale = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
  document.documentElement.style.setProperty("--viewport-scale", String(scale));
}

function injectPreviewStyles() {
  const style = document.createElement("style");
  style.id = "admin-preview-style";
  style.textContent = `
    body.admin-preview-mode { background: #020810; }
    body.admin-preview-mode .viewport { -webkit-app-region: no-drag !important; }
    body.admin-preview-mode #btn-login,
    body.admin-preview-mode #status,
    body.admin-preview-mode #status-hint { display: none !important; }
    body.admin-preview-mode [data-edit-target] { cursor: pointer; position: relative; }
    body.admin-preview-mode [data-edit-target]:hover::after {
      content: "";
      position: absolute;
      inset: -4px;
      border: 2px dashed rgba(255, 200, 100, 0.55);
      border-radius: 8px;
      pointer-events: none;
      z-index: 50;
    }
    body.admin-preview-mode [data-edit-target].edit-selected::after {
      border: 2px solid #ffb347;
      box-shadow: 0 0 0 3px rgba(255, 179, 71, 0.25);
    }
    body.admin-preview-mode .bubble-edit-hotspot {
      position: absolute;
      right: 24px;
      top: 42%;
      z-index: 60;
      padding: 6px 14px;
      border-radius: 999px;
      border: 1.5px dashed rgba(255, 120, 90, 0.6);
      background: rgba(28, 8, 14, 0.75);
      color: #ff8a8a;
      font-size: 12px;
      cursor: pointer;
      -webkit-app-region: no-drag;
    }
    body.admin-preview-mode .preview-hint {
      position: fixed;
      bottom: 12px;
      left: 50%;
      transform: translateX(-50%);
      padding: 6px 14px;
      border-radius: 999px;
      background: rgba(0, 0, 0, 0.65);
      color: rgba(255, 255, 255, 0.75);
      font-size: 12px;
      z-index: 100;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}

function tagEditableElements() {
  for (const [target, selector] of Object.entries(TARGET_SELECTORS)) {
    document.querySelectorAll(selector).forEach((el) => {
      el.dataset.editTarget = target;
    });
  }
}

function selectTarget(target) {
  selectedTarget = target;
  document.querySelectorAll("[data-edit-target]").forEach((el) => {
    el.classList.toggle("edit-selected", el.dataset.editTarget === target);
  });
  window.parent.postMessage({ type: "preview-select", target }, "*");
}

function bindClickSelection() {
  document.addEventListener(
    "click",
    (e) => {
      const el = e.target.closest("[data-edit-target]");
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      selectTarget(el.dataset.editTarget);
    },
    true
  );
}

function showDemoBubble() {
  const overlay = document.getElementById("delta-overlay");
  if (!overlay || !currentSettings?.bubble?.enabled) return;
  overlay.innerHTML = "";
  const bubble = document.createElement("span");
  bubble.className = "delta-bubble delta-bubble--pop";
  bubble.textContent = "+12.5万";
  bubble.style.left = "50%";
  bubble.style.top = "38%";
  overlay.appendChild(bubble);
  setTimeout(() => {
    if (bubble.parentNode) bubble.remove();
  }, currentSettings.bubble.durationMs || 3000);
}

function applySettings(settings) {
  currentSettings = settings;
  applyOverlaySettings(settings);
  if (selectedTarget === "bubble") showDemoBubble();
}

function renderMockDashboard() {
  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.style.display = "none";

  const timeEl = document.getElementById("header-time");
  if (timeEl) {
    const now = new Date();
    timeEl.textContent = now.toLocaleString("zh-CN", { hour12: false }).replace(/\//g, "-");
  }

  const trailerNow = document.getElementById("trailer-now");
  if (trailerNow) trailerNow.textContent = "正在播放：《哪吒之魔童闹海》";
  const trailerTitle = document.getElementById("trailer-overlay-title");
  if (trailerTitle) trailerTitle.textContent = "《哪吒之魔童闹海》";

  renderDashboard(MOCK_MOVIES, MOCK_NATION, { date: "2026-03-12" }, { isUpdating: false });
  tagEditableElements();
  addBubbleHotspot();
}

function addBubbleHotspot() {
  const zone = document.querySelector(".live-zone--top");
  if (!zone || zone.querySelector(".bubble-edit-hotspot")) return;
  const spot = document.createElement("button");
  spot.type = "button";
  spot.className = "bubble-edit-hotspot";
  spot.dataset.editTarget = "bubble";
  spot.textContent = "↑ 上涨气泡";
  zone.appendChild(spot);
}

window.addEventListener("message", (e) => {
  const msg = e.data || {};
  if (msg.type === "preview-settings" && msg.settings) {
    applySettings(msg.settings);
  }
  if (msg.type === "preview-highlight" && msg.target) {
    selectTarget(msg.target);
  }
  if (msg.type === "preview-demo-bubble") {
    showDemoBubble();
  }
});

document.body.classList.add("admin-preview-mode");
injectPreviewStyles();
fitViewport();
window.addEventListener("resize", fitViewport, { passive: true });

const hint = document.createElement("div");
hint.className = "preview-hint";
hint.textContent = "点击界面元素即可在右侧编辑配色";
document.body.appendChild(hint);

renderMockDashboard();
window.parent.postMessage({ type: "preview-ready" }, "*");
