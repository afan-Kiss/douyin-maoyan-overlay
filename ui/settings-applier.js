let overlaySettings = null;

function clampFont(n, fallback, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

export function getOverlaySettings() {
  return overlaySettings;
}

export function applyOverlaySettings(settings) {
  if (!settings) return;
  overlaySettings = settings;

  const root = document.documentElement;
  const b = settings.bubble || {};
  const f = settings.fonts || {};
  const c = settings.colors || {};
  // 赛马榜布局安全上限：远程后台过大字号会导致顶部大盘与 NO.1 卡片重叠
  const heroTitle = clampFont(f.heroTitle, 72, 28, 72);
  const heroSub = clampFont(f.heroSubtitle, 28, 14, 32);
  const nationBox = clampFont(f.nationBox, 38, 18, 42);
  const nationLabel = clampFont(f.nationLabel, 22, 12, 24);
  const movieTitleRank1 = clampFont(f.movieTitleRank1 ?? f.movieTitle, 42, 22, 44);
  const movieTitleFollow = clampFont(f.movieTitleFollow ?? f.movieTitle, 36, 20, 40);
  const movieBoxRank1 = clampFont(f.movieBoxRank1, 52, 24, 56);
  const movieBoxFollow = clampFont(f.movieBoxFollow, 41, 22, 48);
  const metricLabel = clampFont(f.metricLabel, 18, 12, 22);
  const metricValue = clampFont(f.metricValue, 26, 14, 30);
  const metricValueRank1 = clampFont(f.metricValueRank1 ?? f.metricValue, 28, 16, 32);
  const tableFont = clampFont(f.table, 24, 12, 26);

  root.style.setProperty("--bubble-color", b.color || "#52e878");
  root.style.setProperty(
    "--bubble-bg",
    `linear-gradient(135deg, ${b.bgStart || "rgba(12,40,22,0.94)"} 0%, ${b.bgEnd || "rgba(18,56,30,0.9)"} 100%)`
  );
  root.style.setProperty("--bubble-border", b.borderColor || "rgba(82,232,120,0.65)");
  root.style.setProperty("--bubble-shadow", b.shadowColor || "rgba(82,232,120,0.35)");
  root.style.setProperty("--bubble-glow", b.glowColor || "rgba(82,232,120,0.45)");
  root.style.setProperty("--bubble-font-size", `${b.fontSize || 34}px`);
  root.style.setProperty("--bubble-duration", `${b.durationMs || 3000}ms`);
  root.style.setProperty("--bubble-float", `${b.floatHeight || 52}px`);

  root.style.setProperty("--font-sans", '"HarmonyOS Sans SC", "HarmonyOS Sans", "PingFang SC", "Microsoft YaHei", sans-serif');
  root.style.setProperty("--font-hero-title", `${heroTitle}px`);
  root.style.setProperty("--font-hero-sub", `${heroSub}px`);
  root.style.setProperty("--font-nation-box", `${nationBox}px`);
  root.style.setProperty("--font-nation-label", `${nationLabel}px`);
  root.style.setProperty("--font-movie-title", `${movieTitleFollow}px`);
  root.style.setProperty("--font-movie-title-rank1", `${movieTitleRank1}px`);
  root.style.setProperty("--font-movie-box-rank1", `${movieBoxRank1}px`);
  root.style.setProperty("--font-movie-title-follow", `${movieTitleFollow}px`);
  root.style.setProperty("--font-movie-box-follow", `${movieBoxFollow}px`);
  root.style.setProperty("--font-movie-rank", `${clampFont(f.movieRank, 25, 12, 32)}px`);
  root.style.setProperty("--font-region", `${clampFont(f.region, 18, 12, 22)}px`);
  root.style.setProperty("--font-metric-label", `${metricLabel}px`);
  root.style.setProperty("--font-metric-value", `${metricValue}px`);
  root.style.setProperty("--font-metric-value-rank1", `${metricValueRank1}px`);
  root.style.setProperty("--font-sum-box-rank1", `${clampFont(f.sumBoxRank1, 34, 18, 38)}px`);
  root.style.setProperty("--font-sum-box-follow", `${clampFont(f.sumBoxFollow, 30, 16, 34)}px`);
  root.style.setProperty("--font-table", `${tableFont}px`);
  root.style.setProperty("--font-delta", `${clampFont(f.metricValue, 14, 10, 22)}px`);
  root.style.setProperty("--font-champ", `${Math.round(heroSub * 0.95)}px`);
  root.style.setProperty("--font-time", `${nationLabel}px`);
  root.style.setProperty("--color-frame-border", "rgba(214, 169, 72, 0.38)");

  root.style.setProperty("--color-accent", c.accent || "#e8b45a");
  root.style.setProperty("--color-accent-soft", c.accentSoft || "#f0c878");
  root.style.setProperty("--color-nation-value", c.nationValue || "#ffe2a8");
  root.style.setProperty("--color-metric-value", c.metricValue || "rgba(255,236,210,0.96)");
  root.style.setProperty("--color-card-border", c.cardBorder || "rgba(212,168,90,0.42)");
  root.style.setProperty("--color-card-bg", c.cardBg || "rgba(48,8,14,0.72)");
  root.style.setProperty(
    "--title-gradient",
    `linear-gradient(180deg, ${c.titleGradientStart || "#fff6df"} 0%, ${c.titleGradientMid || "#f0d08a"} 42%, ${c.titleGradientEnd || "#c9963a"} 100%)`
  );

  const styleId = "dynamic-bubble-keyframes";
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = styleId;
    document.head.appendChild(styleEl);
  }
  const floatPx = b.floatHeight || 44;
  styleEl.textContent = `
    @keyframes deltaBubblePop {
      0% { opacity: 0; transform: translate3d(-50%, 10px, 0) scale(0.75); }
      12% { opacity: 0.92; transform: translate3d(-50%, 0, 0) scale(1.08); }
      22% { opacity: 0.9; transform: translate3d(-50%, -6px, 0) scale(1); }
      75% { opacity: 0.88; transform: translate3d(-50%, -${Math.round(floatPx * 0.64)}px, 0) scale(1); }
      100% { opacity: 0; transform: translate3d(-50%, -${floatPx}px, 0) scale(0.92); }
    }
    .delta-bubble--pop { animation-duration: ${b.durationMs || 3000}ms; }
  `;
}
