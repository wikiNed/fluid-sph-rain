// 出图：「雨量模式」一场 500mm 降雨的汇水效果（真 GPU CDP :9223）
// 产物：test/rain_amount_wide.png、test/rain_amount_mid.png
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

await page.goto("http://127.0.0.1:8931/index.html?rainamount=" + Date.now(), {
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

// 两个雨区
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
});

const view = (lon, lat, height, pitchDeg, headingDeg = 0) =>
  page.evaluate(
    ([lon, lat, height, pitchDeg, headingDeg]) => {
      const cam = window.__app.viewer.camera;
      cam.cancelFlight();
      cam.setView({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
        orientation: {
          heading: Cesium.Math.toRadians(headingDeg),
          pitch: Cesium.Math.toRadians(pitchDeg),
          roll: 0,
        },
      });
    },
    [lon, lat, height, pitchDeg, headingDeg],
  );

const center = await page.evaluate(() => {
  const e = window.__app.domain.extent;
  return { lon: (e[0] + e[2]) / 2, lat: (e[1] + e[3]) / 2 };
});

// 一场 500mm / 60s 的雨（≈30000 mm/h 的极端雨强，便于一次出图）
await page.evaluate(() => {
  window.__app.setRainfall(500, 60, "amount");
  window.__app.options.rainEnabled = true;
});
const cfg = await page.evaluate(() => window.__app.rainfallConfig());
console.log("CFG:", JSON.stringify({ mode: cfg.mode, mm: cfg.amountMm, dur: cfg.durationSec, rate: cfg.rateMmH }));

const statsExpr = () => {
  const app = window.__app;
  const ctx = app.viewer.scene.context;
  const tex = app.fluid._simTextures[2];
  const fb = new Cesium.Framebuffer({
    context: ctx,
    colorTextures: [tex],
    destroyAttachments: false,
  });
  const px = ctx.readPixels({ framebuffer: fb, x: 0, y: 0, width: tex.width, height: tex.height });
  fb.destroy();
  const dc = app.depthConfig();
  const boxM = dc.boxThicknessM; // 与几何高度同一把尺子
  const bandsM = dc.bands; // [b1,b2,b3,b4]
  const bands = [0, 0, 0, 0, 0];
  let wet = 0, sumFrac = 0, maxFrac = 0;
  const n = tex.width * tex.height;
  for (let i = 0; i < n; i++) {
    const frac = px[i * 4] * 0.25;
    if (frac > 0.0005) {
      wet++;
      sumFrac += frac;
      if (frac > maxFrac) maxFrac = frac;
      const d = frac * boxM;
      if (d < bandsM[0]) bands[0]++;
      else if (d < bandsM[1]) bands[1]++;
      else if (d < bandsM[2]) bands[2]++;
      else if (d < bandsM[3]) bands[3]++;
      else bands[4]++;
    }
  }
  return {
    wetPct: +((wet / n) * 100).toFixed(1),
    meanM: wet ? +((sumFrac / wet) * boxM).toFixed(2) : 0,
    maxM: +(maxFrac * boxM).toFixed(1),
    bandPct: bands.map((v) => +((v / Math.max(wet, 1)) * 100).toFixed(1)),
    stats: app.rainfallConfig().stats,
    fx: app.rainFxInfo(),
  };
};

await view(center.lon, center.lat - 0.055, 5200, -30);
await new Promise((r) => setTimeout(r, 2000));
console.log("T0:", JSON.stringify(await page.evaluate(statsExpr)));

// 等这一场 500mm 雨下完（60s）
await new Promise((r) => setTimeout(r, 64000));
const s = await page.evaluate(statsExpr);
console.log("T~66s:", JSON.stringify(s));

await page.evaluate(() => {
  for (const e of window.__app.viewer.entities.values) if (e.label && !/水深/.test(e.label.text?.getValue?.(Cesium.JulianDate.now()) ?? "")) e.label.show = false;
});
await view(center.lon, center.lat - 0.055, 5200, -30);
await new Promise((r) => setTimeout(r, 1800));
await page.screenshot({ path: "test/rain_amount_wide.png" });

await view(center.lon - 0.019, center.lat - 0.035, 3000, -30);
await new Promise((r) => setTimeout(r, 1800));
await page.screenshot({ path: "test/rain_amount_mid.png" });

console.log("LOGS:", JSON.stringify(logs.slice(0, 6)));
await page.close();
await browser.disconnect();