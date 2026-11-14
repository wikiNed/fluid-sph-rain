const Cesium = globalThis.Cesium;

/**
 * GeoTIFF 地理参考解析：把栅格包围盒（可能是投影坐标，单位米）换算为经纬度
 * extent，支持 EPSG 编码与"从 GeoKey 现场构造 proj4 定义"两条路径。
 *
 * 支持范围：
 *  - 地理坐标系（GTModelType=2）：直接使用 bbox。
 *  - 投影坐标系（GTModelType=1）：
 *      1) EPSG code 被 proj4 内置识别（含 WGS84 UTM 326xx/327xx、3857 等）；
 *      2) 否则按 GeoKey 的 ProjCoordTrans + 投影参数 + 椭球现场构造定义
 *         （覆盖中国 CGCS2000 高斯克吕格、Lambert、Albers、Mercator 等）。
 */

/* GeoKey 编号（GeoTIFF 1.8.2 规范 Table 6） */
const K = {
  GTModelType: 1024,
  GTRasterType: 1025,
  GeographicType: 2048,
  GeogAngularUnits: 2054,
  ProjectedCSType: 3072,
  ProjCoordTrans: 3075,
  ProjLinearUnits: 3076,
  ProjStdParallel1: 3078,
  ProjStdParallel2: 3079,
  ProjNatOriginLong: 3080,
  ProjNatOriginLat: 3081,
  ProjFalseEasting: 3082,
  ProjFalseNorthing: 3083,
  ProjFalseOriginLong: 3084,
  ProjFalseOriginLat: 3085,
  ProjFalseOriginEasting: 3086,
  ProjFalseOriginNorthing: 3087,
  ProjCenterLong: 3088,
  ProjCenterLat: 3089,
  ProjCenterEasting: 3090,
  ProjCenterNorthing: 3091,
  ProjScaleAtNatOrigin: 3092,
  ProjScaleAtCenter: 3093,
};

/* ProjCoordTransGeoKey → proj4 投影名（仅列常用项） */
const TRANS_TO_PROJ = {
  1: "tmerc", // Transverse Mercator（UTM/高斯克吕格）
  7: "merc", // Mercator
  8: "lcc", // Lambert Conformal Conic (2SP)
  9: "lcc", // Lambert Conformal Conic (1SP，用 k_0 表达)
  11: "aea", // Albers Equal Area
  14: "stere", // Stereographic
  15: "stere", // Polar Stereographic
  16: "stere", // Oblique Stereographic
  17: "eqc", // Equirectangular
  24: "sinu", // Sinusoidal
};

/**
 * @typedef {Object} GeoReference
 * @property {[number,number,number,number]|null} extent  [minLon,minLat,maxLon,maxLat]
 * @property {number|null} epsg
 * @property {string} crsLabel     人类可读坐标系描述
 * @property {boolean} projected   是否为投影坐标系
 * @property {string} [note]       失败/降级原因
 */

/**
 * 解析 GeoTIFF 的地理参考，给出经纬度覆盖范围。
 * @param {object} fileDir GeoTIFF 的 file directory
 * @param {number[]|null} bbox getBoundingBox() 结果
 * @returns {GeoReference}
 */
