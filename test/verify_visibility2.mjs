// 干净可见性测试：全程不做 readPixels（避免干扰 Cesium 渲染状态），只截图
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: null, protocolTimeout: 300000 });
for (const p of await browser.pages()) { if (p.url() !== "about:blank") { try { await p.close(); } catch {} } }
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 850 });
await page.goto("http://127.0.0.1:8931/index.html?clean=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 60000 });
await page.evaluate(() => { window.__app.options.globeSampleGrid = 48; });
await page.evaluate(async () => window.__app.commitGlobeDomain(
  [-119.55, 37.74, -119.47, 37.80],
  [[0.10, 0.10], [0.90, 0.12], [0.92, 0.88], [0.10, 0.90]]));
await page.waitForFunction(() => !!window.__app?.fluid, { timeout: 60000 });
await page.evaluate(() => {
  const e = window.__app.domain.extent;
  const lon = (e[0] + e[2]) / 2, lat = (e[1] + e[3]) / 2;
  window.__app.viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, 4200),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-89), roll: 0 },
  });
});
await new Promise((r) => setTimeout(r, 5000));
await page.screenshot({ path: "test/cl_before.png" });

await page.click("#btnWholeRain");
await page.evaluate(() => { window.__app.options.rainEnabled = true; });
for (const t of [5, 15, 30, 60]) {
  await new Promise((r) => setTimeout(r, t === 5 ? 5000 : t === 15 ? 10000 : t === 30 ? 15000 : 30000));
  await page.screenshot({ path: `test/cl_t${t}.png` });
  console.log("shot t" + t);
}
await page.close(); await browser.disconnect();
