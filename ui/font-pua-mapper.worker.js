/**
 * CPU 密集的 PUA 字体映射在独立线程执行，避免阻塞首屏渲染。
 */
import {
  buildPuaMapFromFontBuffer,
  MAP_CONFIDENCE,
  computeVersionKeyAsync,
} from "./font-pua-mapper.js";
import {
  validateNationCrossCheck,
  validateDecodedBoxStructure,
  isUntrustedBoxDecode,
  parseBoxNum,
  parseRate,
} from "./pua-cross-helpers.js";

const helpers = {
  validateNationCrossCheck,
  validateDecodedBoxStructure,
  isUntrustedBoxDecode,
  parseBoxNum,
  parseRate,
};

function serializeMap(map) {
  if (!map) return null;
  return [...map.entries()];
}

function serializeBuilt(built) {
  if (!built) return built;
  return {
    ...built,
    map: serializeMap(built.map),
  };
}

self.addEventListener("message", async (event) => {
  const msg = event.data || {};
  if (msg.type !== "build") return;
  const { id, fontBuffer, fontStyle, crossContext, budget, simulateDelayMs = 0 } = msg;
  try {
    if (simulateDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, simulateDelayMs));
    }
    const versionKey = await computeVersionKeyAsync(fontStyle, fontBuffer);
    const built = await buildPuaMapFromFontBuffer(fontBuffer, fontStyle, {
      versionKey,
      crossContext,
      helpers,
      budget,
    });
    self.postMessage({
      type: "result",
      id,
      ok: true,
      built: serializeBuilt(built),
    });
  } catch (error) {
    self.postMessage({
      type: "result",
      id,
      ok: false,
      error: String(error?.message || error || "worker_build_failed"),
    });
  }
});
