/**
 * 诊断 v2：相机「离地高度」变化时的水体可见性（真 GPU CDP :9223）。
 *
 * 关键修正：Cesium fromDegrees 的 height 是相对椭球面，不是相对地面。
 * 本脚本先采样相机位置的地面高程，再按"离地 AGL"设定机位，避免相机埋进山体。
 *
 * 用法：node test/probe_water_zoom2.mjs
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const BASE = "http://127.0.0.1:8931/";
const CDP = "http://127.0.0.1:9223";
const OUT = new URL("./", import.meta.url).pathname.replace(/^\//, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1500, height: 850 } });
  const page = await browser.newPage();
  const logs = [];
  page.on("pageerror", (e) => logs.push("[pageerror] " + e.message));
  page.on("console", (m) => { if (m.type() === "error") logs.push("[console] " + m.text()); });

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction("window.__app && __app.ready === true", { timeout: 90000 });
  console.log("ready");

  await page.evaluate(() => {
    window.__probe = {
      readFrame() {
        return new Promise((resolve) => {
          const scene = __app.viewer.scene;
          const remove = scene.postRender.addEventListener(() => {
            const gl = scene.context._gl;
            const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
            const px = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
            remove();
            resolve({ w, h, px: Array.from(px) });
          });
        });
      },
      analyze(on, off) {
        const { w, h } = on;
        let changed = 0, blueOn = 0, blueOff = 0;
        for (let i = 0; i < on.px.length; i += 4) {
          const d = Math.abs(on.px[i] - off.px[i]) + Math.abs(on.px[i + 1] - off.px[i + 1]) + Math.abs(on.px[i + 2] - off.px[i + 2]);
          if (d > 24) changed++;
          if (on.px[i + 2] > on.px[i] + 20 && on.px[i + 2] > on.px[i + 1] + 8) blueOn++;
          if (off.px[i + 2] > off.px[i] + 20 && off.px[i + 2] > off.px[i + 1] + 8) blueOff++;
        }
        return {
          diffPct: +(100 * changed / (w * h)).toFixed(2),
          blueOnPct: +(100 * blueOn / (w * h)).toFixed(2),
          blueOffPct: +(100 * blueOff / (w * h)).toFixed(2),
        };
      },
      camInfo() {
        const c = __app.viewer.camera;
        const p = c.positionCartographic;
        return {
          lon: +Cesium.Math.toDegrees(p.longitude).toFixed(5),
          lat: +Cesium.Math.toDegrees(p.latitude).toFixed(5),
          ellipsoidH: +p.height.toFixed(1),
          pitchDeg: +Cesium.Math.toDegrees(c.pitch).toFixed(1),
        };
      },
      async groundAt(lon, lat) {
        const r = await Cesium.sampleTerrainMostDetailed(__app.viewer.terrainProvider, [
          Cesium.Cartographic.fromDegrees(lon, lat),
        ]);
        return r[0].height;
      },
      setCam(lon, lat, agl, pitchDeg) {
        __app.viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, agl),
          orientation: { heading: 0, pitch: Cesium.Math.toRadians(pitchDeg), roll: 0 },
        });
      },
    };
  });

  // 1. 划域 + 雨区 + 降雨
  await page.evaluate(() => __app.commitGlobeDomain([-119.55, 37.74, -119.47, 37.8]));
  await page.waitForFunction("!!__app.fluid", { timeout: 120000 });
  await sleep(1500);
  await page.evaluate(() => {
    __app.commitTestRegion(0.34, 0.34);
    __app.options.rainIntensity = 0.001;
    __app.options.rainEnabled = true;
  });
  await sleep(30000);

  const st = await page.evaluate(() => ({ injected: __app.injectedAmount(), thickness: __app.volumeThickness() }));
  console.log("state:", JSON.stringify(st));

  const ext = await page.evaluate(() => __app.extent);
  const [w0, s0, e0, n0] = ext;
  const lon = (w0 + e0) / 2;
  const lat = (s0 + n0) / 2 - 0.01;

  // 采样相机地面高程（一次，之后按 AGL 设定）
  const ground = await page.evaluate((lon, lat) => __probe.groundAt(lon, lat), lon, lat);
  console.log("ground under camera:", ground.toFixed(1), "m");
  const boxTop = await page.evaluate(() => {
    const f = __app.fluid;
    return (f._volumeCenterElevation ?? 0) + (f._volumeThickness ?? 0) / 2;
  });
  console.log("box top elevation:", boxTop.toFixed(1), "m");

  const agls = [6000, 3000, 1500, 800, 400, 200, 80, 30];
  const results = [];
  for (const agl of agls) {
    await page.evaluate((lon, lat, g, agl, pitch) => __probe.setCam(lon, lat, g + agl, pitch), lon, lat, ground, agl, -25);
    await sleep(1200);
    const cam = await page.evaluate(() => __probe.camInfo());
    await page.evaluate(() => { __app.fluid._stages[4].show = false; });
    await sleep(400);
    const off = await page.evaluate(() => __probe.readFrame());
    await page.evaluate(() => { __app.fluid._stages[4].show = true; });
    await sleep(400);
    const on = await page.evaluate(() => __probe.readFrame());
    const m = await page.evaluate((a, b) => __probe.analyze(a, b), on, off);
    results.push({ agl, cam, ...m });
    console.log(`agl=${agl}m ellipsoidH=${cam.ellipsoidH} diff=${m.diffPct}% blueOn=${m.blueOnPct}% blueOff=${m.blueOffPct}%`);
    if ([3000, 800, 200, 80].includes(agl)) {
      await page.screenshot({ path: OUT + `zoom2_h${agl}.png` });
    }
  }

  fs.writeFileSync(OUT + "zoom2_report.json", JSON.stringify({ state: st, ground, boxTop, results, logs }, null, 2));
  console.log("logs:", logs.join(" | ") || "(empty)");
  await page.close();
  browser.disconnect();
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });