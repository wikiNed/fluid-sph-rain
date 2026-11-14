const Cesium = globalThis.Cesium;

import { resolveGeoReference } from "./projection.js";

/** 模拟纹理统一尺寸（与 SPH 管线 textureSize 一致） */
export const DEM_TEXTURE_SIZE = 1024;
/** 分析用最大解码尺寸 */
const ANALYZE_MAX_SIZE = 2048;

/**
 * @typedef {Object} ElevationData
 * @property {"geotiff"|"image"} kind            数据来源类型
 * @property {string} sourceName                 文件名
 * @property {HTMLCanvasElement} canvas          DEM_TEXTURE_SIZE² 灰度画布（高度编码于 R 通道，north-up）
 * @property {number} minElevation               最小高程值
 * @property {number} maxElevation               最大高程值
 * @property {[number,number,number,number]|null} extent
 *        [minLon, minLat, maxLon, maxLat]，null 表示无法自动定位（需手动放置）
 * @property {number} contentAspect              有效数据区宽高比(w/h)，用于手动放置时估算范围
 * @property {string} info                       给用户看的分析摘要
 */

/**
 * 加载用户上传的高程文件（tif/tiff/png/jpg/jpeg/webp）。
 * - GeoTIFF：解析地理参考获取覆盖范围；地理坐标系直接用包围盒，投影坐标系
 *   （UTM / CGCS2000 高斯克吕格 / Lambert 等）经 proj4 换算为经纬度后再定位；
 *   既无地理参考又无法换算时降级为手动放置。
 * - 普通图片：亮度作为高程，自动检测有效数据边界（剔除纯色边框/透明边）。
 * @param {File|Blob} file
 * @returns {Promise<ElevationData>}
 */
export async function loadElevationFile(file) {
  const name = file.name || "elevation";
  const lower = name.toLowerCase();
  const buffer = await file.arrayBuffer();

  const looksLikeTiff =
    lower.endsWith(".tif") ||
    lower.endsWith(".tiff") ||
    sniffTiffMagic(buffer);

  if (looksLikeTiff && globalThis.GeoTIFF) {
    try {
      return await loadGeoTIFF(buffer, name);
    } catch (err) {
      console.warn("[elevationLoader] GeoTIFF 解析失败，按普通图片处理:", err);
      // 落入普通图片流程（TIFF 浏览器不能直接解码，此处再失败就抛错）
      return await loadPlainImage(buffer, name);
    }
  }

  if (looksLikeTiff && !globalThis.GeoTIFF) {
    throw new Error("缺少 geotiff 解析库(libs/geotiff.min.js 未加载)");
  }

  return await loadPlainImage(buffer, name);
}

function sniffTiffMagic(buffer) {
  if (buffer.byteLength < 4) return false;
  const b = new Uint8Array(buffer, 0, 4);
  return (
    (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a) ||
    // BigTIFF
    (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2b && b[3] === 0x00) ||
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2b)
  );
}

/* ------------------------------------------------------------------ */
/* GeoTIFF 分支                                                        */
/* ------------------------------------------------------------------ */

