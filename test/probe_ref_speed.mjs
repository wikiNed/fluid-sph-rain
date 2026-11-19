// 诊断：ArcGIS Reference 图层 provider 加载耗时（页面内网络栈）
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: null, protocolTimeout: 300000 });
for (const p of await browser.pages()) { if (p.url() !== "about:blank") { try { await p.close(); } catch {} } }
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8931/index.html?probe=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });

const out = await page.evaluate(async () => {
  const urls = {
    transport: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer",
    places: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer",
  };
  const res = {};
  for (const [k, url] of Object.entries(urls)) {
    const t0 = performance.now();
    try {
      const provider = await Promise.race([
        Cesium.ArcGisMapServerImageryProvider.fromUrl(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 25s")), 25000)),
      ]);
      res[k] = { ok: true, ms: Math.round(performance.now() - t0), maxLevel: provider.maximumLevel };
    } catch (e) {
      res[k] = { ok: false, ms: Math.round(performance.now() - t0), err: String(e.message || e) };
    }
  }
  res.layersNow = window.__app.refLayers();
  return res;
});
console.log(JSON.stringify(out, null, 1));
await page.close();
await browser.disconnect();