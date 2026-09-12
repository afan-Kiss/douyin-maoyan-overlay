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
  const movieTitle = f.movieTitle || 20;
  const nationBox = f.nationBox || 27;

  root.style.setProperty("--bubble-color", b.color || "#ff4d4d");
  root.style.setProperty(
    "--bubble-bg",
    `linear-gradient(135deg, ${b.bgStart || "rgba(28,8,14,0.92)"} 0%, ${b.bgEnd || "rgba(48,10,18,0.88)"} 100%)`
  );
  root.style.setProperty("--bubble-border", b.borderColor || "rgba(255,90,90,0.5)");
  root.style.setProperty("--bubble-shadow", b.shadowColor || "rgba(255,60,80,0.32)");
  root.style.setProperty("--bubble-glow", b.glowColor || "rgba(255,77,109,0.22)");
  root.style.setProperty("--bubble-font-size", `${b.fontSize || 12}px`);
  root.style.setProperty("--bubble-duration", `${b.durationMs || 1600}ms`);
  root.style.setProperty("--bubble-float", `${b.floatHeight || 44}px`);

  root.style.setProperty("--font-sans", '"HarmonyOS Sans SC", "HarmonyOS Sans", sans-serif');
  root.style.setProperty("--font-hero-title", `${f.heroTitle || 32}px`);
  root.style.setProperty("--font-hero-sub", `${f.heroSubtitle || 15}px`);
  root.style.setProperty("--font-nation-box", `${nationBox}px`);
  root.style.setProperty("--font-nation-label", `${f.nationLabel || 14}px`);
  root.style.setProperty("--font-movie-title", `${movieTitle}px`);
  root.style.setProperty("--font-movie-rank", `${f.movieRank || 14}px`);
  root.style.setProperty("--font-region", `${f.region || 13}px`);
  root.style.setProperty("--font-metric-label", `${f.metricLabel || 12}px`);
  root.style.setProperty("--font-metric-value", `${f.metricValue || 14}px`);
  root.style.setProperty("--font-table", `${f.table || 12}px`);
  root.style.setProperty("--font-compact-title", `${Math.round(movieTitle * 1.1)}px`);
  root.style.setProperty("--font-compact-box", `${Math.round(movieTitle * 1.1)}px`);
  root.style.setProperty("--font-compact-forecast", `${f.metricLabel || 12}px`);
  root.style.setProperty("--font-compact-delta", `${f.metricLabel || 12}px`);
  root.style.setProperty("--font-compact-metric", `${f.metricLabel || 12}px`);
  root.style.setProperty("--font-podium-title", `${Math.round(movieTitle * 0.9)}px`);
  root.style.setProperty("--font-podium-title-rank1", `${Math.round(movieTitle * 0.95)}px`);
  root.style.setProperty("--font-podium-box", `${nationBox}px`);
  root.style.setProperty("--font-podium-box-rank1", `${Math.round(nationBox * 1.14)}px`);
  root.style.setProperty("--color-frame-border", "rgba(214, 169, 72, 0.32)");

  root.style.setProperty("--color-accent", c.accent || "#ff5a5a");
  root.style.setProperty("--color-accent-soft", c.accentSoft || "#ff6b6b");
  root.style.setProperty("--color-nation-value", c.nationValue || "#ffd699");
  root.style.setProperty("--color-metric-value", c.metricValue || "rgba(255,230,200,0.95)");
  root.style.setProperty("--color-card-border", c.cardBorder || "rgba(255,255,255,0.08)");
  root.style.setProperty("--color-card-bg", c.cardBg || "rgba(255,255,255,0.05)");
  root.style.setProperty(
    "--title-gradient",
    `linear-gradient(90deg, ${c.titleGradientStart || "#fff"} 0%, ${c.titleGradientMid || "#ffd4a8"} 50%, ${c.titleGradientEnd || "#ff8a5c"} 100%)`
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

