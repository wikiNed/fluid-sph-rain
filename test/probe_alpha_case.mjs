/**
 * 诊断：案例复演时「水透明度=0 水体仍透明」到底是水没画出来，还是被降雨区填充挡在中间。
 * 输出：alpha=0 / alpha=1 / 关体积阶段 三张抓帧两两差分 + uniform 实际取值 + 当前区域实体。
 */
import puppeteer from "puppeteer-core";

const CDP = "http://127.0.0.1:9223";
const PAGE = "http://127.0.0.1:8931/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null, protocolTimeout: 300000 });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));

try {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 120000 });
  await page.evaluate(() => {
    window.__probe = {
      snap() {
        const scene = window.__app.viewer.scene;
        const gl = scene.context._gl;
        return new Promise((resolve) => {
          const remove = scene.postRender.addEventListener(() => {
            remove();
            const w = gl.drawingBufferWidth;
            const h = gl.drawingBufferHeight;
            const buf = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
            resolve({ w, h, buf: Array.from(buf) });
          });
        });
      },
      diff(a, b, thr = 8) {
        let n = 0;
        for (let i = 0; i < Math.min(a.buf.length, b.buf.length); i += 4) {
          if (
            Math.abs(a.buf[i] - b.buf[i]) > thr ||
            Math.abs(a.buf[i + 1] - b.buf[i + 1]) > thr ||
            Math.abs(a.buf[i + 2] - b.buf[i + 2]) > thr
          )
            n++;
        }
        return +((100 * n) / (a.w * a.h)).toFixed(2);
      },
    };
  });

  await page.evaluate(() => window.__app.runCase("longcaogou-50"));
  await page.waitForFunction(() => !!window.__app.fluid, { timeout: 120000 });
  await sleep(20000);

  const st = await page.evaluate(() => {
    const f = window.__app.fluid;
    return {
      alpha: window.__app.options.waterAlpha,
      stageShow: f._stages[4].show,
      uniformAlpha: f._stages[4]._uniformMap?.waterAlpha?.(),
      wet: window.__app.rainfallConfig().stats,
      areas: window.__app.areas(),
      entities: window.__app.viewer.entities.values
        .filter((e) => e.polygon)
        .map((e) => ({
          mat: e.polygon.material?.color?.getValue?.()?.toCssColorString?.(),
          alpha: e.polygon.material?.color?.getValue?.()?.alpha,
          show: e.polygon.show,
          rect: e.polygon.hierarchy?.getValue?.()?.positions?.length,
        })),
    };
  });
  console.log("STATE", JSON.stringify(st));

  // 冻结计算 + 停雨滴
  await page.evaluate(() => {
    window.__app.setRainEnabled(false);
    window.__app.setRainFx(false);
    const s = window.__app.fluid._stages;
    for (let i = 0; i < 4; i++) s[i].show = false;
  });
  await sleep(1200);

  await page.evaluate(() => { window.__app.options.waterAlpha = 0; });
  await sleep(500);
  const frame0 = await page.evaluate(() => window.__probe.snap());
  await page.evaluate(() => { window.__app.options.waterAlpha = 1; });
  await sleep(500);
  const frame1 = await page.evaluate(() => window.__probe.snap());
  const frameOff = await page.evaluate(async () => {
    window.__app.fluid._stages[4].show = false;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return window.__probe.snap();
  });

  const d01 = await page.evaluate((a, b) => window.__probe.diff(a, b), frame0, frame1);
  const d0off = await page.evaluate((a, b) => window.__probe.diff(a, b), frame0, frameOff);
  const d1off = await page.evaluate((a, b) => window.__probe.diff(a, b), frame1, frameOff);
  const d0offLow = await page.evaluate((a, b) => window.__probe.diff(a, b, 3), frame0, frameOff);
  console.log("DIFF alpha0-vs-alpha1=", d01, "alpha0-vs-off=", d0off, "alpha1-vs-off=", d1off, "alpha0-vs-off(low)=", d0offLow);
  console.log("UNIFORM after set1:", await page.evaluate(() => window.__app.fluid._stages[4]._uniformMap?.waterAlpha?.()));
} finally {
  try { await page.close(); } catch {}
  try { browser.disconnect(); } catch {}
  process.exit(0);
}