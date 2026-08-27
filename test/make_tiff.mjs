/**
 * 生成一个带地理参考的最小 GeoTIFF：
 *  - EPSG:4326（WGS84），范围 lon[116.20,116.44] lat[39.82,40.06]
 *  - 128×128 8-bit 灰度，北半部高(亮)，南半部低(暗)，便于视觉核对方向一致性
 *
 * 布局：[header 8B][IFD][扩展值区(按tag排序,偶对齐)][像素条带]
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const W = 128;
const H = 128;
const WEST = 116.2;
const NORTH = 40.06;
const LON_SPAN = 0.24;
const LAT_SPAN = 0.24;

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

/** @type {{tag:number,type:number,buf:Buffer}[]} */
let entries = [
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
  // ModelPixelScaleTag
  { tag: 33550, type: T.DOUBLE, buf: doubleBuf(LON_SPAN / W, LAT_SPAN / H, 0) },
  // ModelTiepointTag: (0,0)->(WEST,NORTH)
  { tag: 33922, type: T.DOUBLE, buf: doubleBuf(0, 0, 0, WEST, NORTH, 0) },
  // GeoKeyDirectory: GTModel=Geographic, GTRasterType=PixelIsArea, GeographicType=WGS84
  {
    tag: 34735,
    type: T.SHORT,
    buf: shortBuf(1, 1, 0, 3, 1024, 0, 1, 2, 2048, 0, 1, 1, 2049, 0, 1, 4326),
  },
];
entries.sort((a, b) => a.tag - b.tag);

// ---------------- 布局 ----------------
const ifdSize = 2 + entries.length * 12 + 4;
const ifdOffset = 8;
let cursor = ifdOffset + ifdSize; // 扩展区起点

for (const e of entries) {
  // StripOffsets 的值(内联 LONG)此刻尚未回填，按 4 字节占位参与布局
  const len = e.buf === null ? 4 : e.buf.length;
  e.inline = e.buf !== null && len <= 4;
  if (!e.inline) {
    e.fileOffset = cursor;
    cursor += len + (len % 2); // 偶对齐预留
  }
}
const stripOffset = cursor;

// StripOffsets 是长整型内联值
entries.find((e) => e.tag === 273).buf = longBuf(stripOffset);

// ---------------- 序列化 ----------------
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

const dest = fileURLToPath(new URL("./fixture_dem.tif", import.meta.url));
writeFileSync(dest, out);
console.log(
  `written ${dest} (${total} bytes) bbox=[${WEST}, ${NORTH - LAT_SPAN}, ${
    WEST + LON_SPAN
  }, ${NORTH}]`,
);
