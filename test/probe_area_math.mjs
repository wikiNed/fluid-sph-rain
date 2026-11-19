// 面积公式数值校验（纯 Node，stub 掉 Cesium 全局）
globalThis.Cesium = {
  Math: {
    toRadians: (d) => (d * Math.PI) / 180,
    toDegrees: (r) => (r * 180) / Math.PI,
  },
};
const { polygonAreaKm2, areaLabel } = await import("../src/sim/geoUtils.js");

// 0.01° × 0.01° 方块 @ lat 34.5：约 1.108km × 0.921km ≈ 1.02 km²
const sq = [
  { lon: 110.0, lat: 34.5 },
  { lon: 110.01, lat: 34.5 },
  { lon: 110.01, lat: 34.51 },
  { lon: 110.0, lat: 34.51 },
];
const a1 = polygonAreaKm2(sq);
console.log("square 0.01deg:", a1.toFixed(4), "km2 ->", areaLabel(a1));

// 用户截图那种大域 0.3578° × 0.3112° @ lat 30：约 34.5km × 34.5km ≈ 1190 km²
const big = [
  { lon: 110.0, lat: 30.0 },
  { lon: 110.3578, lat: 30.0 },
  { lon: 110.3578, lat: 30.3112 },
  { lon: 110.0, lat: 30.3112 },
];
const a2 = polygonAreaKm2(big);
console.log("big domain:", a2.toFixed(1), "km2 ->", areaLabel(a2));

console.log("order independent:", Math.abs(polygonAreaKm2([...sq].reverse()) - a1) < 1e-9);
console.log("degenerate:", polygonAreaKm2([{ lon: 1, lat: 1 }, { lon: 2, lat: 2 }]), "|", areaLabel(0));