async function loadGeoTIFF(buffer, name) {
  const tiff = await globalThis.GeoTIFF.fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  // 老版 geotiff.js 用 image.fileDirectory（数组 + *Tag 名称）；
  // 新版 getFileDirectory() 返回普通对象（键 "0","1",…）。两者都试。
  let fileDir = null;
  try {
    fileDir = image.getFileDirectory?.() ?? null;
  } catch (e) {
    fileDir = null;
  }
  if (!fileDir) fileDir = image.fileDirectory ?? {};

  let bbox = null;
  try {
    bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY]
  } catch (e) {
    bbox = null;
  }

  // 解析地理参考：地理坐标系直接用 bbox；投影坐标系（UTM/CGCS2000 等）
  // 经 proj4 换算为经纬度范围（见 src/io/projection.js）
  const geoRef = resolveGeoReference(fileDir, bbox);
  const extent = geoRef.extent;
  const bboxIsProjected = geoRef.projected;

  // 读取第 0 波段并重采样到模拟纹理尺寸
  const S = DEM_TEXTURE_SIZE;
  let band, rw, rh;
  try {
    const res = await image.readRasters({
      samples: [0],
      width: S,
      height: S,
      resampleMethod: "bilinear",
    });
    band = res[0];
    rw = res.width ?? S;
    rh = res.height ?? S;
  } catch (err) {
    // 极端情况下退回原生分辨率读取（大图可能较慢）
    const res = await image.readRasters({ samples: [0] });
    band = res[0];
    rw = res.width ?? image.getWidth();
    rh = res.height ?? image.getHeight();
  }

  const noData = resolveNoData(image);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < band.length; i++) {
    const v = band[i];
    if (v === null || !Number.isFinite(v)) continue;
    if (noData !== null && Math.abs(v - noData) < 1e-9) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error("GeoTIFF 中未找到有效高程数据");
  }
  if (max - min < 1e-9) max = min + 1; // 常量面保护

  const canvas = encodeGray(band, rw, rh, min, max);

  // geotiff.js 不同版本的文件目录表示不同：旧版数组 + *Tag 后缀，
  // 新版普通对象（键 "0","1",…）+ 无后缀名。两种都要兼容。
  // ModelPixelScale 的单位取决于坐标系：投影坐标系为米，地理坐标系为度。
  // 用 geoRef.projected 判断而不是数值大小（投影下也可能 <1 m/px）。
  const scaleVals = tagArray(fileDir, "ModelPixelScaleTag", "ModelPixelScale");
  const pixelInfo =
    Array.isArray(scaleVals) && scaleVals.length >= 2
      ? geoRef.projected
        ? `${scaleVals[0].toFixed(1)}m/px`
        : `${scaleVals[0].toFixed(5)}°/px`
      : "未知分辨率";

  let info =
    `GeoTIFF ${geoRef.crsLabel} ${pixelInfo}` +
    ` 高程 ${formatNum(min)}~${formatNum(max)}m`;
  if (!extent && geoRef.note) {
    info += ` · ${geoRef.note}`;
  } else if (extent && geoRef.projected) {
    info += " · 已自动换算为经纬度";
  }

  return {
    kind: "geotiff",
    sourceName: name,
    canvas,
    minElevation: min,
    maxElevation: max,
    extent,
    // 无 extent 时用于手动放置：优先用 bbox 的真实宽高比（投影单位为米时可靠），
    // 否则退化为 1（正方形）
    contentAspect: pickAspect(bbox, extent),
    info,
  };
}

/** 估算有效数据区宽高比：有经纬度 extent 用其比例，否则用 bbox 米制比例 */
function pickAspect(bbox, extent) {
  if (extent && extent[2] > extent[0] && extent[3] > extent[1]) {
    // 经度方向随纬度收缩，用中纬度余弦校正后更接近真实形状
    const midLat = ((extent[1] + extent[3]) / 2) * (Math.PI / 180);
    const w = (extent[2] - extent[0]) * Math.cos(midLat);
    const h = extent[3] - extent[1];
    if (h > 0) return w / h;
  }
  if (bbox && bbox[2] > bbox[0] && bbox[3] > bbox[1]) {
    return (bbox[2] - bbox[0]) / (bbox[3] - bbox[1]);
  }
  return 1;
}

/**
 * 从 fileDirectory 读取数组形式的值。兼容 geotiff.js 两种表示：
 *  - 数组（旧版）：直接返回；
 *  - 对象（新版）：键为 "0","1",… 的普通对象，按数值键序展开为数组。
 */
function tagArray(fileDir, ...names) {
  for (const n of names) {
    const v = fileDir?.[n];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) return v;
    if (typeof v === "object") {
      const keys = Object.keys(v)
        .map(Number)
        .filter((k) => Number.isFinite(k))
        .sort((a, b) => a - b);
      if (keys.length) return keys.map((k) => v[k]);
    } else if (Number.isFinite(v)) {
      return [v];
    }
  }
  return null;
}

