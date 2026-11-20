/**
 * 案例几何静态校验（纯 Node，不开浏览器）：
 *  - rainUv 是否全部落在 domainUv 内（否则 _commitRegion 会整块拒绝）
 *  - camera 经纬度是否落在 extent 内、AGL/pitch 是否合理
 *  - 打印各案例 bbox 尺寸与面积量级，便于人工核对坐标。
 *
 * 运行：node test/probe_cases_geo.mjs
 */
import { CASES } from "../src/data/cases.js";

const R = 6371008.8;

function pointInPolygon(u, v, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ui, vi] = poly[i];
    const [uj, vj] = poly[j];
    const hit = vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui;
    if (hit) inside = !inside;
  }
  return inside;
}

function bboxKm(extent, lat0) {
  const mx = (extent[2] - extent[0]) * 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const my = (extent[3] - extent[1]) * 110.57;
  return { mx, my };
}

const fail = [];
for (const c of CASES) {
  const [w, s, e, n] = c.extent;
  const { mx, my } = bboxKm(c.extent, (s + n) / 2);
  console.log(`\n=== ${c.id} · ${c.name}`);
  console.log(`  extent ${w.toFixed(3)},${s.toFixed(3)} .. ${e.toFixed(3)},${n.toFixed(3)}`);
  console.log(`  尺寸 ${mx.toFixed(2)} km × ${my.toFixed(2)} km ≈ ${(mx * my).toFixed(2)} km²`);
  console.log(`  雨量 ${c.mm} mm / ${c.dur}s，等级 ${c.severity}，伤亡 ${c.loss}`);

  const outside = c.rainUv.filter(([u, v]) => !pointInPolygon(u, v, c.domainUv));
  if (outside.length) {
    fail.push(`${c.id}: ${outside.length} 个雨区顶点在域外 ${JSON.stringify(outside)}`);
    console.log(`  ❌ 雨区越界：${JSON.stringify(outside)}`);
  } else {
    console.log(`  ✅ 雨区 ${c.rainUv.length} 顶点全在域内`);
  }

  const [lo, la] = [c.camera.lon, c.camera.lat];
  const inExtent = lo >= w && lo <= e && la >= s && la <= n;
  console.log(
    `  机位 ${lo.toFixed(4)},${la.toFixed(4)} AGL ${c.camera.agl}m pitch ${c.camera.pitch}° heading ${c.camera.heading}° → ${inExtent ? "在范围内" : "在范围外(可接受)"}`,
  );

  // 域多边形面积（uv 空间 → km²，v 比例按高度）
  let area = 0;
  for (let i = 0, j = c.domainUv.length - 1; i < c.domainUv.length; j = i++) {
    area += c.domainUv[j][0] * c.domainUv[i][1] - c.domainUv[i][0] * c.domainUv[j][1];
  }
  area = Math.abs(area / 2) * mx * my;
  console.log(`  域多边形面积 ≈ ${area.toFixed(2)} km²`);
}

console.log("");
if (fail.length) {
  console.log("❌ 校验失败：");
  for (const f of fail) console.log("  - " + f);
  process.exitCode = 1;
} else {
  console.log("✅ 4 个案例几何校验通过（雨区均在域内）");
}