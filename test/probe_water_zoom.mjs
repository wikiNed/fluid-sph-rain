/**
 * 诊断：相机越靠近地面，水体是否还能被体积渲染阶段绘出（真 GPU CDP :9223）。
 *
 * 做法：先在全球地形上划域 + 雨区并降雨一段时间，等 surfaceTexture 里确实有水量；
 * 然后在不同相机高度分别「关体积阶段 / 开体积阶段」各取一帧画布像素，
 * 统计两者的差异比例 = 体积阶段对该画面的贡献。
 *
 * 用法：node test/probe_water_zoom.mjs
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
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction("window.__app && __app.ready === true", { timeout: 90000 });
  console.log("ready");

  // 页面内工具：在 postRender 回调里读默认帧缓冲，返回统计量
  await page.evaluate(() => {
    window.__probe = {
      readFrame() {
        return new Promise((resolve) => {
          const scene = __app.viewer.scene;
          const remove = scene.postRender.addEventListener(() => {
            const gl = scene.context._gl;
            const w = gl.drawingBufferWidth;
            const h = gl.drawingBufferHeight;
            const px = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
            remove();
            resolve({ w, h, px: Array.from(px) });
          });
        });
      },
      analyze(a, b) {
        // a/b 是同一机位、体积阶段开/关的两帧
        const { w, h } = a;
        let changed = 0;
        let blue = 0;
        let blueInB = 0;
        for (let i = 0; i < a.px.length; i += 4) {
          const dr = Math.abs(a.px[i] - b.px[i]);
          const dg = Math.abs(a.px[i + 1] - b.px[i + 1]);
          const db = Math.abs(a.px[i + 2] - b.px[i + 2]);
          if (dr + dg + db > 24) changed++;
          const r = b.px[i], g = b.px[i + 1], bl = b.px[i + 2];
          if (bl > r + 20 && bl > g + 8) blue++;
          const r2 = a.px[i], g2 = a.px[i + 1], bl2 = a.px[i + 2];
          if (bl2 > r2 + 20 && bl2 > g2 + 8) blueInB++;
        }
        return {
          w, h,
          diffPct: +(100 * changed / (w * h)).toFixed(2),
          blueOnPct: +(100 * blueInB / (w * h)).toFixed(2),
          blueOffPct: +(100 * blue / (w * h)).toFixed(2),
        };
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
  await sleep(20000);
  const st = await page.evaluate(() => ({
    injected: __app.injectedAmount ? __app.injectedAmount() : null,
    stages: (__app.fluid?._stages || []).map((s, i) => i + ":" + (s.name || s.constructor.name)),
    thickness: __app.volumeThickness ? __app.volumeThickness() : null,
    tex: window.__probe ? undefined : undefined,
  }));
  console.log("state:", JSON.stringify(st));

  // surfaceTexture 里水量确认（回读 data.x 均值）
  const tex = await page.evaluate(async () => {
    const f = __app.fluid;
    const tex = f._simTextures[2];
    const context = __app.viewer.scene.context;
    const fb = new Cesium.Framebuffer({ context, colorTextures: [tex], destroyAttachments: false });
    const w = tex.width, h = tex.height;
    const px = context.readPixels({ framebuffer: fb, x: 0, y: 0, width: w, height: h });
    fb.destroy();
    let sum = 0, wet = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 0.002) { wet++; sum += px[i]; }
    }
    return { wetPct: +(100 * wet / (w * h)).toFixed(1), meanX: +(sum / Math.max(wet, 1)).toFixed(4) };
  });
  console.log("surfaceTexture:", JSON.stringify(tex));

  // 2. 不同相机高度的体积阶段贡献
  const view = await page.evaluate(() => ({ extent: __app.extent }));
  const [w0, s0, e0, n0] = view.extent;
  const lon = (w0 + e0) / 2;
  const lat = (s0 + n0) / 2;

  const heights = [8000, 4000, 2000, 1000, 500, 250, 120];
  const results = [];
  for (const hgt of heights) {
    await page.evaluate(
      (lon, lat, hgt) => {
        __app.viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat - 0.022, hgt),
          orientation: { heading: 0, pitch: Cesium.Math.toRadians(-32), roll: 0 },
        });
      },
      lon, lat, hgt
    );
    await sleep(900);
    // 关体积阶段
    await page.evaluate(() => { __app.fluid._stages[4].show = false; });
    await sleep(400);
    const off = await page.evaluate(() => __probe.readFrame());
    // 开体积阶段
    await page.evaluate(() => { __app.fluid._stages[4].show = true; });
    await sleep(400);
    const on = await page.evaluate(() => __probe.readFrame());
    const m = await page.evaluate((a, b) => __probe.analyze(a, b), on, off);
    results.push({ hgt, ...m });
    console.log(
      `h=${hgt}m  diffPct=${m.diffPct}%  blueOn=${m.blueOnPct}%  blueOff=${m.blueOffPct}%`
    );
    if ([2000, 500, 120].includes(hgt)) {
      await page.screenshot({ path: OUT + `zoom_on_h${hgt}.png` });
      await page.evaluate(() => { __app.fluid._stages[4].show = false; });
      await sleep(300);
      await page.screenshot({ path: OUT + `zoom_off_h${hgt}.png` });
      await page.evaluate(() => { __app.fluid._stages[4].show = true; });
    }
  }

  fs.writeFileSync(OUT + "zoom_report.json", JSON.stringify({ state: st, tex, results }, null, 2));
  console.log("done");
  await page.close();
  browser.disconnect();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});