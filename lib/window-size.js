const { screen } = require("electron");

const DESIGN_WIDTH = 1080;
const DESIGN_HEIGHT = 1920;
/** 桌面预览默认 0.5 缩放；内部 #viewport 画布恒为 1080×1920 */
const DEFAULT_WIDTH = 540;
const DEFAULT_HEIGHT = 960;
const LIVE_OUTPUT_WIDTH = DESIGN_WIDTH;
const LIVE_OUTPUT_HEIGHT = DESIGN_HEIGHT;
const MIN_WIDTH = 360;
const MIN_HEIGHT = Math.round((MIN_WIDTH * 16) / 9); // 640，保持 9:16
const MAX_WIDTH = 1200;
const MAX_HEIGHT = DESIGN_HEIGHT;
const WORK_AREA_MARGIN = 60;
const SIDE_MARGIN = 40;
/** 设计画布与预览窗口必须保持 9:16 */
const ASPECT_W = 9;
const ASPECT_H = 16;
const ASPECT_RATIO = ASPECT_W / ASPECT_H;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function getWorkArea(display) {
  const d = display || screen.getPrimaryDisplay();
  return d.workArea || {
    width: d.workAreaSize?.width || d.size?.width || 1920,
    height: d.workAreaSize?.height || d.size?.height || 1080,
  };
}

/**
 * 非 liveOutput：始终归一化为 9:16。
 * 以 width 为优先：height = round(width * 16 / 9)；
 * 若 height 超出工作区上限，先限高再反推 width。
 */
function normalizePreviewAspect(width, _height, maxW, maxH) {
  let w = Number(width);
  if (!Number.isFinite(w) || w <= 0) w = DEFAULT_WIDTH;
  w = clamp(Math.round(w), MIN_WIDTH, maxW);

  // 以 width 为优先推导 height；忽略错误比例的传入 height（如 525×1080）
  let h = Math.round((w * ASPECT_H) / ASPECT_W);

  if (h > maxH) {
    h = maxH;
    w = Math.round((h * ASPECT_W) / ASPECT_H);
    w = clamp(w, MIN_WIDTH, maxW);
    h = Math.round((w * ASPECT_H) / ASPECT_W);
    if (h > maxH) {
      h = maxH;
      w = Math.round((h * ASPECT_W) / ASPECT_H);
    }
  }

  return { width: w, height: h };
}

function resolveWindowSize(width, height, display, options = {}) {
  if (options.liveOutput) {
    return {
      width: LIVE_OUTPUT_WIDTH,
      height: LIVE_OUTPUT_HEIGHT,
      maxWidth: LIVE_OUTPUT_WIDTH,
      maxHeight: LIVE_OUTPUT_HEIGHT,
      liveOutput: true,
      aspectRatio: ASPECT_RATIO,
    };
  }

  const work = getWorkArea(display);
  const availableW = Math.max(MIN_WIDTH, work.width - SIDE_MARGIN);
  const availableH = Math.max(1, work.height - WORK_AREA_MARGIN);
  const maxW = Math.min(MAX_WIDTH, availableW);
  // 不可用 Math.max(MIN_HEIGHT, availableH)：小屏时会把上限抬到超过工作区
  const maxH = Math.min(MAX_HEIGHT, availableH);
  const normalized = normalizePreviewAspect(width, height, maxW, maxH);

  return {
    width: normalized.width,
    height: normalized.height,
    maxWidth: maxW,
    maxHeight: maxH,
    liveOutput: false,
    aspectRatio: ASPECT_RATIO,
  };
}

module.exports = {
  DESIGN_WIDTH,
  DESIGN_HEIGHT,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  LIVE_OUTPUT_WIDTH,
  LIVE_OUTPUT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
  MAX_WIDTH,
  MAX_HEIGHT,
  WORK_AREA_MARGIN,
  ASPECT_W,
  ASPECT_H,
  ASPECT_RATIO,
  normalizePreviewAspect,
  resolveWindowSize,
  getWorkArea,
};
