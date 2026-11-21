// 出图：一图展示「参考图层 + 雨滴效果 + 5 档水深配色」（隐藏区域标签，画面干净）
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

await page.goto("http://127.0.0.1:8931/index.html?showcase=" + Date.now(), {
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
  window.__app.options.rainIntensity = 0.0015;
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
  };
};

// 全景（南向北，能同时看到两个雨区下游的汇水）
await view(center.lon, center.lat - 0.055, 5200, -30);
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: "test/showcase_before.png" });

await new Promise((r) => setTimeout(r, 45000));
const s = await page.evaluate(statsExpr);
console.log("T~45s:", JSON.stringify(s));

await page.evaluate(() => {
  for (const e of window.__app.viewer.entities.values) if (e.label) e.label.show = false;
});
await view(center.lon, center.lat - 0.055, 5200, -30);
await new Promise((r) => setTimeout(r, 1800));
await page.screenshot({ path: "test/showcase_wide.png" });

// 中景：水体深浅分档
await view(center.lon - 0.019, center.lat - 0.035, 3000, -30);
await new Promise((r) => setTimeout(r, 1800));
await page.screenshot({ path: "test/showcase_mid.png" });

console.log("LOGS:", JSON.stringify(logs.slice(0, 6)));
await page.close();
await browser.disconnect();