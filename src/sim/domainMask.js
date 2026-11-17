/**
 * 模拟域掩膜栅格化：把一个着色器空间多边形绘制到 1024² north-up 画布。
 *
 * 输出语义（R 通道）：域内=255，域外=0，边界因 LINEAR 采样得到 0~1 过渡带。
 * 该画布直接作为 Cesium.Texture source（flipY:false），与高程图/降雨掩膜
 * 共用同一套 uv 约定：v=0 对应北，画布 y=0 也是顶部（北）。
 *
 * 用途：
 *  1) SPH 物理：域外格子质量衰减，边界处速度反射 → 水被限制在模拟域内；
 *  2) 渲染：surfaceTexture 的水密度乘域掩膜 → 域外绝对不显示水；
 *  3) 降雨：雨强乘域掩膜 → 全域降雨也只落在模拟域内。
 */

export const DOMAIN_MASK_SIZE = 1024;

/**
 * @param {{u:number,v:number}[]} simPoly 着色器空间多边形顶点
 * @returns {HTMLCanvasElement|null} 域内白色、域外黑色的 1024² 画布
 */
export function rasterizeDomainMask(simPoly) {
  if (!Array.isArray(simPoly) || simPoly.length < 3) return null;

  const S = DOMAIN_MASK_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d", { willReadFrequently: false });

  // 域外黑
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, S, S);

  // 域内白（画布 y = v * S，见 geoUtils 约定）
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  simPoly.forEach((p, i) => {
    const x = p.u * S;
    const y = p.v * S;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fill();

  return canvas;
}

/**
 * 射线法判断点是否在多边形内（uv 空间）。
 * @param {number} u
 * @param {number} v
 * @param {{u:number,v:number}[]} poly
 * @returns {boolean}
 */
export function pointInPolygon(u, v, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ui = poly[i].u;
    const vi = poly[i].v;
    const uj = poly[j].u;
    const vj = poly[j].v;
    const intersect =
      vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * 经纬度点是否落在域多边形内（先把经纬度换算成着色器空间 uv）。
 * @param {number} lon
 * @param {number} lat
 * @param {[number,number,number,number]} extent [minLon,minLat,maxLon,maxLat]
 * @param {{u:number,v:number}[]} simPoly
 */
export function lonLatInDomain(lon, lat, extent, simPoly) {
  const [minLon, minLat, maxLon, maxLat] = extent;
  const u = (lon - minLon) / (maxLon - minLon);
  // v = 1 - latNorm（见 geoUtils 约定：着色器 v=0 对应北）
  const v = 1 - (lat - minLat) / (maxLat - minLat);
  return pointInPolygon(u, v, simPoly);
}
