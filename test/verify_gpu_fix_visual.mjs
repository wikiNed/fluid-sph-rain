import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: { width: 1500, height: 850 }, protocolTimeout: 180000 });
const page = await browser.newPage();
const errLogs = [];
page.on("console", (m) => { if (/failed to compile|failed to link|translation failed|error occurred while rendering/i.test(m.text())) errLogs.push(m.text()); });
await page.goto("http://127.0.0.1:8931/index.html?cb=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 60000 });
await page.evaluate(() => { window.__app.options.globeSampleGrid = 48; });
const dom = await page.evaluate(() => window.__app.commitGlobeDomain([-119.55, 37.74, -119.47, 37.80]));
await new Promise((r) => setTimeout(r, 4000));
await page.evaluate(() => {
  const C = window.Cesium; const e = window.__app.extent;
  window.__app.viewer.camera.flyTo({
    destination: C.Rectangle.fromDegrees(e[0], e[1], e[2], e[3]),
    orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 }, duration: 1.5,
  });
});
await page.evaluate(() => {
  window.__app.options.rainIntensity = 0.08;
  window.__app.options.rainEnabled = true;
  window.__app.options.wholeAreaRain = true;
});
await new Promise((r) => setTimeout(r, 15000));
await page.screenshot({ path: "E:/DSH/FluidSim/fluid-sph/test/shot_gpu_fix_visual.png" });
const dlg = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => /An error occurred while rendering/.test(el.textContent || "") && el.children.length === 0).length);
console.log(JSON.stringify({ domainOk: dom.ok, vertices: dom.vertices, injected: await page.evaluate(() => window.__app.injectedAmount()), errorDialog: dlg, errLogs: errLogs.slice(0, 3) }));
await page.close();
await browser.disconnect();
