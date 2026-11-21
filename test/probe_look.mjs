// 目视检查：双石门 50mm/30s，近距离沿沟机位，附 fps 采样
import puppeteer from "puppeteer-core";

const mm = Number(process.argv[2] ?? 50);
const dur = Number(process.argv[3] ?? 30);
const tag = process.argv[4] ?? "look";
const EXTENT = [103.978, 34.923, 104.016, 34.963];
const DOMAIN = [[0.1, 0.07], [0.93, 0.1], [0.96, 0.56], [0.79, 0.93], [0.3, 0.96], [0.06, 0.6]];
const RAIN = [[0.3, 0.62], [0.72, 0.6], [0.66, 0.92], [0.34, 0.94]];

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223" });
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => { if (["error", "warning"].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeout = 60000, label = "") => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await page.evaluate(fn)) return true; await sleep(300); }
  console.log("TIMEOUT", label);
  return false;
};

try {
  await page.goto("http://127.0.0.1:8931/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitFor(() => window.__app?.ready === true, 90000, "ready");
  await page.evaluate((ext, dv, rv) => {
    const app = window.__app;
    const carto = (uv) => uv.map(([u, v]) => [ext[0] + u * (ext[2] - ext[0]), ext[1] + v * (ext[3] - ext[1])]);
    return app.commitGlobeDomain(ext, dv);
  }, EXTENT, DOMAIN);
  await waitFor(() => !!window.__app.fluid, 90000, "fluid");
  await page.evaluate((rv) => window.__app.commitRegionUV(rv), RAIN);
  await page.bringToFront();

  const cam = await page.evaluate(async (ext) => {
    const C = window.Cesium;
    const cam = window.__app.viewer.camera;
    const lon = (ext[0] + ext[2]) / 2;
    const lat = ext[1] + (ext[3] - ext[1]) * 0.45;
    const pos = await C.sampleTerrainMostDetailed(window.__app.viewer.terrainProvider, [
      C.Cartographic.fromDegrees(lon, lat),
    ]);
    const ground = pos[0].height;
    cam.cancelFlight();
    cam.setView({
      destination: C.Cartesian3.fromDegrees(lon, lat - 0.012, ground + 700),
      orientation: { heading: C.Math.toRadians(0), pitch: C.Math.toRadians(-25), roll: 0 },
    });
    return { lon, lat, ground };
  }, EXTENT);
  await sleep(1500);
  const fps = await page.evaluate(() => new Promise((res) => {
    let n = 0; const t0 = performance.now();
    const tick = () => { n += 1; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else res(Math.round(n / ((performance.now() - t0) / 1000))); };
    requestAnimationFrame(tick);
  }));
  await page.screenshot({ path: `test/look_${tag}_before.png` });

  await page.evaluate((m, d) => {
    window.__app.setRainfall(m, d, "amount");
    window.__app.setRainEnabled(true);
  }, mm, dur);
  await waitFor((d) => {
    const s = window.__app.rainfallConfig()?.stats;
    return !!s && s.elapsedSec >= d - 0.05;
  }, 240000, "rain done");
  await sleep(600);
  const stats = await page.evaluate(() => window.__app.rainfallConfig().stats);
  const dc = await page.evaluate(() => window.__app.depthConfig());
  await page.screenshot({ path: `test/look_${tag}_after.png` });
  console.log("CAM:", JSON.stringify(cam), "FPS:", fps);
  console.log("STATS:", JSON.stringify(stats));
  console.log("BANDS:", JSON.stringify(dc.bands), "BOX:", dc.boxThicknessM);
  console.log("LOGS:", JSON.stringify(logs.slice(0, 6)));
} catch (e) {
  console.log("ERROR:", e);
  console.log("LOGS:", JSON.stringify(logs.slice(0, 8)));
} finally {
  await page.close();
  browser.disconnect();
}