// 演示/验证：路网+地名参考图层 + 雨滴下落效果 + 5 档水深配色
// 斜视机位（体积渲染只在斜视/低机位下有像素贡献：从正上方俯视时背面盒面被地形深度裁剪）
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
page.on("console", (m) => {
  const t = m.text();
  if (/shader|Invalid|Uncaught|PAGEERROR/i.test(t)) logs.push(`${m.type()}: ${t.slice(0, 200)}`);
});
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${String(e.message).slice(0, 200)}`));

await page.goto("http://127.0.0.1:8931/index.html?raindeep=" + Date.now(), {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });

await page.evaluate(async () =>
  window.__app.commitGlobeDomain(
    [-119.55, 37.74, -119.47, 37.8],
    [
      [0.1, 0.1],
      [0.9, 0.12],
      [0.92, 0.88],
      [0.1, 0.9],
    ],
  ),
);
await page.waitForFunction(() => !!window.__app?.fluid, { timeout: 90000 });
await page.evaluate(() => window.__app.commitTestRegion(0.34, 0.34));

const view = () =>
  page.evaluate(() => {
    const e = window.__app.domain.extent;
    const lon = (e[0] + e[2]) / 2;
    const lat = (e[1] + e[3]) / 2;
    window.__app.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat - 0.035, 3400),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-38), roll: 0 },
    });
  });
await view();
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ path: "test/rd_before.png" });

await page.click("#btnWholeRain");
await page.evaluate(() => {
  window.__app.options.rainEnabled = true;
});

const statsExpr = () => {
  const app = window.__app;
  const ctx = app.viewer.scene.context;
  const tex = app.fluid._simTextures[2];
  const fb = new Cesium.Framebuffer({ context: ctx, colorTextures: [tex], destroyAttachments: false });
  const px = ctx.readPixels({ framebuffer: fb, x: 0, y: 0, width: tex.width, height: tex.height });
  fb.destroy();
  const dc0 = app.depthConfig();
  const fullM = dc0.boxThicknessM;
  const bandsM = dc0.bands;
  const bands = [0, 0, 0, 0, 0];
  let wet = 0, sumFrac = 0, maxFrac = 0;
  const n = tex.width * tex.height;
  for (let i = 0; i < n; i++) {
    const frac = px[i * 4] * 0.25;
    if (frac > 0.0005) {
      wet++;
      sumFrac += frac;
      if (frac > maxFrac) maxFrac = frac;
      const d = frac * fullM;
      const bi = bandsM.findIndex((bm) => d < bm);
      bands[bi < 0 ? 4 : bi]++;
    }
  }
  return {
    wetPct: +((wet / n) * 100).toFixed(1),
    meanM: wet ? +((sumFrac / wet) * fullM).toFixed(2) : 0,
    maxM: +(maxFrac * fullM).toFixed(1),
    bandPct: bands.map((v) => +((v / Math.max(wet, 1)) * 100).toFixed(1)),
    fx: app.rainFxInfo(),
    injected: +app.injectedAmount().toFixed(2),
    legend: app.depthConfig().legendRows,
    layers: app.refLayers(),
  };
};

let waited = 0;
for (const t of [8, 10, 12, 15, 20]) {
  await new Promise((r) => setTimeout(r, t * 1000));
  waited += t;
  await view();
  await new Promise((r) => setTimeout(r, 1200));
  const s = await page.evaluate(statsExpr);
  console.log(`T~${waited}s:`, JSON.stringify(s));
  await page.screenshot({ path: `test/rd_t${waited}s.png` });
}
console.log("LOGS:", JSON.stringify(logs.slice(0, 8)));
await page.close();
await browser.disconnect();