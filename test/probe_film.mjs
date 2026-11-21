import puppeteer from "puppeteer-core";
const CDP = "http://127.0.0.1:9223";
const PAGE = "http://127.0.0.1:8931/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null, protocolTimeout: 300000 });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 800 });
try {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 120000 });
  const input = await page.$("#fileInput");
  await input.uploadFile("test/fixture_dem.tif");
  await sleep(2500);
  await page.waitForFunction(() => window.__app.commitDomainUV([[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]])?.ok, { timeout: 90000 });
  await page.waitForFunction(() => !!window.__app.fluid, { timeout: 90000 });
  await page.evaluate(() => window.__app.commitTestRegion(0.3, 0.3));
  await page.evaluate(() => window.__app.setRainfall(100, 10, "amount"));
  await page.evaluate(() => window.__app.setRainEnabled(true));
  await sleep(14000);
  await page.evaluate(() => { window.__app.setRainEnabled(false); window.__app.setRainFx(false); });
  await sleep(1200);
  const dc = await page.evaluate(() => {
    const ext = window.__app.precisionInfo().extent;
    const cam = window.__app.viewer.camera;
    cam.cancelFlight();
    const lon = (ext[0] + ext[2]) / 2, lat = (ext[1] + ext[3]) / 2;
    cam.setView({ destination: Cesium.Cartesian3.fromDegrees(lon, lat - (ext[3] - ext[1]) * 0.4, 900), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-35), roll: 0 } });
    return window.__app.depthConfig();
  });
  await sleep(2000);
  await page.screenshot({ path: "test/film_fixture.png" });
  const info = await page.evaluate(() => ({ cfg: window.__app.rainfallConfig(), px: window.__app.viewer.scene.context._gl ? 1 : 0 }));
  console.log("DC", JSON.stringify(dc), "INFO", JSON.stringify(info.stats));
} finally {
  try { await page.close(); } catch {}
  try { browser.disconnect(); } catch {}
  process.exit(0);
}