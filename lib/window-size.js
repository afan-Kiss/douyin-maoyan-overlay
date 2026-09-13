const { screen } = require("electron");

const DESIGN_WIDTH = 1080;
const DESIGN_HEIGHT = 1920;
/** 桌面预览默认 0.5 缩放；内部 #viewport 画布恒为 1080×1920 */
const DEFAULT_WIDTH = 540;
const DEFAULT_HEIGHT = 960;
const LIVE_OUTPUT_WIDTH = DESIGN_WIDTH;
const LIVE_OUTPUT_HEIGHT = DESIGN_HEIGHT;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 400;
const MAX_WIDTH = 1200;
const MAX_HEIGHT = DESIGN_HEIGHT;
const WORK_AREA_MARGIN = 60;
const SIDE_MARGIN = 40;

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

function resolveWindowSize(width, height, display, options = {}) {
  if (options.liveOutput) {
    return {
      width: LIVE_OUTPUT_WIDTH,
      height: LIVE_OUTPUT_HEIGHT,
      maxWidth: LIVE_OUTPUT_WIDTH,
      maxHeight: LIVE_OUTPUT_HEIGHT,
      liveOutput: true,
    };
  }

  const work = getWorkArea(display);
  const maxW = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, work.width - SIDE_MARGIN));
  const maxH = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, work.height - WORK_AREA_MARGIN));

  return {
    width: clamp(Number(width) || DEFAULT_WIDTH, MIN_WIDTH, maxW),
    height: clamp(Number(height) || DEFAULT_HEIGHT, MIN_HEIGHT, maxH),
    maxWidth: maxW,
    maxHeight: maxH,
    liveOutput: false,
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
  WORK_AREA_MARGIN,
  resolveWindowSize,
  getWorkArea,
};
