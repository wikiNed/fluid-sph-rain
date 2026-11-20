// 候选 extent 地形起伏探测（用于校正案例坐标），真 GPU CDP :9223
import puppeteer from "puppeteer-core";

const CANDIDATES = {
  A: [101.70, 36.98, 101.78, 37.04],
  B: [101.66, 37.02, 101.74, 37.08],
  C: [101.72, 36.96, 101.8, 37.02],
  D: [101.6, 36.96, 101.68, 37.02],
  E: [101.66, 36.99, 101.74, 37.05],
};

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9223",
  defaultViewport: null,
  protocolTimeout: 240000,
});
for (const p of await browser.pages()) {
  if (p.url() !== "about:blank") {
    try {
      await p.close();
    } catch {}
  }
}
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800 });
try {
  await page.goto("http://127.0.0.1:8931/index.html?cand=" + Date.now(), {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });
  const res = await page.evaluate(async (cands) => {
    const tp = window.__app.viewer.terrainProvider;
    const out = [];
    for (const [k, e] of Object.entries(cands)) {
      const [w, s, x, n] = e;
      const pts = [];
      for (let iy = 0; iy < 5; iy++)
        for (let ix = 0; ix < 5; ix++)
          pts.push(
            Cesium.Cartographic.fromDegrees(
              w + (ix / 4) * (x - w),
              s + (iy / 4) * (n - s),
            ),
          );
      let hs = [];
      try {
        hs = (await Cesium.sampleTerrainMostDetailed(tp, pts)).map((p) => Math.round(p.height));
      } catch (err) {
        hs = [];
      }
      out.push({
        k,
        extent: e,
        min: hs.length ? Math.min(...hs) : null,
        max: hs.length ? Math.max(...hs) : null,
        relief: hs.length ? Math.max(...hs) - Math.min(...hs) : null,
      });
    }
    return out;
  }, CANDIDATES);
  for (const r of res) console.log(`${r.k} ${JSON.stringify(r.extent)} → ${r.min}~${r.max} (relief ${r.relief})`);
} finally {
  try {
    await page.close();
  } catch {}
  await browser.disconnect();
}