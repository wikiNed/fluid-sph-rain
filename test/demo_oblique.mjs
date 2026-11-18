// 演示：斜视角度下降雨累积效果（用于回复用户的可视化证据）
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: null, protocolTimeout: 300000 });
for (const p of await browser.pages()) { if (p.url() !== "about:blank") { try { await p.close(); } catch {} } }
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 850 });
await page.goto("http://127.0.0.1:8931/index.html?demo=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 60000 });
await page.evaluate(() => { window.__app.options.globeSampleGrid = 96; });
await page.evaluate(async () => window.__app.commitGlobeDomain(
  [-119.55, 37.74, -119.47, 37.80],
  [[0.10, 0.10], [0.90, 0.12], [0.92, 0.88], [0.10, 0.90]]));
await page.waitForFunction(() => !!window.__app?.fluid, { timeout: 90000 });

// 斜视机位（能同时看到地形起伏与水面）
const view = () => page.evaluate(() => {
  const e = window.__app.domain.extent;
  const lon = (e[0] + e[2]) / 2, lat = (e[1] + e[3]) / 2;
  window.__app.viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat - 0.035, 3400),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-38), roll: 0 },
  });
});
await view();
await new Promise((r) => setTimeout(r, 4000));
await page.screenshot({ path: "test/demo_before.png" });

await page.click("#btnWholeRain");
await page.evaluate(() => { window.__app.options.rainEnabled = true; });
for (const t of [10, 25]) {
  await new Promise((r) => setTimeout(r, t === 10 ? 10000 : 15000));
  await view();
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `test/demo_t${t}.png` });
  console.log("shot", t);
}
await page.close(); await browser.disconnect();