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
  const movieTitle = f.movieTitle || 24;
  const nationBox = f.nationBox || 32;

  root.style.setProperty("--bubble-color", b.color || "#ffd27a");
  root.style.setProperty(
    "--bubble-bg",
    `linear-gradient(135deg, ${b.bgStart || "rgba(60,12,18,0.94)"} 0%, ${b.bgEnd || "rgba(90,18,24,0.9)"} 100%)`
  );
  root.style.setProperty("--bubble-border", b.borderColor || "rgba(255,196,110,0.55)");
  root.style.setProperty("--bubble-shadow", b.shadowColor || "rgba(255,170,60,0.35)");
  root.style.setProperty("--bubble-glow", b.glowColor || "rgba(255,200,100,0.25)");
  root.style.setProperty("--bubble-font-size", `${b.fontSize || 18}px`);
  root.style.setProperty("--bubble-duration", `${b.durationMs || 1600}ms`);
  root.style.setProperty("--bubble-float", `${b.floatHeight || 44}px`);

  root.style.setProperty("--font-sans", '"HarmonyOS Sans SC", "HarmonyOS Sans", "PingFang SC", "Microsoft YaHei", sans-serif');
  root.style.setProperty("--font-hero-title", `${f.heroTitle || 56}px`);
  root.style.setProperty("--font-hero-sub", `${f.heroSubtitle || 18}px`);
  root.style.setProperty("--font-nation-box", `${nationBox}px`);
  root.style.setProperty("--font-nation-label", `${f.nationLabel || 14}px`);
  root.style.setProperty("--font-movie-title", `${movieTitle}px`);
  root.style.setProperty("--font-movie-rank", `${f.movieRank || 17}px`);
  root.style.setProperty("--font-region", `${f.region || 18}px`);
  root.style.setProperty("--font-metric-label", `${f.metricLabel || 12}px`);
  root.style.setProperty("--font-metric-value", `${f.metricValue || 14}px`);
  root.style.setProperty("--font-table", `${f.table || 12}px`);
  root.style.setProperty("--font-delta", `${f.metricValue || 14}px`);
  root.style.setProperty("--font-footer", `${f.footer || 13}px`);
  root.style.setProperty("--font-champ", `${Math.round((f.heroSubtitle || 18) * 0.95)}px`);
  root.style.setProperty("--font-time", `${f.nationLabel || 14}px`);
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
    .delta-bubble--pop { animation-duration: ${b.durationMs || 1600}ms; }
  `;
}
