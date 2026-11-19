// 出图：5 档水深配色（找一个最深的水洼，近景拍摄）
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
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${String(e.message).slice(0, 200)}`));
page.on("console", (m) => {
  if (/shader|Invalid|Uncaught/i.test(m.text())) logs.push(m.type() + ": " + m.text().slice(0, 160));
});

await page.goto("http://127.0.0.1:8931/index.html?pool=" + Date.now(), {
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

await page.evaluate(() => {
  window.__app.commitRegionUV([
    [0.3, 0.16],
    [0.56, 0.16],
    [0.56, 0.3],
    [0.3, 0.3],
  ]);
  window.__app.commitRegionUV([
    [0.62, 0.44],
    [0.78, 0.44],
    [0.78, 0.56],
    [0.62, 0.56],
  ]);
  window.__app.options.rainEnabled = true;
  window.__app.options.rainIntensity = 0.003;
});

const statsExpr = () => {
  const app = window.__app;
  const ctx = app.viewer.scene.context;
  const tex = app.fluid._simTextures[2];
  const fb = new Cesium.Framebuffer({ context: ctx, colorTextures: [tex], destroyAttachments: false });
  const px = ctx.readPixels({ framebuffer: fb, x: 0, y: 0, width: tex.width, height: tex.height });
  fb.destroy();
  const W = tex.width, H = tex.height;
  const fullM = app.options.depthFullM;
  const bands = [0, 0, 0, 0, 0];
  let wet = 0, sumFrac = 0, maxFrac = 0, maxIdx = -1;
  for (let i = 0; i < W * H; i++) {
    const frac = px[i * 4] * 0.25;
    if (frac > 0.0005) {
      wet++;
      sumFrac += frac;
      if (frac > maxFrac) { maxFrac = frac; maxIdx = i; }
      const d = frac * fullM;
      if (d < 2) bands[0]++;
      else if (d < 5) bands[1]++;
      else if (d < 10) bands[2]++;
      else if (d < 20) bands[3]++;
      else bands[4]++;
    }
  }
  const col = maxIdx % W, row = Math.floor(maxIdx / W);
  const e = app.domain.extent;
  // 纹理行 0 = v=0 = 北界
  const lon = e[0] + (col / W) * (e[2] - e[0]);
  const lat = e[3] - (row / H) * (e[3] - e[1]);
  return {
    wetPct: +((wet / (W * H)) * 100).toFixed(1),
    meanM: wet ? +((sumFrac / wet) * fullM).toFixed(2) : 0,
    maxM: +(maxFrac * fullM).toFixed(1),
    pool: { lon: +lon.toFixed(5), lat: +lat.toFixed(5) },
    bandPct: bands.map((v) => +((v / Math.max(wet, 1)) * 100).toFixed(1)),
    injected: +app.injectedAmount().toFixed(2),
    fx: app.rainFxInfo(),
  };
};

const view = (lon, lat, height, pitchDeg) =>
  page.evaluate(
    ([lon, lat, height, pitchDeg]) => {
      const cam = window.__app.viewer.camera;
      cam.cancelFlight();
      cam.setView({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(pitchDeg), roll: 0 },
      });
    },
    [lon, lat, height, pitchDeg],
  );

const center = await page.evaluate(() => {
  const e = window.__app.domain.extent;
  return { lon: (e[0] + e[2]) / 2, lat: (e[1] + e[3]) / 2 };
});

await new Promise((r) => setTimeout(r, 45000));
let s = await page.evaluate(statsExpr);
console.log("T~45s:", JSON.stringify(s));

// 隐藏区域标签，纯净出图
await page.evaluate(() => {
  for (const e of window.__app.viewer.entities.values) if (e.label) e.label.show = false;
});

// 对准最深的那个水洼拍近景
await view(s.pool.lon, s.pool.lat - 0.006, 1800, -26);
await new Promise((r) => setTimeout(r, 2000));
await page.screenshot({ path: "test/pool_close.png" });

// 再拉一个中景
await view(center.lon, center.lat - 0.04, 3600, -32);
await new Promise((r) => setTimeout(r, 2000));
await page.screenshot({ path: "test/pool_mid.png" });

console.log("LOGS:", JSON.stringify(logs.slice(0, 6)));
await page.close();
await browser.disconnect();