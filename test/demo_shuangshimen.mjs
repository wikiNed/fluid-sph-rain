// 甘肃渭源双石门沟 7·26 山洪 —— 事件复演（真 GPU CDP :9223）
// 用法：node test/demo_shuangshimen.mjs [mm] [durSec] [tag]
// 例：  node test/demo_shuangshimen.mjs 50 60 scen50
//       node test/demo_shuangshimen.mjs 150 60 scen150
import puppeteer from "puppeteer-core";

const MM = +(process.argv[2] ?? 50);
const DUR = +(process.argv[3] ?? 60);
const TAG = process.argv[4] || `m${MM}`;

// 双石门沟（甘肃定西渭源县会川镇罗家磨村，黄香沟上游河谷）
// 3.5 km × 4.4 km 河谷小流域；v=0 为北，上游在南侧
const EXTENT = [103.978, 34.923, 104.016, 34.963];
const DOMAIN_UV = [
  [0.1, 0.07],
  [0.93, 0.1],
  [0.96, 0.56],
  [0.79, 0.93],
  [0.3, 0.96],
  [0.06, 0.6],
];
const RAIN_UV = [
  [0.3, 0.62],
  [0.72, 0.6],
  [0.66, 0.92],
  [0.34, 0.94],
];

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9223",
  defaultViewport: null,
  protocolTimeout: 600000,
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
await page.bringToFront();
const logs = [];
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${String(e.message).slice(0, 200)}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.goto("http://127.0.0.1:8931/index.html?smsm=" + Date.now(), {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 120000 });

  const dom = await page.evaluate(
    async ([extent, domainUV]) => window.__app.commitGlobeDomain(extent, domainUV),
    [EXTENT, DOMAIN_UV],
  );
  console.log("DOMAIN:", JSON.stringify(dom));
  await page.waitForFunction(() => !!window.__app?.fluid, { timeout: 120000 });

  await page.evaluate((rainUV) => window.__app.commitRegionUV(rainUV), RAIN_UV);
  const rainOk = await page.evaluate(() => ({
    active: window.__app.activeRegions().length,
    areas: window.__app.areas ? window.__app.areas() : null,
  }));
  console.log("RAIN:", JSON.stringify(rainOk));

  const camInfo = await page.evaluate(async () => {
    const app = window.__app;
    const e = app.domain.extent;
    const lon = (e[0] + e[2]) / 2;
    const lat = e[3] + 0.004; // 下游（北）向南看，沟道由远及近
    const tp = app.viewer.terrainProvider;
    const c = (await Cesium.sampleTerrainMostDetailed(tp, [Cesium.Cartographic.fromDegrees(lon, lat)]))[0];
    const cam = app.viewer.camera;
    cam.cancelFlight();
    cam.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, c.height + 2400),
      orientation: { heading: Math.PI, pitch: Cesium.Math.toRadians(-30), roll: 0 },
    });
    return {
      lon,
      lat,
      ground: Math.round(c.height),
      thickness: app.volumeThickness ? app.volumeThickness() : null,
      imageryCount: app.viewer.imageryLayers.length,
      terrainProvider: tp?.constructor?.name,
      areas: app.areas ? app.areas() : null,
    };
  });
  console.log("CAM:", JSON.stringify(camInfo));

  const statsExpr = () => {
    const app = window.__app;
    const ctx = app.viewer.scene.context;
    const tex = app.fluid._simTextures[2];
    const fb = new Cesium.Framebuffer({ context: ctx, colorTextures: [tex], destroyAttachments: false });
    const px = ctx.readPixels({ framebuffer: fb, x: 0, y: 0, width: tex.width, height: tex.height });
    fb.destroy();
    const dc = app.depthConfig();
    const boxM = dc.boxThicknessM; // 与水体几何高度同一把尺子
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
      maxM: +(maxFrac * boxM).toFixed(2),
      bandPct: bands.map((v) => +((v / Math.max(wet, 1)) * 100).toFixed(1)),
      // 显示水深(米) × 面积 = 体积量级（m³，几何放大口径，仅作量级参考）
      volM3: Math.round(sumFrac * 0.25 * boxM * (app.areas().domainKm2 * 1e6 / n)),
      rain: app.rainfallConfig().stats,
      fx: app.rainFxInfo().amount,
    };
  };

  await sleep(2500);
  await page.screenshot({ path: `test/smsm_${TAG}_before.png` });
  console.log("BEFORE:", JSON.stringify(await page.evaluate(statsExpr)));

  await page.evaluate(
    ([mm, dur]) => {
      window.__app.setRainfall(mm, dur, "amount");
      window.__app.options.rainEnabled = true;
    },
    [MM, DUR],
  );
  const cfg = await page.evaluate(() => window.__app.rainfallConfig());
  console.log("CFG:", JSON.stringify({ mm: cfg.amountMm, dur: cfg.durationSec, rate: cfg.rateMmH }));

  for (const t of [20, 40]) {
    await sleep(20000);
    const s = await page.evaluate(statsExpr);
    console.log(`T${t}s:`, JSON.stringify(s));
    await page.screenshot({ path: `test/smsm_${TAG}_t${t}.png` });
  }

  // 等雨下完（页面若被遮挡 rAF 暂停，elapsed 会走得比墙钟慢，必须按仿真状态等待）
  await page.waitForFunction(
    () => {
      const s = window.__app.rainfallConfig().stats;
      return s.passInjection === 0 || s.elapsedSec >= s.durationSec - 0.05;
    },
    { timeout: 240000, polling: 500 },
  );
  await sleep(1500);
  console.log(`T${DUR + 8}s:`, JSON.stringify(await page.evaluate(statsExpr)));
  await page.screenshot({ path: `test/smsm_${TAG}_t${DUR + 8}.png` });

  console.log("LOGS:", JSON.stringify(logs.slice(0, 6)));

  // 出图：隐藏域/雨区半透明填充与标注（保留描边+图例），避免橙色蒙版压住水色
  await page.evaluate(() => {
    for (const e of window.__app.viewer.entities.values) {
      if (e.polygon) e.polygon.show = false;
      if (e.label) e.label.show = false;
    }
  });
  await sleep(1200);
  await page.screenshot({ path: `test/smsm_${TAG}_clean.png` });

  // 近景：沟道汇流细节（沿沟向下游看，heading 180 = 朝南看上游？此处朝北下游）
  await page.evaluate(async () => {
    const app = window.__app;
    const lon = 103.9965;
    const lat = 34.9465;
    const c = (await Cesium.sampleTerrainMostDetailed(app.viewer.terrainProvider, [
      Cesium.Cartographic.fromDegrees(lon, lat),
    ]))[0];
    const cam = app.viewer.camera;
    cam.cancelFlight();
    cam.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, c.height + 900),
      orientation: { heading: Cesium.Math.toRadians(200), pitch: Cesium.Math.toRadians(-28), roll: 0 },
    });
  });
  await sleep(2500);
  await page.screenshot({ path: `test/smsm_${TAG}_close.png` });
} catch (e) {
  console.log("ERROR:", String(e.stack || e).slice(0, 400));
} finally {
  await page.close().catch(() => {});
  await browser.disconnect();
}