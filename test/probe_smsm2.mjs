// 双石门灾点定位探针 v2：按离地高度(AGL)取景 + 高程剖面 + 影像/地形状态
// 用法：node test/probe_smsm2.mjs <lon> <lat> <agl> [pitch] [shot]
import puppeteer from "puppeteer-core";

const LON = +(process.argv[2] ?? 104.0);
const LAT = +(process.argv[3] ?? 34.95);
const AGL = +(process.argv[4] ?? 1200);
const PITCH = +(process.argv[5] ?? -55);
const SHOT = process.argv[6] || "test/smsm_probe.png";

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9223",
  defaultViewport: null,
  protocolTimeout: 300000,
});
for (const p of await browser.pages()) {
  if (p.url() !== "about:blank") {
    try {
      await p.close();
    } catch {}
  }
}
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 850 });
const logs = [];
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${String(e.message).slice(0, 200)}`));

try {
  await page.goto("http://127.0.0.1:8931/index.html?smsm2=" + Date.now(), {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });

  const info = await page.evaluate(
    async ([lon, lat, agl, pitch]) => {
      const app = window.__app;
      const viewer = app.viewer;
      const tp = viewer.terrainProvider;
      const out = {
        terrainProvider: tp?.constructor?.name,
        imageryCount: viewer.imageryLayers.length,
      };
      const center = Cesium.Cartographic.fromDegrees(lon, lat);
      const c = (await Cesium.sampleTerrainMostDetailed(tp, [center]))[0];
      out.groundHeight = Math.round(c.height);

      const pts = [];
      for (let i = -5; i <= 5; i++) {
        pts.push(Cesium.Cartographic.fromDegrees(lon + i * 0.004, lat));
        pts.push(Cesium.Cartographic.fromDegrees(lon, lat + i * 0.004));
      }
      try {
        const res = await Cesium.sampleTerrainMostDetailed(tp, pts);
        out.profileEW = res.slice(0, 11).map((p) => Math.round(p.height));
        out.profileNS = res.slice(11).map((p) => Math.round(p.height));
      } catch (e) {
        out.profileError = String(e.message).slice(0, 120);
      }

      const cam = viewer.camera;
      cam.cancelFlight();
      cam.setView({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, c.height + agl),
        orientation: {
          heading: Cesium.Math.toRadians(0),
          pitch: Cesium.Math.toRadians(pitch),
          roll: 0,
        },
      });
      return out;
    },
    [LON, LAT, AGL, PITCH],
  );
  await new Promise((r) => setTimeout(r, 9000));
  console.log("INFO:", JSON.stringify(info));
  console.log("LOGS:", JSON.stringify(logs.slice(0, 6)));
  await page.screenshot({ path: SHOT });
  console.log("shot:", SHOT);
} finally {
  await page.close().catch(() => {});
  await browser.disconnect();
}