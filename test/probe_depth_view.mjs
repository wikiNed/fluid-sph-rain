// 探测：俯视相机下观察水体与 5 档水深配色（默认雨强 0.0004），并回读水深直方图
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
await page.setViewport({ width: 1280, height: 800 });
const logs = [];
page.on("console", (m) => {
  const t = m.text();
  if (/shader|Invalid|Uncaught|PAGEERROR/i.test(t)) logs.push(`${m.type()}: ${t.slice(0, 200)}`);
});
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${String(e.message).slice(0, 200)}`));

await page.goto("http://127.0.0.1:8931/index.html?depthview=" + Date.now(), {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });

const EXT = [-119.5509508318, 37.7379837881, -119.4661638949, 37.8045600379];
const domain = await page.evaluate(async (ext) => await window.__app.commitGlobeDomain(ext), EXT);
console.log("DOMAIN:", JSON.stringify(domain));
await page.evaluate(() => window.__app.commitTestRegion(0.2, 0.2));

const thickness = await page.evaluate(() => window.__app.volumeThickness());
console.log("THICKNESS:", thickness);

// 俯视：相机在域中心正上方，pitch -90，让体积盒占满画面
await page.evaluate(
  (ext, thickness) => {
    const lon = (ext[0] + ext[2]) / 2;
    const lat = (ext[1] + ext[3]) / 2;
    window.__app.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat - 0.0001, thickness + 5200),
      orientation: {
        heading: Cesium.Math.toRadians(0),
        pitch: Cesium.Math.toRadians(-90),
        roll: 0,
      },
    });
  },
  EXT,
  thickness,
);
await new Promise((r) => setTimeout(r, 1500));

await page.evaluate(() => {
  window.__app.options.rainEnabled = true;
});
await new Promise((r) => setTimeout(r, 500));

const histExpr = () => {
  const app = window.__app;
  const ctx = app.viewer.scene.context;
  const tex = app.fluid._simTextures[2];
  const fb = new Cesium.Framebuffer({ context: ctx, colorTextures: [tex], destroyAttachments: false });
  const px = ctx.readPixels({ framebuffer: fb, x: 0, y: 0, width: tex.width, height: tex.height });
  fb.destroy();
  const T = app.volumeThickness();
  const bands = [0, 0, 0, 0, 0];
  let wet = 0, sum = 0, max = 0;
  const n = tex.width * tex.height;
  for (let i = 0; i < n; i++) {
    const frac = px[i * 4] * 0.25; // 占体积盒高度比例
    const d = frac * T; // 真实米制
    if (frac > 0.0001) {
      wet++;
      sum += frac;
      if (frac > max) max = frac;
      if (d < 2) bands[0]++;
      else if (d < 5) bands[1]++;
      else if (d < 10) bands[2]++;
      else if (d < 20) bands[3]++;
      else bands[4]++;
    }
  }
  return {
    wetPct: +((wet / n) * 100).toFixed(1),
    meanFrac: wet ? +(sum / wet).toFixed(4) : 0,
    maxFrac: +max.toFixed(4),
    meanM: wet ? +((sum / wet) * T).toFixed(1) : 0,
    maxM: +(max * T).toFixed(1),
    bandsPct: {
      "0-2": +((bands[0] / Math.max(wet, 1)) * 100).toFixed(1),
      "2-5": +((bands[1] / Math.max(wet, 1)) * 100).toFixed(1),
      "5-10": +((bands[2] / Math.max(wet, 1)) * 100).toFixed(1),
      "10-20": +((bands[3] / Math.max(wet, 1)) * 100).toFixed(1),
      ">20": +((bands[4] / Math.max(wet, 1)) * 100).toFixed(1),
    },
    injected: +app.injectedAmount().toFixed(3),
  };
};

let waited = 0;
for (const t of [4, 6, 10, 15, 25]) {
  await new Promise((r) => setTimeout(r, t * 1000));
  waited += t;
  const h = await page.evaluate(histExpr);
  console.log(`T~${waited}s:`, JSON.stringify(h));
  await page.screenshot({ path: `test/depthview_t${waited}s.png` });
}
console.log("LOGS:", JSON.stringify(logs.slice(0, 8)));
await page.close();
await browser.disconnect();