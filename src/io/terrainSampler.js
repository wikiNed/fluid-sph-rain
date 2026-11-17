const Cesium = globalThis.Cesium;

/** 高程图纹理边长（与其余 1024² 物理纹理保持一致） */
const DEM_TEXTURE_SIZE = 1024;

/**
 * 从 Cesium 全球地形采样指定经纬度范围的真实高程，生成可供流体模拟使用的 DEM。
 *
 * 这是「无需上传高程图」模式的核心：用户在全球地形上画一个多边形（模拟域），
 * 取其包围盒作为采样范围，用 sampleTerrainMostDetailed 拉取最详细级别的地形高程，
 * 再编码成 north-up 灰度画布（高度在 R 通道，行 0 = 北界），与雨掩膜/域掩膜同约定。
 *
 * @param {Object} terrainProvider Cesium 地形 provider（Ellipsoid 时返回全 0 平坦高程）
 * @param {[number,number,number,number]} extentDeg [minLon,minLat,maxLon,maxLat]（十进制度）
 * @param {number} gridN 采样网格边长（gridN×gridN 个点），越大越精细但越慢
 * @returns {Promise<{canvas:HTMLCanvasElement,minElevation:number,maxElevation:number,
 *                   gridN:number,samples:number,valid:number,flat:boolean}>}
 */
export async function sampleTerrainDem(terrainProvider, extentDeg, gridN = 96) {
  const west = Cesium.Math.toRadians(extentDeg[0]);
  const south = Cesium.Math.toRadians(extentDeg[1]);
  const east = Cesium.Math.toRadians(extentDeg[2]);
  const north = Cesium.Math.toRadians(extentDeg[3]);
  const positions = [];
  for (let j = 0; j < gridN; j++) {
    // v=0 对应北界（north-up），与着色器/掩膜约定一致
    const v = j / (gridN - 1);
    const lat = north - v * (north - south);
    for (let i = 0; i < gridN; i++) {
      const u = i / (gridN - 1);
      const lon = west + u * (east - west);
      positions.push(Cesium.Cartographic.fromRadians(lon, lat));
    }
  }

  let heights;
  let usedProvider = !!terrainProvider;
  try {
    if (!terrainProvider) throw new Error("no terrain provider");
    // 选择固定细节级别：瓦片宽度约为采样范围的 1/6，兼顾精度与速度。
    // sampleTerrainMostDetailed 会为每个点请求最详细的瓦片，实测 32×32 点需 ~10s，
    // 而固定级别的 sampleTerrain 仅需 ~150ms；96×96（默认）时差异更悬殊。
    const spanDeg = Math.max(east - west, north - south);
    const maxErr = terrainProvider.getLevelMaximumGeometricError?.(0) ?? 0;
    let level = 12; // 默认级别，覆盖市/区级范围已足够
    // 依据范围跨度自适应：跨度越小，需要的细节级别越高
    if (spanDeg > 0) {
      const ideal = Math.log2(360 / spanDeg) + 1.3;
      level = Math.max(8, Math.min(15, Math.round(ideal)));
    }
    if (maxErr > 0) level = Math.min(level, 15);
    let sampled;
    try {
      sampled = await Cesium.sampleTerrain(terrainProvider, level, positions);
    } catch (e) {
      // 固定级别不支持时退化到最详细采样
      console.warn("固定级别地形采样失败，改用最详细采样:", e);
      sampled = await Cesium.sampleTerrainMostDetailed(terrainProvider, positions);
    }
    heights = new Float64Array(gridN * gridN);
    for (let k = 0; k < sampled.length; k++) {
      const h = sampled[k].height;
      heights[k] = Number.isFinite(h) ? h : NaN;
    }
  } catch (err) {
    console.warn("地形高程采样失败，退化为椭球面平坦高程:", err);
    usedProvider = false;
    heights = new Float64Array(gridN * gridN); // 全 0
  }

  let valid = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < heights.length; k++) {
    const h = heights[k];
    if (Number.isFinite(h)) {
      valid++;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }

  const flat = valid === 0 || max - min < 1e-3 || !usedProvider;
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 0;
  }
  if (max - min < 1) {
    // 平坦区域（或无地形）：给一个最小起伏，避免体积盒厚度为 0
    const c = (min + max) / 2;
    min = c - 5;
    max = c + 5;
  } else {
    // 上下各留 5% 余量，避免水面刚好顶到盒盖
    const pad = (max - min) * 0.05;
    min -= pad;
    max += pad;
  }

  // 填充 NaN（无地形数据的采样点）：用最近有效值，退化为 min
  let lastValid = min;
  for (let j = 0; j < gridN; j++) {
    for (let i = 0; i < gridN; i++) {
      const k = j * gridN + i;
      if (!Number.isFinite(heights[k])) heights[k] = lastValid;
      else lastValid = heights[k];
    }
  }

  const canvas = encodeHeightGrid(heights, gridN, min, max);
  return {
    canvas,
    minElevation: min,
    maxElevation: max,
    gridN,
    samples: gridN * gridN,
    valid,
    flat,
  };
}

/** 把 gridN×gridN 高程网格双线性插值到 1024² north-up 灰度画布 */
function encodeHeightGrid(grid, gridN, min, max) {
  const S = DEM_TEXTURE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(S, S);
  const out = img.data;
  const spanInv = 255 / Math.max(1e-9, max - min);

  for (let y = 0; y < S; y++) {
    const gy = (y / (S - 1)) * (gridN - 1);
    const j0 = Math.floor(gy);
    const j1 = Math.min(gridN - 1, j0 + 1);
    const fy = gy - j0;
    for (let x = 0; x < S; x++) {
      const gx = (x / (S - 1)) * (gridN - 1);
      const i0 = Math.floor(gx);
      const i1 = Math.min(gridN - 1, i0 + 1);
      const fx = gx - i0;
      const h00 = grid[j0 * gridN + i0];
      const h10 = grid[j0 * gridN + i1];
      const h01 = grid[j1 * gridN + i0];
      const h11 = grid[j1 * gridN + i1];
      const h =
        h00 * (1 - fx) * (1 - fy) +
        h10 * fx * (1 - fy) +
        h01 * (1 - fx) * fy +
        h11 * fx * fy;
      let g = (h - min) * spanInv;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      const o = (y * S + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = g;
      out[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
