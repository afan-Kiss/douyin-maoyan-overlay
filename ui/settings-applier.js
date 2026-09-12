let overlaySettings = null;

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

  const movieTitle = Number(f.movieTitle) || 34;
  const nationBox = Number(f.nationBox) || 56;
  const nationLabel = Number(f.nationLabel) || 22;
  const metricLabel = Number(f.metricLabel) || 12;
  const metricValue = Number(f.metricValue) || 14;
  const table = Number(f.table) || 30;
  const footer = Number(f.footer) || 11;

  root.style.setProperty("--bubble-color", b.color || "#ff4d4d");
  root.style.setProperty(
    "--bubble-bg",
    `linear-gradient(135deg, ${b.bgStart || "rgba(28,8,14,0.92)"} 0%, ${b.bgEnd || "rgba(48,10,18,0.88)"} 100%)`
  );
  root.style.setProperty("--bubble-border", b.borderColor || "rgba(255,90,90,0.5)");
  root.style.setProperty("--bubble-shadow", b.shadowColor || "rgba(255,60,80,0.32)");
  root.style.setProperty("--bubble-glow", b.glowColor || "rgba(255,77,109,0.22)");
  root.style.setProperty("--bubble-font-size", `${b.fontSize || 22}px`);
  root.style.setProperty("--bubble-duration", `${b.durationMs || 1600}ms`);
  root.style.setProperty("--bubble-float", `${b.floatHeight || 44}px`);

  root.style.setProperty("--font-sans", '"HarmonyOS Sans SC", "HarmonyOS Sans", sans-serif');
  root.style.setProperty("--font-hero-title", `${f.heroTitle || 64}px`);
  root.style.setProperty("--font-hero-sub", `${f.heroSubtitle || 24}px`);
  root.style.setProperty("--font-nation-box", `${nationBox}px`);
  root.style.setProperty("--font-nation-secondary", `${Math.round(nationBox * 0.58)}px`);
  root.style.setProperty("--font-nation-label", `${nationLabel}px`);
  root.style.setProperty("--font-podium-title-rank1", `${Math.round(movieTitle * 0.95)}px`);
  root.style.setProperty("--font-podium-title", `${Math.round(movieTitle * 0.85)}px`);
  root.style.setProperty("--font-podium-box-rank1", `${Math.round(nationBox * 1.05)}px`);
  root.style.setProperty("--font-podium-box", `${Math.round(nationBox * 0.72)}px`);
  root.style.setProperty("--font-podium-delta", `${metricLabel + 10}px`);
  root.style.setProperty("--font-podium-stat-label", `${metricLabel + 8}px`);
  root.style.setProperty("--font-podium-stat-value", `${metricValue}px`);
  root.style.setProperty("--font-movie-rank", `${f.movieRank || 28}px`);
  root.style.setProperty("--font-rank-num", `${f.movieRank || 28}px`);
  root.style.setProperty("--font-rank-name", `${table}px`);
  root.style.setProperty("--font-rank-box", `${metricValue + 8}px`);
  root.style.setProperty("--font-rank-round", `${metricLabel + 10}px`);
  root.style.setProperty("--font-trailer-title", `${Math.round(movieTitle * 0.9)}px`);
  root.style.setProperty("--font-trailer-movie", `${Math.round(movieTitle * 1.05)}px`);

  root.style.setProperty("--color-accent", c.accent || "#ff5a5a");
  root.style.setProperty("--color-accent-soft", c.accentSoft || "#ff6b6b");
  root.style.setProperty("--color-nation-value", c.nationValue || "#ffffff");
  root.style.setProperty("--color-metric-value", c.metricValue || "rgba(255,245,230,0.95)");
  root.style.setProperty("--color-card-border", c.cardBorder || "rgba(120,200,220,0.22)");
  root.style.setProperty("--color-card-bg", c.cardBg || "rgba(8,24,36,0.55)");
  root.style.setProperty(
    "--title-gradient",
    `linear-gradient(180deg, ${c.titleGradientStart || "#fff8e8"} 0%, ${c.titleGradientMid || "#f0d080"} 28%, ${c.titleGradientEnd || "#c9a040"} 52%, #8a6520 78%, #f5e0a0 100%)`
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
    .delta-bubble--pop { animation-duration: ${b.durationMs || 1600}ms; }
    .live-footer__note { font-size: ${footer}px; }
  `;
}
