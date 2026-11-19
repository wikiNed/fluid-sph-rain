/**
 * 探测：全球地形采样链路是否正常（terrain provider 类型 / sampleTerrain / sampleTerrainMostDetailed）。
 * 连 :9223。
 */
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: { width: 1200, height: 760 } });
for (const p of await browser.pages()) if (p.url() !== "about:blank") { try { await p.close(); } catch {} }
const page = await browser.newPage();
const logs = [];
page.on("pageerror", (e) => logs.push("[pageerror] " + e.message));
page.on("console", (m) => { if (m.type() !== "log") logs.push("[" + m.type() + "] " + String(m.text()).slice(0, 160)); });
await page.goto("http://127.0.0.1:8931/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction("window.__app && __app.ready === true", { timeout: 90000 });
await page.waitForFunction("window.__app.viewer.scene.globe.tilesLoaded === true", { timeout: 40000 }).catch(() => console.log("tilesLoaded timeout"));

const r = await page.evaluate(async () => {
  const tp = window.__app.viewer.terrainProvider;
  const out = {
    providerName: tp && tp.constructor && tp.constructor.name,
    hasSampleTerrainFlag: !!tp,
    methods: [],
  };
  for (const m of ["getLevelMaximumGeometricError", "getTileDataAvailable", "computeMaximumLevelAtPosition", "availability", "requestTileGeometry", "loadTileDataAvailability"]) {
    out.methods.push(m + "=" + (typeof tp?.[m]));
  }
  const cartos = [
    Cesium.Cartographic.fromDegrees(-119.51, 37.77),
    Cesium.Cartographic.fromDegrees(-119.55, 37.74),
    Cesium.Cartographic.fromDegrees(-119.47, 37.8),
  ];
  try {
    const s1 = await Cesium.sampleTerrain(tp, 12, cartos.map((c) => c.clone()));
    out.sampleTerrain12 = s1.map((c) => (Number.isFinite(c.height) ? +c.height.toFixed(1) : null));
  } catch (e) {
    out.sampleTerrain12 = "ERR " + e.message;
  }
  try {
    const s2 = await Cesium.sampleTerrain(tp, 10, cartos.map((c) => c.clone()));
    out.sampleTerrain10 = s2.map((c) => (Number.isFinite(c.height) ? +c.height.toFixed(1) : null));
  } catch (e) {
    out.sampleTerrain10 = "ERR " + e.message;
  }
  try {
    const s3 = await Cesium.sampleTerrainMostDetailed(tp, cartos.map((c) => c.clone()));
    out.sampleTerrainMostDetailed = s3.map((c) => (Number.isFinite(c.height) ? +c.height.toFixed(1) : null));
  } catch (e) {
    out.sampleTerrainMostDetailed = "ERR " + e.message;
  }
  try {
    const g = window.__app.viewer.scene.globe;
    out.globeHeight = [-119.51, 37.77].map(() => 0) && g.getHeight(Cesium.Cartographic.fromDegrees(-119.51, 37.77));
  } catch (e) {
    out.globeHeight = "ERR " + e.message;
  }
  return out;
});
console.log(JSON.stringify(r, null, 2));
console.log("LOGS:", logs.slice(0, 10).join(" | ") || "(empty)");
await page.close();
browser.disconnect();