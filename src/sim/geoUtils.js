const Cesium = globalThis.Cesium;

/**
 * 地理坐标工具：统一“经纬度 <-> 模拟纹理 UV <-> 掩膜画布像素”的换算约定。
 *
 * 约定（与原版 SPH 管线保持一致）：
 *  - 高程图画布第 0 行（顶部）对应覆盖范围的北边界（north-up）。
 *  - 着色器内粒子坐标 pos/texSize 得到的 uv 中，v=0 采样的是纹理第 0 行，即北边界；
 *    因此把点击位置换算为着色器空间时取 v = 1 - latNorm（与原代码 centeredY = 1 - y 一致）。
 *  - 掩膜画布与高程图同为 north-up 位图直传 GPU（flipY:false），
 *    纹理第 0 行即画布顶部（北）；着色器 v=0 也对应北
 *    → 绘制多边形时 canvasY = v * size（v 为着色器空间值）。
 */

/** @typedef {[number, number, number, number]} ExtentDeg [minLon, minLat, maxLon, maxLat] */

export function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

/**
 * 经纬度 -> [u, v]（着色器/粒子纹理空间）
 */
export function cartoToSimUV(carto, extent) {
  const [minLon, minLat, maxLon, maxLat] = extent;
  const lon = Cesium.Math.toDegrees(carto.longitude);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const u = clamp01((lon - minLon) / (maxLon - minLon));
  // 着色器空间 v 取反（见文件头约定）
  const v = clamp01(1 - (lat - minLat) / (maxLat - minLat));
  return { u, v };
}

/**
 * 经纬度 -> 掩膜/高程画布像素坐标（north-up）
 */
export function cartoToCanvasPx(carto, extent, size) {
  const [minLon, minLat, maxLon, maxLat] = extent;
  const lon = Cesium.Math.toDegrees(carto.longitude);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  return {
    x: clamp01((lon - minLon) / (maxLon - minLon)) * size,
    y: (1 - clamp01((lat - minLat) / (maxLat - minLat))) * size,
  };
}

/**
 * 以中心点 + 米制宽高生成矩形范围（角度数组），用于无地理参考图片的手动放置。
 * @returns {ExtentDeg}
 */
export function rectangleAroundCenter(lon, lat, widthMeters, heightMeters) {
  const radiusMajor = 6378137.0;
  const dLat = Cesium.Math.toDegrees(heightMeters / radiusMajor);
  const dLon = Cesium.Math.toDegrees(
    widthMeters / (radiusMajor * Math.cos(Cesium.Math.toRadians(lat))),
  );
  return [
    lon - dLon / 2,
    Math.max(-89.9, lat - dLat / 2),
    lon + dLon / 2,
    Math.min(89.9, lat + dLat / 2),
  ];
}

export function extentIsValid(e) {
  return (
    Array.isArray(e) &&
    e.length === 4 &&
    e.every((x) => Number.isFinite(x)) &&
    e[0] < e[2] &&
    e[1] < e[3]
  );
}

export function extentAreaLabel(e) {
  if (!extentIsValid(e)) return "未定义";
  return `${Math.abs(e[2] - e[0]).toFixed(4)}°E-W × ${Math.abs(
    e[3] - e[1],
  ).toFixed(4)}°N-S`;
}
