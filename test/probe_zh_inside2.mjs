/**
 * 诊断 v6：①中文标注叠加层正确置顶后是否可见（四川卫星底图 + 高德中文叠加）
 *          ②盒内机位水平视角看地形剖面与积水（而不是整屏水膜）
 * 真 GPU CDP :9223。
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
  page.on("pageerror", (e) => logs.push("PAGEERROR: " + String(e.message).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") logs.push("CONSOLE: " + String(m.text()).slice(0, 200)); });

  const report = {};
  try {
    await page.goto(BASE + "index.html?probe6=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });
    console.log("ready");

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
        diffPct(on, off) {
          const { w, h } = on;
          let changed = 0;
          for (let i = 0; i < on.px.length; i += 4) {
            const d = Math.abs(on.px[i] - off.px[i]) + Math.abs(on.px[i + 1] - off.px[i + 1]) + Math.abs(on.px[i + 2] - off.px[i + 2]);
            if (d > 24) changed++;
          }
          return +(100 * changed / (w * h)).toFixed(2);
        },
        addAmapSatelliteBottom() {
          const C = Cesium;
          const v = window.__app.viewer;
          const p = new C.UrlTemplateImageryProvider({
            url: "https://webst0{s}.is.autonavi.com/appmaptile?style=6&lang=zh_cn&size=1&scl=1&x={x}&y={y}&z={z}",
            subdomains: ["1", "2", "3", "4"],
            maximumLevel: 18,
          });
          const l = v.imageryLayers.addImageryProvider(p);
          v.imageryLayers.lowerToBottom(l); // 放到最底层，中文叠加仍在上面
          return { count: v.imageryLayers.length, index: v.imageryLayers.indexOf(l) };
        },
        view(lon, lat, h, pitchDeg, headingDeg = 0) {
          const cam = window.__app.viewer.camera;
          cam.cancelFlight();
          cam.setView({
            destination: Cesium.Cartesian3.fromDegrees(lon, lat, h),
            orientation: { heading: Cesium.Math.toRadians(headingDeg), pitch: Cesium.Math.toRadians(pitchDeg), roll: 0 },
          });
        },
        camInfo() {
          const f = window.__app.fluid;
          const st = f?._stages?.[4];
          const c = window.__app.viewer.camera;
          if (!st) return { inside: null };
          const local = Cesium.Matrix4.multiplyByPoint(st._inverseModelMatrix, c.positionWC, new Cesium.Cartesian3());
          return {
            inside: st._insideBox,
            local: { x: +local.x.toFixed(3), y: +local.y.toFixed(3), z: +local.z.toFixed(3) },
          };
        },
        waterStats() {
          const f = window.__app.fluid;
          const tex = f._simTextures[2];
          const ctx = window.__app.viewer.scene.context;
          const fb = new Cesium.Framebuffer({ context: ctx, colorTextures: [tex], destroyAttachments: false });
          const data = ctx.readPixels({ framebuffer: fb, x: 0, y: 0, width: 1024, height: 1024 });
          const vols = [];
          for (let i = 0; i < data.length; i += 4) vols.push(data[i]);
          vols.sort((a, b) => a - b);
          const q = (p) => vols[Math.floor(p * (vols.length - 1))];
          const fullM = window.__app.options.depthFullM;
          return {
            thickness: f._volumeThickness,
            fullM,
            p50M: +(q(0.5) * 0.25 * fullM).toFixed(2),
            p90M: +(q(0.9) * 0.25 * fullM).toFixed(2),
            maxM: +(q(1) * 0.25 * fullM).toFixed(2),
          };
        },
      };
    });

    /* ① 中文标注 */
    const sat = await page.evaluate(() => window.__probe.addAmapSatelliteBottom());
    console.log("addAmapSatelliteBottom:", JSON.stringify(sat));
    await page.evaluate(() => window.__probe.view(103.6, 30.7, 4000, -35));
    await page.evaluate(() => { window.__app.options.refZhAmap = true; window.__app.applyRefLayerVisibility(); });
    await sleep(7000);
    const on = await page.evaluate(() => window.__probe.readFrame());
    await page.screenshot({ path: OUT + "zh2_on.png" });
    await page.evaluate(() => { window.__app.options.refZhAmap = false; window.__app.applyRefLayerVisibility(); });
    await sleep(1500);
    const off = await page.evaluate(() => window.__probe.readFrame());
    await page.screenshot({ path: OUT + "zh2_off.png" });
    report.zh = { diffPct: await page.evaluate((a, b) => window.__probe.diffPct(a, b), on, off), layers: await page.evaluate(() => window.__app.refLayers()) };
    console.log("zh diffPct:", report.zh.diffPct, "zhState:", JSON.stringify(report.zh.layers.zh));
    await page.evaluate(() => { window.__app.options.refZhAmap = true; window.__app.applyRefLayerVisibility(); });

    /* ② 盒内水平视角 */
    await page.evaluate(() => window.__probe.view(103.6, 30.7, 20000, -89));
    const input = await page.$("#fileInput");
    await input.uploadFile(path.join(DIR, "fixture_dem.tif"));
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
    await page.waitForFunction(() => !!window.__app?.fluid, { timeout: 60000 });
    const box = await page.evaluate(() => {
      const f = window.__app.fluid;
      return { thickness: f._volumeThickness, center: f._volumeCenterElevation, top: f._volumeCenterElevation + f._volumeThickness / 2, bottom: f._volumeCenterElevation - f._volumeThickness / 2 };
    });
    console.log("box:", JSON.stringify(box));
    report.box = box;

    await page.evaluate(() => {
      window.__app.commitTestRegion(0.42, 0.42);
      window.__app.options.rainIntensity = 0.0004;
      window.__app.options.rainEnabled = true;
    });
    const center = await page.evaluate(() => {
      const e = window.__app.extent;
      return { lon: (e[0] + e[2]) / 2, lat: (e[1] + e[3]) / 2 };
    });
    await sleep(30000);
    console.log("injected:", await page.evaluate(() => window.__app.injectedAmount()));
    console.log("waterStats:", JSON.stringify(await page.evaluate(() => window.__probe.waterStats())));

    // 水平视角：站在盒内北侧高处，向南看
    const cams = [
      { lon: center.lon, lat: center.lat + 0.06, h: box.top - 60, pitch: -12, heading: 180, tag: "north_inside_horizon" },
      { lon: center.lon, lat: center.lat + 0.03, h: box.bottom + 60, pitch: -20, heading: 180, tag: "low_inside_valley" },
      { lon: center.lon, lat: center.lat + 0.06, h: box.top + 120, pitch: -18, heading: 180, tag: "above_top" },
    ];
    for (const c of cams) {
      await page.evaluate(
        (lon, lat, hh, pd, hd) => window.__probe.view(lon, lat, hh, pd, hd),
        c.lon,
        c.lat,
        c.h,
        c.pitch,
        c.heading,
      );
      await sleep(1600);
      const info = await page.evaluate(() => window.__probe.camInfo());
      await page.screenshot({ path: OUT + `inside4_${c.tag}.png` });
      console.log(`shot ${c.tag}`, JSON.stringify(info));
      report[c.tag] = info;
    }

    fs.writeFileSync(OUT + "probe_zh2_inside4.json", JSON.stringify(report, null, 2));
    console.log("LOGS:", JSON.stringify(logs.slice(0, 8)));
    console.log("done");
  } finally {
    await page.close().catch(() => {});
    browser.disconnect();
  }
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });