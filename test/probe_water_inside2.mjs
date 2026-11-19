/**
 * 诊断 v4：盒内机位水体可见性（用 GeoTIFF 夹具，避开当前 ArcGIS 网络不可用）。
 * 真 GPU CDP :9223。
 *
 * 流程：上传 test/fixture_dem.tif（北京 bbox、高程 1207~3002m，厚度≈1794m）
 *      → commitDomainUV 划域 → 雨区 + 降雨 20s
 *      → 沿椭球高度从盒顶之上扫到盒内，对比体积阶段开/关两帧像素差。
 *
 * 用法：node test/probe_water_inside2.mjs
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8931/";
const CDP = "http://127.0.0.1:9223";
const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "").replace(/\//g, path.sep));
const OUT = DIR.endsWith(path.sep) ? DIR : DIR + path.sep;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null, protocolTimeout: 300000 });
  for (const p of await browser.pages()) {
    if (p.url() !== "about:blank") { try { await p.close(); } catch {} }
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 850 });
  const logs = [];
  page.on("pageerror", (e) => logs.push("PAGEERROR: " + String(e.message).slice(0, 220)));
  page.on("console", (m) => { if (m.type() === "error") logs.push("CONSOLE: " + String(m.text()).slice(0, 220)); });

  try {
    await page.goto(BASE + "index.html?inside2=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });
    console.log("ready");

    // 上传 GeoTIFF 夹具
    const input = await page.$("#fileInput");
    await input.uploadFile(path.join(DIR, "fixture_dem.tif"));
    // 等 pendingDomainDem 就绪（upload 解析是异步的）
    let committed = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      committed = await page.evaluate(() =>
        window.__app.commitDomainUV([
          [0.15, 0.15],
          [0.85, 0.15],
          [0.85, 0.85],
          [0.15, 0.85],
        ]),
      );
      if (committed && committed.ok) break;
    }
    console.log("commit:", JSON.stringify(committed));
    await page.waitForFunction(() => !!window.__app?.fluid, { timeout: 60000 });
    const box = await page.evaluate(() => {
      const f = window.__app.fluid;
      return {
        thickness: f._volumeThickness,
        center: f._volumeCenterElevation,
        top: f._volumeCenterElevation + f._volumeThickness / 2,
        bottom: f._volumeCenterElevation - f._volumeThickness / 2,
      };
    });
    console.log("box:", JSON.stringify(box));
    if (!(box.thickness > 200)) {
      console.log("thickness too small -> abort");
      return;
    }

    await page.evaluate(() => {
      window.__probe = {
        readFrame() {
          return new Promise((resolve) => {
            const scene = window.__app.viewer.scene;
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
          const c = window.__app.viewer.camera;
          const p = c.positionCartographic;
          const f = window.__app.fluid;
          const st = f._stages[4];
          const local = Cesium.Matrix4.multiplyByPoint(st._inverseModelMatrix, c.positionWC, new Cesium.Cartesian3());
          const centerEcef = Cesium.Matrix4.getTranslation(st._modelMatrix, new Cesium.Cartesian3());
          const centerCarto = Cesium.Cartographic.fromCartesian(centerEcef);
          return {
            lon: +Cesium.Math.toDegrees(p.longitude).toFixed(5),
            lat: +Cesium.Math.toDegrees(p.latitude).toFixed(5),
            ellipsoidH: +p.height.toFixed(1),
            pitchDeg: +Cesium.Math.toDegrees(c.pitch).toFixed(1),
            inside: st._insideBox,
            show: st.show,
            boxCenterH: +(centerCarto.height ?? 0).toFixed(1),
            local: { x: +local.x.toFixed(3), y: +local.y.toFixed(3), z: +local.z.toFixed(3) },
          };
        },
        setCam(lon, lat, ellipsoidH, pitchDeg) {
          const cam = window.__app.viewer.camera;
          cam.cancelFlight();
          cam.setView({
            destination: Cesium.Cartesian3.fromDegrees(lon, lat, ellipsoidH),
            orientation: { heading: 0, pitch: Cesium.Math.toRadians(pitchDeg), roll: 0 },
          });
        },
        measureFps(seconds) {
          return new Promise((resolve) => {
            let frames = 0;
            const t0 = performance.now();
            const tick = () => {
              frames++;
              if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(tick);
              else resolve(+(frames / ((performance.now() - t0) / 1000)).toFixed(1));
            };
            requestAnimationFrame(tick);
          });
        },
      };
    });

    await page.evaluate(() => {
      window.__app.commitTestRegion(0.3, 0.3);
      window.__app.options.rainIntensity = 0.001;
      window.__app.options.rainEnabled = true;
    });
    await sleep(20000);
    console.log("injected:", await page.evaluate(() => window.__app.injectedAmount()));

    const center = await page.evaluate(() => {
      const e = window.__app.extent;
      return { lon: (e[0] + e[2]) / 2, lat: (e[1] + e[3]) / 2, e };
    });
    console.log("center:", JSON.stringify(center));

    // 夹具 DEM 高程 0~235m → 盒顶≈235m；从盒外上方扫到盒内底部
    const heights = [400, 300, 250, 235, 210, 180, 140, 100, 60, 25, 8];
    const results = [];
    for (const h of heights) {
      await page.evaluate(
        (lon, lat, hh) => window.__probe.setCam(lon, lat - 0.008, hh, -25),
        center.lon,
        center.lat,
        h,
      );
      await sleep(900);
      const cam = await page.evaluate(() => window.__probe.camInfo());
      await page.evaluate(() => { window.__app.fluid._stages[4].show = false; });
      await sleep(320);
      const off = await page.evaluate(() => window.__probe.readFrame());
      await page.evaluate(() => { window.__app.fluid._stages[4].show = true; });
      await sleep(320);
      const on = await page.evaluate(() => window.__probe.readFrame());
      const m = await page.evaluate((a, b) => window.__probe.analyze(a, b), on, off);
      results.push({ h, cam, ...m });
      console.log(`h=${h} inside=${cam.inside} local.z=${cam.local.z} diff=${m.diffPct}% blueOn=${m.blueOnPct}% blueOff=${m.blueOffPct}%`);
      if ([250, 210, 140, 60].includes(h)) await page.screenshot({ path: OUT + `inside2_h${h}.png` });
      if (h === 2500) console.log("fps inside:", await page.evaluate(() => window.__probe.measureFps(2.5)));
    }

    fs.writeFileSync(OUT + "probe_water_inside2.json", JSON.stringify({ box, center, results, logs }, null, 2));
    console.log("LOGS:", JSON.stringify(logs.slice(0, 6)));
    console.log("done");
  } finally {
    await page.close().catch(() => {});
    browser.disconnect();
  }
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });