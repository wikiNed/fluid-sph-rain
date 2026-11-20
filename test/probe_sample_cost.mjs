// 采样网格规模 vs 耗时 基准（真实 ArcGIS 地形，固定级别 sampleTerrain）
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: null, protocolTimeout: 600000 });
for (const p of await browser.pages()) if (p.url() !== "about:blank") { try { await p.close(); } catch {} }
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 600 });
try {
  await page.goto("http://127.0.0.1:8931/index.html?bench=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });
  const out = await page.evaluate(async () => {
    const tp = window.__app.viewer.terrainProvider;
    const extent = [103.978, 34.923, 104.016, 34.963];
    const spanDeg = Math.max(extent[2] - extent[0], extent[3] - extent[1]);
    const ideal = Math.log2(360 / spanDeg) + 1.3;
    const level = Math.max(8, Math.min(15, Math.round(ideal)));
    const rows = [];
    for (const n of [96, 160, 256, 384, 512]) {
      const pts = [];
      const west = Cesium.Math.toRadians(extent[0]);
      const east = Cesium.Math.toRadians(extent[2]);
      const south = Cesium.Math.toRadians(extent[1]);
      const north = Cesium.Math.toRadians(extent[3]);
      for (let j = 0; j < n; j++) {
        const v = j / (n - 1);
        const lat = north - v * (north - south);
        for (let i = 0; i < n; i++) {
          const u = i / (n - 1);
          pts.push(Cesium.Cartographic.fromRadians(west + u * (east - west), lat));
        }
      }
      const t0 = performance.now();
      let ok = true;
      try {
        await Cesium.sampleTerrain(tp, level, pts);
      } catch (e) {
        ok = false;
      }
      rows.push({ n, points: n * n, level, ms: Math.round(performance.now() - t0), ok });
    }
    return rows;
  });
  for (const r of out) console.log(JSON.stringify(r));
} finally {
  try { await page.close(); } catch {}
  await browser.disconnect();
}