/**
 * 屏幕像素 → #global-bubble-layer 设计坐标。
 * getBoundingClientRect 是缩放后的屏幕像素；layer 的 left/top 是 1080×1920 本地坐标。
 * 禁止假设 scale === 1，禁止把 rect 差值直接写入 left/top。
 */

export function layerScale(layer) {
  const layerRect = layer.getBoundingClientRect();
  const localWidth = layer.offsetWidth || layerRect.width || 1;
  const localHeight = layer.offsetHeight || layerRect.height || 1;
  const screenWidth = layerRect.width || localWidth;
  const screenHeight = layerRect.height || localHeight;
  return {
    layerRect,
    localWidth,
    localHeight,
    scaleX: localWidth / screenWidth,
    scaleY: localHeight / screenHeight,
  };
}

export function screenPointToLayer(x, y, layer) {
  const { layerRect, scaleX, scaleY } = layerScale(layer);
  return {
    x: (x - layerRect.left) * scaleX,
    y: (y - layerRect.top) * scaleY,
  };
}

export function rectToLayerRect(rect, layer) {
  if (!rect) return null;
  const tl = screenPointToLayer(rect.left, rect.top, layer);
  const br = screenPointToLayer(rect.right, rect.bottom, layer);
  return {
    left: tl.x,
    top: tl.y,
    right: br.x,
    bottom: br.y,
    width: br.x - tl.x,
    height: br.y - tl.y,
    centerX: (tl.x + br.x) / 2,
    centerY: (tl.y + br.y) / 2,
  };
}

export const BUBBLE_MARGIN = 8;

/**
 * 先算锚点，再换算到 layer 本地坐标，最后按气泡宽高 clamp。
 * 上方放不下才改到锚点下方。不做按排名偏移。
 * mode=center：返回值 left 是中心 X（配合 translateX(-50%)）。
 * mode=edge：返回值 left 是左边缘。
 */
export function computeBubblePosition(layer, anchorEl, bubbleEl, options = {}) {
  const margin = options.margin ?? BUBBLE_MARGIN;
  const gap = options.gap ?? 10;
  const stackIndex = Math.max(0, Number(options.stackIndex) || 0);
  const stackStep = Number(options.stackStep) || 0;
  const mode = options.mode === "edge" ? "edge" : "center";
  const anchor = rectToLayerRect(anchorEl.getBoundingClientRect(), layer);
  const width = Math.max(bubbleEl.offsetWidth || 0, 1);
  const height = Math.max(bubbleEl.offsetHeight || 0, 1);
  const localW = layer.offsetWidth || 1;
  const localH = layer.offsetHeight || 1;
  const stack = stackIndex * stackStep;

  let top = anchor.top - gap - height - stack;
  const aboveOk = top >= margin;
  if (!aboveOk) {
    const below = anchor.bottom + gap + stack;
    top = below + height <= localH - margin ? below : margin;
  }
  if (top + height > localH - margin) {
    top = Math.max(margin, localH - height - margin);
  }
  if (top < margin) top = margin;

  if (mode === "center") {
    const half = width / 2;
    const left = Math.max(margin + half, Math.min(anchor.centerX, localW - margin - half));
    return { left, top, width, height, anchor, mode };
  }

  let left = anchor.centerX - width / 2;
  left = Math.max(margin, Math.min(left, localW - width - margin));
  const overlaps =
    left + width >= anchor.left && left <= anchor.right;
  if (!overlaps) {
    if (left + width < anchor.left) left = anchor.left;
    else left = anchor.right - width;
    left = Math.max(margin, Math.min(left, localW - width - margin));
  }
  return { left, top, width, height, anchor, mode };
}

export function readViewportScale() {
  if (typeof document === "undefined") return 1;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--viewport-scale");
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
