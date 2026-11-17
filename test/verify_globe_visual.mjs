import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: { width: 1500, height: 850 }, protocolTimeout: 180000 });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8931/index.html", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 60000 });
await page.evaluate(() => { window.__app.options.globeSampleGrid = 48; });
await page.evaluate(() => window.__app.commitGlobeDomain([-119.55, 37.74, -119.47, 37.80], [
  [0.08, 0.08], [0.92, 0.10], [0.95, 0.90], [0.50, 0.95], [0.05, 0.60],
]));
// 绛夌浉鏈洪琛岀粨鏉?+ 鍦板舰鐡︾墖鍔犺浇
await new Promise((r) => setTimeout(r, 5000));
// 鎷夎繙涓€鐐圭湅鍏ㄦ櫙
await page.evaluate(() => {
  const C = window.Cesium;
  const e = window.__app.extent;
  window.__app.viewer.camera.flyTo({
    destination: C.Rectangle.fromDegrees(e[0] - 0.01, e[1] - 0.01, e[2] + 0.01, e[3] + 0.01),
    orientation: { heading: 0, pitch: C.Math.toRadians(-55), roll: 0 },
    duration: 2,
  });
});
await page.evaluate(() => {
  window.__app.options.rainIntensity = 0.08;
  window.__app.options.rainEnabled = true;
  window.__app.options.wholeAreaRain = true;
});
await new Promise((r) => setTimeout(r, 22000));
await page.screenshot({ path: "E:/DSH/FluidSim/fluid-sph/test/shot_globe_visual2.png" });
console.log("injected:", await page.evaluate(() => window.__app.injectedAmount()));
await browser.disconnect();
