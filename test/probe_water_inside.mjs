/**
 * 诊断 v3：盒内机位水体可见性（验证 FluidVolumeStage 的 insideBox 修复）。
 * 真 GPU CDP :9223。
 *
 * 与 v2 的区别：
 *  - 不用 sampleTerrainMostDetailed（ArcGIS provider 无 computeMaximumLevelAtPosition 会抛错），
 *    改为用 viewer.scene.globe.getHeight() 取地面（需要瓦片已加载）。
 *  - 先确认体积盒厚度正常（>200m），否则等待并重新提交域。
 *  - 固定经度、不同椭球高度扫一遍，检查 diffPct 在盒顶以下是否不再归零。
 *  - 用 requestAnimationFrame 统计盒内帧率。
 *
 * 用法：node test/probe_water_inside.mjs
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const BASE = "http://127.0.0.1:8931/";
const CDP = "http://127.0.0.1:9223";
const OUT = new URL("./", import.meta.url).pathname.replace(/^\//, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXT = [-119.55, 37.74, -119.47, 37.8];
const POLY = [
  [0.1, 0.1],
  [0.9, 0.12],
  [0.92, 0.88],
  [0.1, 0.9],
];

async function main() {
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null, protocolTimeout: 300000 });
  // 关闭遗留页面，避免多个标签页同时跑模拟拖垮 GPU
  for (const p of await browser.pages()) {
    if (p.url() !== "about:blank") {
      try { await p.close(); } catch {}
    }
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 850 });
  const logs = [];
  page.on("pageerror", (e) => logs.push("PAGEERROR: " + String(e.message).slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "error") logs.push("CONSOLE: " + m.text().slice(0, 200));
  });

  try {
    await page.goto(BASE + "index.html?inside=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });
    console.log("ready");

    // 等全球地形瓦片就绪（否则域高程采样可能退化成极小范围）
    await page
      .waitForFunction(() => window.__app.viewer.scene.globe.tilesLoaded === true, { timeout: 30000 })
      .catch(() => console.log("tilesLoaded timeout (continue)"));

    const commit = async (tag) => {
      const r = await page.evaluate(
        (ext, poly) => window.__app.commitGlobeDomain(ext, poly),
        EXT,
        POLY,
      );
      const box = await page.evaluate(() => {
        const f = window.__app.fluid;
        return f
          ? {
              thickness: f._volumeThickness,
              center: f._volumeCenterElevation,
              top: f._volumeCenterElevation + f._volumeThickness / 2,
              bottom: f._volumeCenterElevation - f._volumeThickness / 2,
            }
          : null;
      });
      console.log(tag, JSON.stringify({ ...r, box }));
      return box;
    };

    let box = await commit("commit1");
    if (!box || !(box.thickness > 200)) {
      console.log("thickness too small, wait 4s and recommit");
      await sleep(4000);
      box = await commit("commit2");
    }
    if (!box || !(box.thickness > 200)) {
      console.log("STILL BAD thickness:", box && box.thickness, "-> abort");
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
            const d =
              Math.abs(on.px[i] - off.px[i]) +
              Math.abs(on.px[i + 1] - off.px[i + 1]) +
              Math.abs(on.px[i + 2] - off.px[i + 2]);
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
          const local = Cesium.Matrix4.multiplyByPoint(
            f._stages[4]._inverseModelMatrix,
            c.positionWC,
            new Cesium.Cartesian3(),
          );
          return {
            lon: +Cesium.Math.toDegrees(p.longitude).toFixed(5),
            lat: +Cesium.Math.toDegrees(p.latitude).toFixed(5),
            ellipsoidH: +p.height.toFixed(1),
            pitchDeg: +Cesium.Math.toDegrees(c.pitch).toFixed(1),
            inside: f._stages[4]._insideBox,
            local: { x: +local.x.toFixed(3), y: +local.y.toFixed(3), z: +local.z.toFixed(3) },
          };
        },
        groundAt(lon, lat) {
          const gv = window.__app.viewer.scene.globe;
          const h = gv.getHeight(Cesium.Cartographic.fromDegrees(lon, lat));
          return h === undefined ? null : h;
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

    // 降雨
    await page.evaluate(() => {
      window.__app.commitTestRegion(0.34, 0.34);
      window.__app.options.rainIntensity = 0.001;
      window.__app.options.rainEnabled = true;
    });
    await sleep(25000);
    const st = await page.evaluate(() => ({ injected: window.__app.injectedAmount() }));
    console.log("state:", JSON.stringify(st));

    const center = { lon: (EXT[0] + EXT[2]) / 2, lat: (EXT[1] + EXT[3]) / 2 - 0.01 };
    const ground = await page.evaluate(
      (lon, lat) => window.__probe.groundAt(lon, lat),
      center.lon,
      center.lat,
    );
    console.log("ground under camera:", ground);
    const baseH = ground ?? 2166;

    const heights = [6000, 4500, 3600, 3400, 3200, 3100, 2950, 2750, 2500, 2300];
    const results = [];
    for (const h of heights) {
      await page.evaluate(
        (lon, lat, h2) => window.__probe.setCam(lon, lat, h2, -25),
        center.lon,
        center.lat,
        h,
      );
      await sleep(1000);
      const cam = await page.evaluate(() => window.__probe.camInfo());
      await page.evaluate(() => { window.__app.fluid._stages[4].show = false; });
      await sleep(350);
      const off = await page.evaluate(() => window.__probe.readFrame());
      await page.evaluate(() => { window.__app.fluid._stages[4].show = true; });
      await sleep(350);
      const on = await page.evaluate(() => window.__probe.readFrame());
      const m = await page.evaluate((a, b) => window.__probe.analyze(a, b), on, off);
      results.push({ h, cam, ...m });
      console.log(
        `h=${h} rel=${(h - baseH).toFixed(0)}m inside=${cam.inside} local.z=${cam.local.z} diff=${m.diffPct}% blueOn=${m.blueOnPct}%`,
      );
      if ([3400, 3100, 2500, 2300].includes(h)) {
        await page.screenshot({ path: OUT + `inside_h${h}.png` });
      }
      if (h === 2500) {
        const fps = await page.evaluate(() => window.__probe.measureFps(2.5));
        console.log("fps inside(box):", fps);
      }
    }

    fs.writeFileSync(OUT + "probe_water_inside.json", JSON.stringify({ box, ground, baseH, results, logs }, null, 2));
    console.log("LOGS:", JSON.stringify(logs.slice(0, 5)));
    console.log("done");
  } finally {
    await page.close().catch(() => {});
    browser.disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});