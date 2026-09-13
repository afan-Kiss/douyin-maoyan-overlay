export const DESIGN_W = 1080;
export const DESIGN_H = 1920;

const SIZE_TOLERANCE = 6;

/** Pick the largest simple fraction <= raw so transform:scale stays sharp */
export function snapCrispScale(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  if (raw >= 0.999) return 1;
  let best = Math.floor(raw * 1000) / 1000;
  for (let denom = 1; denom <= 32; denom++) {
    const numer = Math.floor(raw * denom);
    if (numer < 1) continue;
    const snapped = numer / denom;
    if (snapped > best && snapped <= raw) best = snapped;
  }
  return best;
}

function near(value, target, tolerance = SIZE_TOLERANCE) {
  return Math.abs(value - target) <= tolerance;
}

function clearViewportFitStyles(viewport) {
  viewport.classList.remove("viewport--native", "viewport--half", "viewport--scaled");
  viewport.style.transform = "";
  viewport.style.width = "";
  viewport.style.height = "";
  viewport.style.marginRight = "";
  viewport.style.marginBottom = "";
  viewport.style.transformOrigin = "";
}

/** Scale while collapsing layout box so flex-centered iframes show content */
function applyScaledViewport(viewport, scale) {
  viewport.classList.add("viewport--scaled");
  viewport.style.width = `${DESIGN_W}px`;
  viewport.style.height = `${DESIGN_H}px`;
  viewport.style.transformOrigin = "top left";
  document.documentElement.style.setProperty("--viewport-scale", String(scale));

  if (scale >= 0.999) {
    viewport.style.transform = "none";
    viewport.style.marginRight = "";
    viewport.style.marginBottom = "";
    return;
  }

  viewport.style.transform = `scale(${scale}) translateZ(0)`;
  viewport.style.marginRight = `${DESIGN_W * scale - DESIGN_W}px`;
  viewport.style.marginBottom = `${DESIGN_H * scale - DESIGN_H}px`;
}

export function fitDesignViewport() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const viewport = document.getElementById("viewport");
  if (!viewport) return;

  clearViewportFitStyles(viewport);

  const params = new URLSearchParams(window.location.search);
  const forceNative = params.get("liveOutput") === "1";

  if (forceNative || (near(vw, DESIGN_W) && near(vh, DESIGN_H))) {
    viewport.classList.add("viewport--native");
    document.documentElement.style.setProperty("--viewport-scale", "1");
    return;
  }

  const raw = Math.min(vw / DESIGN_W, vh / DESIGN_H);
  const scale = snapCrispScale(Math.max(raw, 0.05));
  applyScaledViewport(viewport, scale);
}

export function bindDesignViewport() {
  window.addEventListener("resize", fitDesignViewport, { passive: true });
  // iframe 初次布局可能尚未稳定，多帧再拟合一次
  fitDesignViewport();
  requestAnimationFrame(() => {
    fitDesignViewport();
    requestAnimationFrame(fitDesignViewport);
  });
}
