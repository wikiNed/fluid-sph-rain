/**
 * 投影解析单元验证（Node 环境，不依赖浏览器）：
 * 直接调用 src/io/projection.js 的 resolveGeoReference，
 * 用构造的 fileDir 模拟 GeoTIFF 的 GeoKey 目录。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const LIB = fileURLToPath(new URL("../libs/proj4.js", import.meta.url));
// proj4 dist 是 UMD；在 Node 里按 CJS 载入并挂到 globalThis（模拟浏览器 <script> 行为）
const require = createRequire(import.meta.url);
globalThis.proj4 = require(LIB);
if (!globalThis.proj4?.defs) throw new Error("proj4 载入失败");

const { resolveGeoReference } = await import(
  new URL("../src/io/projection.js", import.meta.url)
);

let fail = 0;
function check(name, ok, detail = "") {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** 拼 GeoKey 目录：[ver,rev,minor,count, (id,loc,count,val)*] */
function gk(list) {
  const out = [1, 1, 0, list.length];
  for (const it of list) out.push(it[0], it[1], it[2], it[3]);
  return out;
}

// ---- 1. 地理坐标系 EPSG:4326 ----
{
  const r = resolveGeoReference(
    { GeoKeyDirectoryTag: gk([[1024, 0, 1, 2], [2048, 0, 1, 4326]]) },
    [116.2, 39.82, 116.44, 40.06],
  );
  check(
    "EPSG:4326 直接使用 bbox",
    r.projected === false &&
      near(r.extent[0], 116.2, 1e-9) &&
      near(r.extent[3], 40.06, 1e-9),
    JSON.stringify(r.extent),
  );
}

// ---- 2. 投影坐标 bbox 但无投影标签 → 应拒绝并给出提示 ----
{
  const r = resolveGeoReference({ GeoKeyDirectoryTag: gk([[1024, 0, 1, 1]]) }, [
    500000, 4000000, 510000, 4010000,
  ]);
  check(
    "无投影标签的米制 bbox 不误判为经纬度",
    r.extent === null && /手动放置/.test(r.note || ""),
    r.note,
  );
}

// ---- 3. EPSG:32650 UTM50N（proj4 内置）----
{
  const r = resolveGeoReference(
    {
      GeoKeyDirectoryTag: gk([
        [1024, 0, 1, 1],
        [2048, 0, 1, 4326],
        [3072, 0, 1, 32650],
        [3075, 0, 1, 1],
      ]),
    },
    [500000, 4000000, 510000, 4010000],
  );
  check(
    "EPSG:32650 自动换算为经纬度",
    r.projected === true &&
      r.extent !== null &&
      r.extent[0] > 116 &&
      r.extent[0] < 118 &&
      r.extent[1] > 36 &&
      r.extent[1] < 37,
    `extent=${JSON.stringify(r.extent)} label=${r.crsLabel}`,
  );
  // bbox 中心 (505000,4005000) → (117.055610, 36.189784)
  if (r.extent) {
    const cx = (r.extent[0] + r.extent[2]) / 2;
    const cy = (r.extent[1] + r.extent[3]) / 2;
    check(
      "UTM50N 中心点定位正确",
      near(cx, 117.05561, 1e-4) && near(cy, 36.189784, 1e-4),
      `center=(${cx.toFixed(6)}, ${cy.toFixed(6)})`,
    );
  }
}

// ---- 4. CGCS2000 高斯克吕格 EPSG:4547（proj4 不内置，需按 GeoKey 拼装）----
{
  const doubles = [
    117.0, // ProjNatOriginLong (CM 117E)
    0.0, // ProjNatOriginLat
    500000.0, // ProjFalseEasting
    0.0, // ProjFalseNorthing
    1.0, // ProjScaleAtNatOrigin
  ];
  const r = resolveGeoReference(
    {
      GeoKeyDirectoryTag: gk([
        [1024, 0, 1, 1], // projected
        [2048, 0, 1, 4490], // CGCS2000 geographic
        [3072, 0, 1, 4547], // CGCS2000 / 3-degree GK CM 117E
        [3075, 0, 1, 1], // tmerc
        [3076, 0, 1, 9001], // metre
        [3080, 1, 1, 0], // NatOriginLong -> doubles[0]
        [3081, 1, 1, 1],
        [3082, 1, 1, 2],
        [3083, 1, 1, 3],
        [3092, 1, 1, 4],
      ]),
      GeoDoubleParamsTag: doubles,
    },
    [392000, 2457000, 402000, 2467000],
  );
  check(
    "EPSG:4547 由 GeoKey 现场构造并换算成功",
    r.extent !== null && r.projected === true,
    `extent=${JSON.stringify(r.extent?.map((v) => +v.toFixed(4)))} label=${r.crsLabel}`,
  );
  if (r.extent) {
    // bbox 中心 (397000,2462000) → (116.000803, 22.251593)
    const cx = (r.extent[0] + r.extent[2]) / 2;
    const cy = (r.extent[1] + r.extent[3]) / 2;
    check(
      "CGCS2000 GK 中心点数值正确",
      near(cx, 116.000803, 1e-4) && near(cy, 22.251593, 1e-4),
      `center=(${cx.toFixed(6)}, ${cy.toFixed(6)})`,
    );
  }
}

// ---- 5. 无效 bbox ----
{
  const r = resolveGeoReference({}, [10, 10, 10, 20]);
  check("退化 bbox 被拒绝", r.extent === null, r.note);
}

console.log(fail ? `\n== ${fail} FAIL ==` : "\n== ALL PASS ==");
process.exit(fail ? 1 : 0);