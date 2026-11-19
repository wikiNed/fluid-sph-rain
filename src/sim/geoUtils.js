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

/** 地球平均半径（米），用于球面多边形面积计算 */
const EARTH_RADIUS_M = 6371008.8;

function pointToRadians(p) {
  if (!p) return null;
  // Cesium.Cartographic：longitude / latitude 已经是弧度
  if (Number.isFinite(p.longitude) && Number.isFinite(p.latitude)) {
    return { lon: p.longitude, lat: p.latitude };
  }
  // {lon, lat} 十进制度
  if (Number.isFinite(p.lon) && Number.isFinite(p.lat)) {
    return {
      lon: Cesium.Math.toRadians(p.lon),
      lat: Cesium.Math.toRadians(p.lat),
    };
  }
  return null;
}

/**
 * 多边形覆盖的地表面积（km²）。
 *
 * 用球面多边形面积公式（对每条边沿纬向积分）：
 *   A = R²/2 · |Σ (λ₂ − λ₁)(sin φ₁ + sin φ₂)|
 * 顶点顺序顺时针/逆时针均可（结果取绝对值），对几十公里的区域精度优于 1%。
 *
 * @param {Array} points Cesium.Cartographic（弧度）或 {lon,lat}（度）顶点数组
 * @returns {number} 面积 km²，输入不合法时返回 0
 */
export function polygonAreaKm2(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = pointToRadians(points[i]);
    const b = pointToRadians(points[(i + 1) % points.length]);
    if (!a || !b) return 0;
    sum += (b.lon - a.lon) * (Math.sin(a.lat) + Math.sin(b.lat));
  }
  const areaM2 = Math.abs(sum) * 0.5 * EARTH_RADIUS_M * EARTH_RADIUS_M;
  return areaM2 / 1e6;
}

/**
 * 面积文本（不含"面积"前缀）：小于 1 km² 时同时给出 m² 与 km² 便于判读。
 */
export function areaLabel(km2) {
  if (!Number.isFinite(km2) || km2 <= 0) return "—";
  const m2 = Math.round(km2 * 1e6).toLocaleString("en-US");
  if (km2 < 0.01) return `${m2} m²`;
  if (km2 < 1) return `${km2.toFixed(3)} km²（${m2} m²）`;
  if (km2 < 100) return `${km2.toFixed(2)} km²`;
  if (km2 < 10000) return `${km2.toFixed(1)} km²`;
  return `${Math.round(km2).toLocaleString("en-US")} km²`;
}