function resolveNoData(image) {
  try {
    const nd = image.getGDALNoData();
    if (nd === null || nd === undefined || Number.isNaN(nd)) return null;
    return Number(nd);
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 普通图片分支                                                        */
/* ------------------------------------------------------------------ */

async function loadPlainImage(buffer, name) {
  const blob = new Blob([buffer]);
  const bitmap = await createImageBitmap(blob);
  // 先降采样到分析尺寸
  const scaleFit = Math.min(
    1,
    ANALYZE_MAX_SIZE / bitmap.width,
    ANALYZE_MAX_SIZE / bitmap.height,
  );
  const aw = Math.max(1, Math.round(bitmap.width * scaleFit));
  const ah = Math.max(1, Math.round(bitmap.height * scaleFit));
  const work = document.createElement("canvas");
  work.width = aw;
  work.height = ah;
  const ctx = work.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, aw, ah);
  const imgData = ctx.getImageData(0, 0, aw, ah);
  bitmap.close?.();

  const bounds = detectContentBounds(imgData); // {x,y,w,h,trimmedBy}
  const { x, y, w, h } = bounds;

  // 裁剪出有效数据区并做灰度高程编码
  const cropped = document.createElement("canvas");
  cropped.width = w;
  cropped.height = h;
  cropped
    .getContext("2d")
    .drawImage(work, x, y, w, h, 0, 0, w, h);

  const resized = document.createElement("canvas");
  resized.width = DEM_TEXTURE_SIZE;
  resized.height = DEM_TEXTURE_SIZE;
  const rz = resized.getContext("2d", { willReadFrequently: true });
  rz.drawImage(cropped, 0, 0, DEM_TEXTURE_SIZE, DEM_TEXTURE_SIZE);
  const out = rz.getImageData(0, 0, DEM_TEXTURE_SIZE, DEM_TEXTURE_SIZE);
  const px = out.data;
  for (let i = 0; i < px.length; i += 4) {
    const lum =
      0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    px[i] = px[i + 1] = px[i + 2] = lum;
    px[i + 3] = 255;
  }
  rz.putImageData(out, 0, 0);

  // 归一化提示：普通图片默认高程 0~1000m，可在 GUI 中调整（影响体积盒厚度）
  const min = 0;
  const max = 1000;

  return {
    kind: "image",
    sourceName: name,
    canvas: resized,
    minElevation: min,
    maxElevation: max,
    extent: null,
    contentAspect: w / h,
    info:
      `图片 ${w}×${h}px 有效区(${bounds.trimmedBy}) 亮度即高程 0~1000m` +
      " · 请点击底图放置中心点",
  };
}

/**
 * 自动检测有效数据边界：识别纯色边框或透明边。
 * @returns {{x:number,y:number,w:number,h:number,trimmedBy:string}}
 */
function detectContentBounds(imgData) {
  const { width: W, height: H, data } = imgData;

  // 判定“无效色”：优先透明；否则取四周边缘环的主色调
  const ringVals = [];
  const lumAt = (i) =>
    0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  for (let x = 0; x < W; x++) {
    ringVals.push([x, 0], [x, H - 1]);
  }
  for (let y = 1; y < H - 1; y++) {
    ringVals.push([0, y], [W - 1, y]);
  }
  let transparentRing = 0;
  const hist = new Map(); // key: round(lum) -> count
  for (const [x, y] of ringVals) {
    const i = (y * W + x) * 4;
    if (data[i + 3] < 16) {
      transparentRing++;
    } else {
      const l = Math.round(lumAt(i));
      hist.set(l, (hist.get(l) || 0) + 1);
    }
  }

  let invalidAlpha = false;
  let borderColor = -999;
  if (transparentRing > ringVals.length * 0.05) {
    invalidAlpha = true;
  } else {
    let best = 0;
    let bl = -1;
    for (const [l, c] of hist) {
      if (c > best) {
        best = c;
        bl = l;
      }
    }
    // 边框占边缘环 >40% 才认为是边框
    if (best > ringVals.length * 0.4) borderColor = bl;
  }

  const isInvalid = (x, y) => {
    const i = (y * W + x) * 4;
    if (invalidAlpha) return data[i + 3] < 16;
    if (borderColor >= 0) {
      return Math.abs(Math.round(lumAt(i)) - borderColor) <= 4;
    }
    return false;
  };

  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  // 以 2px 步进粗扫描加速
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      if (!isInvalid(x, y)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    return { x: 0, y: 0, w: W, h: H, trimmedBy: "未裁剪" };
  }
  // 扩回步进损失的半格
  minX = Math.max(0, minX - 1);
  minY = Math.max(0, minY - 1);
  maxX = Math.min(W - 1, maxX + 1);
  maxY = Math.min(H - 1, maxY + 1);

  const tw = maxX - minX + 1;
  const th = maxY - minY + 1;
  const areaRatio = (tw * th) / (W * H);
  if (areaRatio < 0.04 || areaRatio > 0.995) {
    return { x: 0, y: 0, w: W, h: H, trimmedBy: "未裁剪" };
  }
  return {
    x: minX,
    y: minY,
    w: tw,
    h: th,
    trimmedBy: `裁掉${
      Math.round((1 - areaRatio) * 100)
    }%`,
  };
}

/* ------------------------------------------------------------------ */
/* 工具                                                               */
/* ------------------------------------------------------------------ */

/** 将栅格数据编码进 north-up 灰度画布（行序即原始栅格行序，北在上） */
function encodeGray(band, w, h, min, max) {
  const S = DEM_TEXTURE_SIZE;
  const src = band; // 长度应为 w*h（若上游已重采样则 w=h=S）
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(S, S);
  const out = img.data;
  const spanInv = 255 / Math.max(1e-9, max - min);
  for (let y = 0; y < S; y++) {
    const sy = Math.min(h - 1, Math.floor((y / S) * h));
    for (let x = 0; x < S; x++) {
      const sx = Math.min(w - 1, Math.floor((x / S) * w));
      let v = src[sy * w + sx];
      if (v === undefined || v === null || !Number.isFinite(v)) v = min;
      const g = (v - min) * spanInv;
      const o = (y * S + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = g;
      out[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function formatNum(v) {
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
}
