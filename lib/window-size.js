const { screen } = require("electron");

const DEFAULT_WIDTH = 525;
const DEFAULT_HEIGHT = 1080;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 400;
const MAX_WIDTH = 1200;
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

function resolveWindowSize(width, height, display) {
  const work = getWorkArea(display);
  const maxW = Math.min(MAX_WIDTH, work.width - SIDE_MARGIN);
  const maxH = work.height - WORK_AREA_MARGIN;

  return {
    width: clamp(Number(width) || DEFAULT_WIDTH, MIN_WIDTH, maxW),
    height: clamp(Number(height) || DEFAULT_HEIGHT, MIN_HEIGHT, maxH),
    maxWidth: maxW,
    maxHeight: maxH,
  };
}

module.exports = {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
  WORK_AREA_MARGIN,
  resolveWindowSize,
  getWorkArea,
};