export function resolveGeoReference(fileDir, bbox) {
  const keys = parseGeoKeyDirectory(fileDir);
  const doubles =
    fileDir?.GeoDoubleParamsTag ?? fileDir?.GeoDoubleParams ?? null;

  const modelType = shortOf(keys, K.GTModelType);
  const epsg = shortOf(keys, K.ProjectedCSType) ?? shortOf(keys, K.GeographicType);

  if (!bbox || !bbox.every(Number.isFinite)) {
    return {
      extent: null,
      epsg,
      crsLabel: epsg ? `EPSG:${epsg}` : "未知",
      projected: false,
      note: "缺少地理参考标签",
    };
  }

  const [x0, y0, x1, y1] = bbox;
  if (!(x1 > x0) || !(y1 > y0)) {
    return {
      extent: null,
      epsg,
      crsLabel: epsg ? `EPSG:${epsg}` : "未知",
      projected: false,
      note: "包围盒无效",
    };
  }

  /* ---- 情况 A：明确的地理坐标系，或数值特征明显是经纬度 ---- */
  const looksGeographic =
    modelType === 2 ||
    (x0 >= -180.001 &&
      x1 <= 180.001 &&
      y0 >= -90.001 &&
      y1 <= 90.001 &&
      Math.abs(x1 - x0) < 360);

  if (looksGeographic && modelType !== 1) {
    return {
      extent: [x0, y0, x1, y1],
      epsg,
      crsLabel: epsg ? `EPSG:${epsg}（地理坐标系）` : "地理坐标系(WGS84)",
      projected: false,
    };
  }

  /* ---- 情况 B：投影坐标系（单位通常为米）---- */
  const built = buildProjDef(keys, doubles);
  if (!built) {
    return {
      extent: null,
      epsg,
      crsLabel: epsg ? `EPSG:${epsg}（投影）` : "未知投影",
      projected: true,
      note: `投影坐标系${epsg ? ` EPSG:${epsg}` : ""} 暂不支持自动换算，请手动放置`,
    };
  }

  const extent = projectedBboxToExtent(bbox, built.def);
  if (!extent) {
    return {
      extent: null,
      epsg,
      crsLabel: built.label,
      projected: true,
      note: `投影换算失败（${built.label}），请手动放置`,
    };
  }

  return {
    extent,
    epsg,
    crsLabel: built.label,
    projected: true,
  };
}

/* ------------------------------------------------------------------ */
/* GeoKey 解析                                                         */
/* ------------------------------------------------------------------ */

/**
 * 归一化 tag 数据：geotiff.js 不同版本可能返回普通对象(键 "0","1",…)
 * 或 Array，统一转成可索引数组。
 */
function asIndexed(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    const arr = [];
    for (let i = 0; i < v.length; i++) arr.push(v[i]);
    return arr;
  }
  return null;
}

function parseGeoKeyDirectory(fileDir) {
  const dir = asIndexed(fileDir?.GeoKeyDirectory ?? fileDir?.GeoKeyDirectoryTag);
  const keys = new Map();
  if (!dir || dir.length < 4) return keys;
  const count = dir[3];
  for (let i = 0; i < count; i++) {
    const o = 4 + i * 4;
    if (o + 3 >= dir.length) break;
    keys.set(dir[o], { loc: dir[o + 1], count: dir[o + 2], value: dir[o + 3] });
  }
  return keys;
}

/** 取内联 short 值（loc===0） */
function shortOf(keys, id) {
  const k = keys.get(id);
  if (!k || k.loc !== 0) return null;
  const v = k.value;
  // 65535 / 32767 是"用户自定义"占位值
  if (v === 65535 || v === 32767) return null;
  return v;
}

/** 取 GeoDoubleParams 中的浮点值（loc!==0） */
function doubleOf(keys, doubles, id) {
  const k = keys.get(id);
  if (!k || k.loc === 0) return null;
  const arr = asIndexed(doubles);
  if (!arr) return null;
  const v = arr[k.value];
  return Number.isFinite(v) ? v : null;
}

/** 依次尝试多个 key，返回第一个有值的 */
function firstDouble(keys, doubles, ids) {
  for (const id of ids) {
    const v = doubleOf(keys, doubles, id);
    if (v !== null) return v;
  }
  return null;
}

/** 地理坐标系 → proj4 椭球名 */
function ellpsFor(geogType) {
  switch (geogType) {
    case 4490:
      return { ellps: "GRS80", name: "CGCS2000" };
    case 4258:
    case 4269:
      return { ellps: "GRS80", name: "GRS80" };
    case 4267:
      return { ellps: "clrk66", name: "NAD27" };
    case 4326:
      return { ellps: "WGS84", name: "WGS84" };
    default:
      return { ellps: "WGS84", name: "WGS84" };
  }
}

/**
 * 构造 proj4 定义：优先用 EPSG code，其次按 GeoKey 现场拼装。
 * @returns {{def:string,label:string}|null}
 */
