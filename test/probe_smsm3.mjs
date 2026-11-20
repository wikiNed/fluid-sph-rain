// 双石门定位探针 v3：一次会话内多机位取景（宽景 / 沟口 / 沿沟向上游）
import puppeteer from "puppeteer-core";

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

const VIEWS = [
  { lon: 104.005, lat: 34.985, agl: 9000, pitch: -70, heading: 0, shot: "test/smsm_wide.png" },
  { lon: 103.995, lat: 34.945, agl: 2200, pitch: -40, heading: 150, shot: "test/smsm_valley.png" },
  { lon: 104.008, lat: 34.925, agl: 1600, pitch: -28, heading: 330, shot: "test/smsm_upstream.png" },
];

try {
  await page.goto("http://127.0.0.1:8931/index.html?smsm3=" + Date.now(), {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });

  for (const v of VIEWS) {
    const info = await page.evaluate(
      async ([lon, lat, agl, pitch, heading]) => {
        const app = window.__app;
        const viewer = app.viewer;
        const tp = viewer.terrainProvider;
        const c = (await Cesium.sampleTerrainMostDetailed(tp, [Cesium.Cartographic.fromDegrees(lon, lat)]))[0];
        const cam = viewer.camera;
        cam.cancelFlight();
        cam.setView({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, c.height + agl),
          orientation: {
            heading: Cesium.Math.toRadians(heading),
            pitch: Cesium.Math.toRadians(pitch),
            roll: 0,
          },
        });
        return { ground: Math.round(c.height), imageryCount: viewer.imageryLayers.length };
      },
      [v.lon, v.lat, v.agl, v.pitch, v.heading],
    );
    await new Promise((r) => setTimeout(r, 8000));
    await page.screenshot({ path: v.shot });
    console.log(v.shot, JSON.stringify(info));
  }
  console.log("LOGS:", JSON.stringify(logs.slice(0, 6)));
} finally {
  await page.close().catch(() => {});
  await browser.disconnect();
}