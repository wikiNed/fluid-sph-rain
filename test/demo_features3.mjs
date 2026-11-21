// 演示：参考图层 + 雨滴效果 + 5 档水深配色（多个雨区汇流场景）
// 斜视机位（体积渲染只在斜视/低机位下有像素贡献）
// 注意：commitRegionUV 会触发相机 flyTo，每次改机位前必须 cancelFlight，否则被飞行覆盖
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

await page.goto("http://127.0.0.1:8931/index.html?feat4=" + Date.now(), {
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

const regions = await page.evaluate(() => {
  const r1 = window.__app.commitRegionUV([
    [0.3, 0.16],
    [0.56, 0.16],
    [0.56, 0.3],
    [0.3, 0.3],
  ]);
  const r2 = window.__app.commitRegionUV([
    [0.62, 0.44],
    [0.78, 0.44],
    [0.78, 0.56],
    [0.62, 0.56],
  ]);
  return { r1, r2, areas: window.__app.areas() };
});
console.log("REGIONS:", JSON.stringify(regions));

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

// 全景机位（南向北看，能同时看到两个雨区和汇流方向）
await view(center.lon, center.lat - 0.055, 5200, -30);
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ path: "test/feat_before.png" });

// 演示用雨强（默认 0.0004 约 1 分钟才见明显积水；这里调大一些好出图）
await page.evaluate(() => {
  window.__app.options.rainEnabled = true;
  window.__app.options.rainIntensity = 0.0015;
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
    imageryCount: app.refLayers().imageryCount,
    rainActive: app.activeRegions(),
    labels: app.areaLabels().length,
  };
};

const wide = () => view(center.lon, center.lat - 0.055, 5200, -30);

let waited = 0;
for (const t of [15, 15, 15, 15]) {
  await new Promise((r) => setTimeout(r, t * 1000));
  waited += t;
  await wide();
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`T~${waited}s:`, JSON.stringify(await page.evaluate(statsExpr)));
  await page.screenshot({ path: `test/feat_wide_${waited}s.png` });
}

// 近景：对准中部水洼（第二雨区下游谷地），斜视看深浅分档
await view(center.lon - 0.005, center.lat - 0.045, 2600, -28);
await new Promise((r) => setTimeout(r, 1800));
await page.screenshot({ path: "test/feat_close.png" });

console.log("LOGS:", JSON.stringify(logs.slice(0, 8)));
await page.close();
await browser.disconnect();