function buildProjDef(keys, doubles) {
  const proj4 = globalThis.proj4;
  if (!proj4) return null;

  const pcs = shortOf(keys, K.ProjectedCSType);

  // 1) EPSG code 且 proj4 内置已知
  if (pcs) {
    const code = `EPSG:${pcs}`;
    if (proj4.defs(code)) {
      return { def: code, label: `EPSG:${pcs}` };
    }
  }

  // 2) 按 GeoKey 现场拼装
  const trans = shortOf(keys, K.ProjCoordTrans);
  const proj = trans !== null ? TRANS_TO_PROJ[trans] : null;
  if (!proj) return null;

  const geog = shortOf(keys, K.GeographicType);
  const ell = ellpsFor(geog);

  const lon0 =
    firstDouble(keys, doubles, [
      K.ProjNatOriginLong,
      K.ProjFalseOriginLong,
      K.ProjCenterLong,
    ]) ?? 0;
  const lat0 =
    firstDouble(keys, doubles, [
      K.ProjNatOriginLat,
      K.ProjFalseOriginLat,
      K.ProjCenterLat,
    ]) ?? 0;
  const k0 =
    firstDouble(keys, doubles, [K.ProjScaleAtNatOrigin, K.ProjScaleAtCenter]) ?? 1;
  const x0 =
    firstDouble(keys, doubles, [
      K.ProjFalseEasting,
      K.ProjFalseOriginEasting,
      K.ProjCenterEasting,
    ]) ?? 0;
  const y0 =
    firstDouble(keys, doubles, [
      K.ProjFalseNorthing,
      K.ProjFalseOriginNorthing,
      K.ProjCenterNorthing,
    ]) ?? 0;
  const lat1 = doubleOf(keys, doubles, K.ProjStdParallel1);
  const lat2 = doubleOf(keys, doubles, K.ProjStdParallel2);

  let def = `+proj=${proj} +lat_0=${lat0} +lon_0=${lon0} +x_0=${x0} +y_0=${y0}`;
  if (proj === "lcc" || proj === "aea") {
    if (lat1 !== null) def += ` +lat_1=${lat1}`;
    if (lat2 !== null) def += ` +lat_2=${lat2}`;
  }
  if (proj === "merc" || proj === "tmerc") {
    def += ` +k_0=${k0}`;
  }
  def += ` +ellps=${ell.ellps} +units=m +no_defs`;

  // 验证 proj4 能接受该定义
  try {
    proj4(def);
  } catch (err) {
    return null;
  }

  const zone = trans === 1 ? tmercZone(lon0) : null;
  const label = `${
    trans === 1 ? "Transverse Mercator" : proj.toUpperCase()
  }${zone ? ` zone ${zone}` : ""} (${ell.name}, CM ${lon0}°)`;
  return { def, label: pcs ? `${label} EPSG:${pcs}` : label };
}

/** 由中央经线推断 6° 带号（仅用于显示） */
function tmercZone(lon0) {
  const z = Math.round((lon0 + 183) / 6);
  return z >= 1 && z <= 60 ? z : null;
}

/**
 * 把投影坐标系下的包围盒换算为经纬度外包范围。
 * 采用网格采样：横轴墨卡托在经度方向非线性，只取四角会低估/高估。
 * @returns {[number,number,number,number]|null}
 */
function projectedBboxToExtent(bbox, projDef) {
  const proj4 = globalThis.proj4;
  if (!proj4) return null;
  const [x0, y0, x1, y1] = bbox;
  const N = 7; // 7×7 采样
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let ok = 0;

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = x0 + ((x1 - x0) * i) / (N - 1);
      const y = y0 + ((y1 - y0) * j) / (N - 1);
      let r;
      try {
        r = proj4(projDef, "EPSG:4326", [x, y]);
      } catch (err) {
        continue;
      }
      if (!r || !Number.isFinite(r[0]) || !Number.isFinite(r[1])) continue;
      if (!Number.isFinite(r[0]) || !Number.isFinite(r[1])) continue;
      ok++;
      if (r[0] < minLon) minLon = r[0];
      if (r[0] > maxLon) maxLon = r[0];
      if (r[1] < minLat) minLat = r[1];
      if (r[1] > maxLat) maxLat = r[1];
    }
  }

  if (!ok || !Number.isFinite(minLon) || !Number.isFinite(minLat)) return null;
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) return null;
  if (!(maxLon > minLon) || !(maxLat > minLat)) return null;
  // 跨反经线的数据不在此处理
  if (maxLon - minLon > 180) return null;
  return [minLon, minLat, maxLon, maxLat];
}