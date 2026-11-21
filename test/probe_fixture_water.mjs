// 夹具 DEM 上「体积阶段画不画得出水」的最小诊断。
import puppeteer from "puppeteer-core";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "").replace(/\//g, path.sep));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: null, protocolTimeout: 300000 });
for (const p of await browser.pages()) if (p.url() !== "about:blank") { try { await p.close(); } catch {} }
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 700 });
const logs = [];
page.on("pageerror", (e) => logs.push("PAGEERROR " + String(e.message).slice(0, 200)));
try {
  await page.goto("http://127.0.0.1:8931/index.html?pw=" + Date.now(), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });

  await page.evaluate(() => {
    const cam = window.__app.viewer.camera;
    cam.setView({
      destination: Cesium.Cartesian3.fromDegrees(116.32, 39.88, 6000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-50), roll: 0 },
    });
  });
  const input = await page.$("#fileInput");
  await input.uploadFile(path.join(DIR, "fixture_dem.tif"));

  for (let i = 0; i < 60; i += 1) {
    const dom = await page.evaluate(() => window.__app.hasDomain());
    if (dom) break;
    if (i === 3) await page.evaluate(() => window.__app.commitDomainUV([[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]));
    await sleep(1000);
  }
  for (let i = 0; i < 120 && !(await page.evaluate(() => !!window.__app.fluid)); i += 1) await sleep(500);

  await page.evaluate(() => {
    window.__app.commitTestRegion(0.3, 0.3);
    window.__app.setRainfall(1000, 20, "amount");
    window.__app.setRainEnabled(true);
  });
  await sleep(12000);

  const info = await page.evaluate(async () => {
    const app = window.__app;
    const scene = app.viewer.scene;
    const gl = scene.context._gl;
    const stage = app.fluid._stages[4];
    const snap = () =>
      new Promise((resolve) => {
        const off = scene.postRender.addEventListener(() => {
          off();
          const w = gl.drawingBufferWidth;
          const h = gl.drawingBufferHeight;
          const buf = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          resolve({ w, h, buf });
        });
      });
    const diff = (a, b) => {
      let n = 0;
      for (let i = 0; i < Math.min(a.buf.length, b.buf.length); i += 4) {
        if (Math.abs(a.buf[i] - b.buf[i]) > 12 || Math.abs(a.buf[i + 1] - b.buf[i + 1]) > 12 || Math.abs(a.buf[i + 2] - b.buf[i + 2]) > 12) n += 1;
      }
      return +((100 * n) / (a.w * a.h)).toFixed(2);
    };

    const cam = app.viewer.camera;
    const out = { cam: {}, diffs: [] };
    const ext = app.precisionInfo().extent;
    const thick = app.depthConfig().boxThicknessM;
    const candidates = [
      { lon: (ext[0] + ext[2]) / 2, lat: (ext[1] + ext[3]) / 2, h: thick * 1.2 + 50, pitch: -40 },
      { lon: (ext[0] + ext[2]) / 2, lat: (ext[1] + ext[3]) / 2, h: thick * 2.2 + 50, pitch: -55 },
      { lon: (ext[0] + ext[2]) / 2, lat: ext[1] + (ext[3] - ext[1]) * 0.2, h: thick * 3, pitch: -35 },
    ];
    for (const c of candidates) {
      cam.cancelFlight();
      cam.setView({
        destination: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, c.h),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(c.pitch), roll: 0 },
      });
      await new Promise((r) => setTimeout(r, 1200));
      stage.show = true;
      const on = await snap();
      stage.show = false;
      await new Promise((r) => setTimeout(r, 200));
      const off = await snap();
      stage.show = true;
      out.diffs.push({ ...c, diff: diff(on, off) });
    }
    out.stats = app.rainfallConfig().stats;
    out.bands = app.depthConfig().bands;
    out.thick = thick;
    out.ws = app.waterSurfaceInfo?.();
    out.stageShow = stage.show;
    return out;
  });

  console.log("OUT:", JSON.stringify(info));
  console.log("LOGS:", JSON.stringify(logs.slice(0, 5)));
  await page.screenshot({ path: "test/fixture_water_probe.png" });
} finally {
  await page.close();
  await browser.disconnect();
}
