/**
 * 诊断 v5：①中文标注叠加层（高德，中国境内）②盒内机位「能看到自然水洼」
 * 真 GPU CDP :9223，1500×850。
 *
 * 用法：node test/probe_zh_inside.mjs
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

  const report = { zh: {}, inside: {}, logs };
  try {
    await page.goto(BASE + "index.html?probezh=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });
    console.log("ready");

    /* ---------- ① 中文标注叠加层 ---------- */
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
        addAmapSatellite() {
          const C = Cesium;
          const v = window.__app.viewer;
          const p = new C.UrlTemplateImageryProvider({
            url: "https://webst0{s}.is.autonavi.com/appmaptile?style=6&lang=zh_cn&size=1&scl=1&x={x}&y={y}&z={z}",
            subdomains: ["1", "2", "3", "4"],
            maximumLevel: 18,
          });
          const l = v.imageryLayers.addImageryProvider(p);
          return v.imageryLayers.length;
        },
        view(lon, lat, h, pitchDeg) {
          const cam = window.__app.viewer.camera;
          cam.cancelFlight();
          cam.setView({
            destination: Cesium.Cartesian3.fromDegrees(lon, lat, h),
            orientation: { heading: 0, pitch: Cesium.Math.toRadians(pitchDeg), roll: 0 },
          });
        },
      };
    });

    const zh0 = await page.evaluate(() => window.__app.refLayers());
    console.log("refLayers initial:", JSON.stringify(zh0));
    report.zh.initial = zh0;

    await page.evaluate(() => window.__probe.addAmapSatellite());
    await page.evaluate(() => window.__probe.view(103.6, 30.7, 4000, -35));
    await sleep(7000);
    await page.evaluate(() => { window.__app.options.refZhAmap = true; window.__app.applyRefLayerVisibility(); });
    await sleep(1200);
    const on = await page.evaluate(() => window.__probe.readFrame());
    await page.screenshot({ path: OUT + "zh_on.png" });
    const zhOn = await page.evaluate(() => window.__app.refLayers());
    await page.evaluate(() => { window.__app.options.refZhAmap = false; window.__app.applyRefLayerVisibility(); });
    await sleep(1200);
    const off = await page.evaluate(() => window.__probe.readFrame());
    await page.screenshot({ path: OUT + "zh_off.png" });
    const zhOff = await page.evaluate(() => window.__app.refLayers());
    const zhDiff = await page.evaluate((a, b) => window.__probe.diffPct(a, b), on, off);
    report.zh.on = zhOn;
    report.zh.off = zhOff;
    report.zh.diffPct = zhDiff;
    console.log("zh diffPct:", zhDiff, "countOn:", zhOn.imageryCount, "countOff:", zhOff.imageryCount);

    // 天地图 tk 行为：无 tk 不加层；假 tk 建层但不报致命错误
    const tdtNoToken = await page.evaluate(() => {
      window.__app.options.refTdtLabels = true;
      window.__app.options.tdtToken = "";
      window.__app.applyRefLayerVisibility();
      return window.__app.refLayers().zh;
    });
    const tdtFake = await page.evaluate(() => {
      window.__app.options.tdtToken = "fake_token_for_test";
      window.__app.applyRefLayerVisibility();
      return window.__app.refLayers().zh;
    });
    report.zh.tdtNoToken = tdtNoToken;
    report.zh.tdtFakeToken = tdtFake;
    console.log("tdt noToken:", JSON.stringify(tdtNoToken), "fake:", JSON.stringify(tdtFake));
    await page.evaluate(() => { window.__app.options.refTdtLabels = false; window.__app.options.tdtToken = ""; window.__app.applyRefLayerVisibility(); });

    /* ---------- ② 盒内自然水洼 ---------- */
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
    console.log("commit:", JSON.stringify(committed));
    await page.waitForFunction(() => !!window.__app?.fluid, { timeout: 60000 });
    const box = await page.evaluate(() => {
      const f = window.__app.fluid;
      return {
        thickness: f._volumeThickness,
        top: f._volumeCenterElevation + f._volumeThickness / 2,
      };
    });
    console.log("box:", JSON.stringify(box));
    report.inside.box = box;

    // 默认雨强 0.0004、雨区留在中部，让水往低处汇
    await page.evaluate(() => {
      window.__app.commitTestRegion(0.42, 0.42);
      window.__app.options.rainIntensity = 0.0004;
      window.__app.options.rainEnabled = true;
    });
    const center = await page.evaluate(() => {
      const e = window.__app.extent;
      return { lon: (e[0] + e[2]) / 2, lat: (e[1] + e[3]) / 2, e };
    });
    await sleep(25000);
    console.log("injected:", await page.evaluate(() => window.__app.injectedAmount()));

    // 盒内机位：焦距拉近（相机在盒顶以下，看向南侧低洼处）
    const shots = [
      { h: box.top - 30, pitch: -55, tag: "top_minus30" },
      { h: box.top - 70, pitch: -65, tag: "top_minus70" },
      { h: box.top - 120, pitch: -75, tag: "top_minus120" },
      { h: box.top - 170, pitch: -85, tag: "top_minus170" },
    ];
    for (const s of shots) {
      await page.evaluate(
        (lon, lat, hh, pd) => window.__probe.view(lon, lat - 0.01, hh, pd),
        center.lon,
        center.lat,
        s.h,
        s.pitch,
      );
      await sleep(1500);
      const cam = await page.evaluate(() => {
        const f = window.__app.fluid;
        const st = f._stages[4];
        const c = window.__app.viewer.camera;
        const local = Cesium.Matrix4.multiplyByPoint(st._inverseModelMatrix, c.positionWC, new Cesium.Cartesian3());
        return { inside: st._insideBox, localY: +local.y.toFixed(3) };
      });
      await page.screenshot({ path: OUT + `inside3_${s.tag}.png` });
      console.log(`shot ${s.tag} cam inside=${cam.inside} localY=${cam.localY}`);
      report.inside[s.tag] = cam;
    }

    fs.writeFileSync(OUT + "probe_zh_inside.json", JSON.stringify(report, null, 2));
    console.log("LOGS:", JSON.stringify(logs.slice(0, 8)));
    console.log("done");
  } finally {
    await page.close().catch(() => {});
    browser.disconnect();
  }
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });