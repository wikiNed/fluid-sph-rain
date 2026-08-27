/**
 * 降雨掩膜栅格化：把若干个着色器空间多边形绘制到 1024² north-up 画布。
 *
 * 输出语义（R 通道）：0=无雨，其余为该格的相对降雨强度(0~1]；
 * 多区域重叠时取最大强度（合成模式 lighten 即逐通道取 max）。
 * 全域降雨时先铺满基准强度层，再叠加各区域强度。
 */

export const RAIN_MASK_SIZE = 1024;

/**
 * @param {{simPoly:{u:number,v:number}[], intensity:number}[]} activeRegions
 * @param {boolean} wholeArea 是否全域降雨
 * @returns {HTMLCanvasElement|null} null 表示无任何雨区
 */
export function rasterizeRainMask(activeRegions, wholeArea) {
  const anyRegion = activeRegions.length > 0;
  if (!anyRegion && !wholeArea) return null;

  const S = RAIN_MASK_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d", { willReadFrequently: false });

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, S, S);

  ctx.globalCompositeOperation = "lighten";

  if (wholeArea) {
    const lv = 255;
    ctx.fillStyle = `rgb(${lv},${lv},${lv})`;
    ctx.fillRect(0, 0, S, S);
  }

  for (const region of activeRegions) {
    const lv = Math.round(Math.min(1, Math.max(0, region.intensity)) * 255);
    ctx.fillStyle = `rgb(${lv},${lv},${lv})`;
    ctx.beginPath();
    region.simPoly.forEach((p, i) => {
      // 着色器空间 v=0 对应北界；画布 y=0 也是顶部（北），直传 GPU（flipY:false）
      // → canvasY 直接取 v * S
      const x = p.u * S;
      const y = p.v * S;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
  }

  ctx.globalCompositeOperation = "source-over";
  return canvas;
}
