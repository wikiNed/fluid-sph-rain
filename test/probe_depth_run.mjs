// 探测：长跑降雨 → 回读水深分布（5 档分档）+ 分阶段截图
// 用内置示例 DEM 的覆盖范围（extent/thickness 与源码一致），这样水深标定与 §5.10 实测一致。
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

await page.goto("http://127.0.0.1:8931/index.html?depthrun=" + Date.now(), {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });

const EXT = [-119.5509508318, 37.7379837881, -119.4661638949, 37.8045600379];
const domain = await page.evaluate(
  async (ext) => await window.__app.commitGlobeDomain(ext),
  EXT,
);
console.log("DOMAIN:", JSON.stringify(domain));
const region = await page.evaluate(() => window.__app.commitTestRegion(0.18, 0.18));
console.log("REGION:", JSON.stringify(region));

await page.evaluate((ext) => {
  const centerLon = (ext[0] + ext[2]) / 2;
  const centerLat = (ext[1] + ext[3]) / 2;
  const thickness = window.__app.volumeThickness();
  window.__app.viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(centerLon, centerLat, thickness * 1.1 + 5000),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-40),
      roll: 0,
    },
  });
}, EXT);

// 雨强加大 3.75 倍，让 5 档颜色在 20~30 秒内都能出现（演示用；默认 0.0004 更温和）
await page.evaluate(() => {
  window.__app.options.rainIntensity = 0.001;
  window.__app.options.rainEnabled = true;
});
await new Promise((r) => setTimeout(r, 800));

const histogramExpr = () => {
  const app = window.__app;
  const ctx = app.viewer.scene.context;
  const tex = app.fluid._simTextures[2];
  const fb = new Cesium.Framebuffer({
    context: ctx,
    colorTextures: [tex],
    destroyAttachments: false,
  });
  const w = tex.width;
  const h = tex.height;
  const px = ctx.readPixels({ framebuffer: fb, x: 0, y: 0, width: w, height: h });
  fb.destroy();
  const thickness = app.volumeThickness();
  const bands = [0, 0, 0, 0, 0];
  let wet = 0;
  let sum = 0;
  let max = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const d = px[i * 4] * 0.25 * thickness; // 米
    if (d > 0.02) {
      wet++;
      sum += d;
      if (d > max) max = d;
      if (d < 2) bands[0]++;
      else if (d < 5) bands[1]++;
      else if (d < 10) bands[2]++;
      else if (d < 20) bands[3]++;
      else bands[4]++;
    }
  }
  return {
    wetPct: +((wet / n) * 100).toFixed(1),
    meanM: wet ? +(sum / wet).toFixed(2) : 0,
    maxM: +max.toFixed(2),
    bandsM: {
      "0-2": bands[0],
      "2-5": bands[1],
      "5-10": bands[2],
      "10-20": bands[3],
      ">20": bands[4],
    },
    injected: +app.injectedAmount().toFixed(2),
  };
};

let waited = 0;
for (const t of [8, 6, 6, 6]) {
  await new Promise((r) => setTimeout(r, t * 1000));
  waited += t;
  const hist = await page.evaluate(histogramExpr);
  console.log(`T~${waited}s:`, JSON.stringify(hist));
  await page.screenshot({ path: `test/depthrun_t${waited}s.png` });
}

console.log("LOGS:", JSON.stringify(logs.slice(0, 10), null, 1));
await page.close();
await browser.disconnect();