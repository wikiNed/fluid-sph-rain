// 双石门灾点定位探针：卫星影像 + 中文注记 + 地形高程剖面（真 GPU CDP :9223）
// 用法：node test/probe_smsm.mjs [lon] [lat] [height]
import puppeteer from "puppeteer-core";

const LON = +(process.argv[2] ?? 103.99);
const LAT = +(process.argv[3] ?? 34.955);
const H = +(process.argv[4] ?? 9000);

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
  await page.goto("http://127.0.0.1:8931/index.html?smsm=" + Date.now(), {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 4000));

  await page.evaluate(
    ([lon, lat, h]) => {
      const cam = window.__app.viewer.camera;
      cam.cancelFlight();
      cam.setView({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, h),
        orientation: {
          heading: Cesium.Math.toRadians(0),
          pitch: Cesium.Math.toRadians(-55),
          roll: 0,
        },
      });
    },
    [LON, LAT, H],
  );
  await new Promise((r) => setTimeout(r, 6000));

  const info = await page.evaluate(
    async ([lon, lat]) => {
      const app = window.__app;
      const viewer = app.viewer;
      const tp = viewer.terrainProvider;
      const out = {
        lon,
        lat,
        terrainProvider: tp?.constructor?.name,
        maxLevel: tp?.availability ? tp.availability.maximumLevel ?? "?" : "?",
        imageryCount: viewer.imageryLayers.length,
        refLayers: app.refLayers ? app.refLayers() : null,
        extent: app.domain?.extent ?? null,
      };
      // 地形高程：沿东西/南北两条剖面各 9 点（0.06° 跨度）
      const pts = [];
      for (let i = -4; i <= 4; i++) {
        pts.push(Cesium.Cartographic.fromDegrees(lon + i * 0.0075, lat));
        pts.push(Cesium.Cartographic.fromDegrees(lon, lat + i * 0.0075));
      }
      try {
        const res = await Cesium.sampleTerrainMostDetailed(tp, pts);
        out.profileEW = res.slice(0, 9).map((c) => Math.round(c.height));
        out.profileNS = res.slice(9).map((c) => Math.round(c.height));
      } catch (e) {
        out.profileError = String(e.message).slice(0, 120);
      }
      return out;
    },
    [LON, LAT],
  );
  console.log("INFO:", JSON.stringify(info, null, 1));
  console.log("LOGS:", JSON.stringify(logs.slice(0, 6)));
  await page.screenshot({ path: process.env.SHOT || "test/smsm_probe.png" });
  console.log("shot:", process.env.SHOT || "test/smsm_probe.png");
} finally {
  await page.close().catch(() => {});
  await browser.disconnect();
}