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
  const heroTitle = f.heroTitle ?? 72;
  const heroSub = f.heroSubtitle ?? 28;
  const nationBox = f.nationBox ?? 38;
  const nationLabel = f.nationLabel ?? 24;
  const movieTitleRank1 = f.movieTitleRank1 ?? f.movieTitle ?? 46;
  const movieTitleFollow = f.movieTitleFollow ?? Math.round((f.movieTitle ?? 37) * 1);
  const movieBoxRank1 = f.movieBoxRank1 ?? 52;
  const movieBoxFollow = f.movieBoxFollow ?? 41;
  const metricLabel = f.metricLabel ?? 22;
  const metricValue = f.metricValue ?? 29;
  const metricValueRank1 = f.metricValueRank1 ?? 32;

  root.style.setProperty("--bubble-color", b.color || "#ffd27a");
  root.style.setProperty(
    "--bubble-bg",
    `linear-gradient(135deg, ${b.bgStart || "rgba(60,12,18,0.94)"} 0%, ${b.bgEnd || "rgba(90,18,24,0.9)"} 100%)`
  );
  root.style.setProperty("--bubble-border", b.borderColor || "rgba(255,196,110,0.55)");
  root.style.setProperty("--bubble-shadow", b.shadowColor || "rgba(255,170,60,0.35)");
  root.style.setProperty("--bubble-glow", b.glowColor || "rgba(255,200,100,0.25)");
  root.style.setProperty("--bubble-font-size", `${b.fontSize || 18}px`);
  root.style.setProperty("--bubble-duration", `${b.durationMs || 3000}ms`);
  root.style.setProperty("--bubble-float", `${b.floatHeight || 44}px`);

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
  root.style.setProperty("--font-movie-rank", `${f.movieRank ?? 25}px`);
  root.style.setProperty("--font-region", `${f.region ?? 18}px`);
  root.style.setProperty("--font-metric-label", `${metricLabel}px`);
  root.style.setProperty("--font-metric-value", `${metricValue}px`);
  root.style.setProperty("--font-metric-value-rank1", `${metricValueRank1}px`);
  root.style.setProperty("--font-sum-box-rank1", `${f.sumBoxRank1 ?? 34}px`);
  root.style.setProperty("--font-sum-box-follow", `${f.sumBoxFollow ?? 30}px`);
  root.style.setProperty("--font-table", `${f.table || 12}px`);
  root.style.setProperty("--font-delta", `${f.metricValue || 14}px`);
  root.style.setProperty("--font-champ", `${Math.round((f.heroSubtitle || 28) * 0.95)}px`);
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
    .delta-bubble--pop { animation-duration: ${b.durationMs || 3000}ms; }
  `;
}
