import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: { width: 800, height: 600 }, protocolTimeout: 180000 });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8931/index.html", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 60000 });
const r = await page.evaluate(async () => {
  const C = window.Cesium;
  const provider = window.__app.viewer.terrainProvider;
  const out = { hasSampleTerrain: typeof C.sampleTerrain === "function", hasMostDetailed: typeof C.sampleTerrainMostDetailed === "function", provider: provider?.constructor?.name };
  const bbox = [-119.55, 37.74, -119.47, 37.80];
  const N = 32;
  const positions = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    positions.push(C.Cartographic.fromDegrees(bbox[0] + (i/(N-1))*(bbox[2]-bbox[0]), bbox[3] - (j/(N-1))*(bbox[3]-bbox[1])));
  }
  // fixed level 12
  if (out.hasSampleTerrain) {
    const t = performance.now();
    try { await C.sampleTerrain(provider, 12, positions); out.fixedLevel12Ms = Math.round(performance.now() - t); } catch(e){ out.fixedLevel12Err = String(e); }
  }
  // most detailed
  const t2 = performance.now();
  try { await C.sampleTerrainMostDetailed(provider, positions); out.mostDetailedMs = Math.round(performance.now() - t2); } catch(e){ out.mostDetailedErr = String(e); }
  out.heightsSample = positions.slice(0,5).map(p => Math.round(p.height));
  return out;
});
console.log(JSON.stringify(r, null, 2));
await browser.disconnect();
