/**
 * 生成带地理参考的 GeoTIFF 测试夹具：
 *  1. fixture_dem.tif —— EPSG:4326（WGS84），lon[116.20,116.44] lat[39.82,40.06]
 *  2. fixture_utm.tif —— EPSG:32650（WGS84 / UTM Zone 50N），128×128 8-bit
 *
 * 像素规律：北半部亮（高），南半部暗（低），便于视觉核对方向一致性。
 * 布局：[header 8B][IFD][扩展值区(按tag排序,偶对齐)][像素条带]
 *
 * 用法：node test/make_tiff.mjs [--utm-only|--geo-only]
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const W = 128;
const H = 128;

// ---------------- 栅格数据 ----------------
const px = Buffer.alloc(W * H);
for (let y = 0; y < H; y++) {
  const northness = 1 - y / (H - 1); // 行0=北 => 北亮南暗
  for (let x = 0; x < W; x++) {
    const base = 40 + northness * 180;
    const noise = ((x * 7 + y * 13) % 11) - 5;
    px[y * W + x] = Math.max(0, Math.min(255, Math.round(base + noise)));
  }
}

// ---------------- 条目定义 ----------------
const T = { SHORT: 3, LONG: 4, DOUBLE: 12 };
const TYPE_SIZE = { 3: 2, 4: 4, 12: 8 };

function shortBuf(...vals) {
  const b = Buffer.alloc(vals.length * 2);
  vals.forEach((v, i) => b.writeUInt16LE(v, i * 2));
  return b;
}
function longBuf(...vals) {
  const b = Buffer.alloc(vals.length * 4);
  vals.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
  return b;
}
function doubleBuf(...vals) {
  const b = Buffer.alloc(vals.length * 8);
  vals.forEach((v, i) => b.writeDoubleLE(v, i * 8));
  return b;
}

function buildEntries({ scale, tiepoint, geoKeys }) {
  return [
    { tag: 256, type: T.LONG, buf: longBuf(W) },
    { tag: 257, type: T.LONG, buf: longBuf(H) },
    { tag: 258, type: T.SHORT, buf: shortBuf(8) },
    { tag: 259, type: T.SHORT, buf: shortBuf(1) },
    { tag: 262, type: T.SHORT, buf: shortBuf(1) },
    { tag: 273, type: T.LONG, buf: null }, // StripOffsets 后填
    { tag: 277, type: T.SHORT, buf: shortBuf(1) },
    { tag: 278, type: T.LONG, buf: longBuf(H) },
    { tag: 279, type: T.LONG, buf: longBuf(px.length) },
    { tag: 284, type: T.SHORT, buf: shortBuf(1) },
    { tag: 33550, type: T.DOUBLE, buf: doubleBuf(scale[0], scale[1], 0) },
    { tag: 33922, type: T.DOUBLE, buf: doubleBuf(0, 0, 0, tiepoint[0], tiepoint[1], 0) },
    { tag: 34735, type: T.SHORT, buf: shortBuf(...geoKeys) },
  ];
}

function serialize(entries) {
  entries.sort((a, b) => a.tag - b.tag);
  const ifdSize = 2 + entries.length * 12 + 4;
  const ifdOffset = 8;
  let cursor = ifdOffset + ifdSize;

  for (const e of entries) {
    const len = e.buf === null ? 4 : e.buf.length;
    e.inline = e.buf !== null && len <= 4;
    if (!e.inline) {
      e.fileOffset = cursor;
      cursor += len + (len % 2);
    }
  }
  const stripOffset = cursor;
  entries.find((e) => e.tag === 273).buf = longBuf(stripOffset);

  const total = stripOffset + px.length;
  const out = Buffer.alloc(total);
  out.write("II", 0, "ascii");
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifdOffset, 4);
  out.writeUInt16LE(entries.length, ifdOffset);
  entries.forEach((e, i) => {
    const o = ifdOffset + 2 + i * 12;
    out.writeUInt16LE(e.tag, o);
    out.writeUInt16LE(e.type, o + 2);
    out.writeUInt32LE(e.buf.length / TYPE_SIZE[e.type], o + 4);
    if (e.inline) {
      e.buf.copy(out, o + 8);
    } else {
      out.writeUInt32LE(e.fileOffset, o + 8);
      e.buf.copy(out, e.fileOffset);
    }
  });
  px.copy(out, stripOffset);
  return out;
}

// ---------------- 夹具 A：地理坐标系 EPSG:4326 ----------------
const GEO_WEST = 116.2;
const GEO_NORTH = 40.06;
const GEO_LON_SPAN = 0.24;
const GEO_LAT_SPAN = 0.24;

const geoEntries = buildEntries({
  scale: [GEO_LON_SPAN / W, GEO_LAT_SPAN / H],
  tiepoint: [GEO_WEST, GEO_NORTH],
  geoKeys: [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326],
});
const geoBuf = serialize(geoEntries);
const geoDest = fileURLToPath(new URL("./fixture_dem.tif", import.meta.url));
writeFileSync(geoDest, geoBuf);
console.log(
  `written ${geoDest} (${geoBuf.length} bytes) EPSG:4326 bbox=[${GEO_WEST},${(GEO_NORTH - GEO_LAT_SPAN).toFixed(2)},${(GEO_WEST + GEO_LON_SPAN).toFixed(2)},${GEO_NORTH}]`,
);

// ---------------- 夹具 B：投影坐标系 EPSG:32650 (UTM Zone 50N) ----------------
// 目标区域与夹具A一致，先正算得到左上角的东/北坐标
const UTM_ZONE = 50;
const UTM_CM = (UTM_ZONE - 1) * 6 - 180 + 3; // 中央经线 = 117°
const DEG2M = Math.PI / 180;
const a = 6378137.0;
const f = 1 / 298.257223563;
const e2 = f * (2 - f);

function lonLatToUtm(lon, lat) {
  const k0 = 0.9996;
  const latRad = lat * DEG2M;
  const lonDiff = (lon - UTM_CM) * DEG2M;
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const tanLat = Math.tan(latRad);
  const nu = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const T = tanLat * tanLat;
  const C = (e2 / (1 - e2)) * cosLat * cosLat;
  const A = lonDiff * cosLat;
  const M =
    a *
    ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256) * latRad -
      ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * latRad) +
      ((15 * e2 * e2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * latRad) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * latRad));
  const x = k0 * nu * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * e2) * A ** 5 / 120) + 500000;
  const y = k0 * (M + nu * tanLat * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * e2) * A ** 6 / 720));
  return [x, y];
}

// 让夹具 B 覆盖与夹具 A 完全相同的经纬度范围（便于断言互通）：
// 用 A 的四个角的正算 UTM 坐标推出像素尺度与 tiepoint。
const nw = lonLatToUtm(GEO_WEST, GEO_NORTH);
const ne = lonLatToUtm(GEO_WEST + GEO_LON_SPAN, GEO_NORTH);
const sw = lonLatToUtm(GEO_WEST, GEO_NORTH - GEO_LAT_SPAN);
const UTM_PX_X = (ne[0] - nw[0]) / W;
const UTM_PX_Y = (nw[1] - sw[1]) / H;
const scaleUtm = [UTM_PX_X, UTM_PX_Y];

const utmEntries = buildEntries({
  scale: scaleUtm,
  tiepoint: [nw[0], nw[1]],
  // GeoKey 按 ID 升序：GTModelType=1(投影), GTRasterType=1(PixelIsArea),
  // GeographicType=4326, ProjectedCSType=32650, ProjCoordTrans=1(tmerc)
  geoKeys: [
    1, 1, 0, 5,
    1024, 0, 1, 1,
    1025, 0, 1, 1,
    2048, 0, 1, 4326,
    3072, 0, 1, 32650,
    3075, 0, 1, 1,
  ],
});
const utmBuf = serialize(utmEntries);
const utmDest = fileURLToPath(new URL("./fixture_utm.tif", import.meta.url));
writeFileSync(utmDest, utmBuf);
console.log(
  `written ${utmDest} (${utmBuf.length} bytes) EPSG:32650 UTM50N ` +
    `tiepoint=[${nw[0].toFixed(1)},${nw[1].toFixed(1)}] px=${UTM_PX_X.toFixed(1)}×${UTM_PX_Y.toFixed(1)}m`,
);
