// 探测：SPH 水面纹理中的实际水深分布（用于标定 5 档水深着色的阈值）
// 读数方式：把 surfaceTexture 挂到临时 Framebuffer 上 context.readPixels 回读 data.x。
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9222",
  defaultViewport: null,
  protocolTimeout: 240000,
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
await page.goto("http://127.0.0.1:8931/index.html?depthprobe=" + Date.now(), {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 60000 });

const setup = await page.evaluate(async () => {
  const app = window.__app;
  app.options.globeSampleGrid = 32;
  app.options.rainIntensity = 0.0004;
  const dom = await app.commitGlobeDomain([-119.55, 37.737, -119.466, 37.804]);
  const reg = app.commitTestRegion(0.3, 0.3);
  app.options.rainEnabled = true;
  window.__depthStats = () => {
    const ctx = app.viewer.scene.context;
    const tex = app.fluid._simTextures[2];
    // destroyAttachments 默认 true：会把 colorTextures 一起销毁，必须显式关掉
    const fb = new Cesium.Framebuffer({
      context: ctx,
      colorTextures: [tex],
      destroyAttachments: false,
    });
    const w = tex.width,
      h = tex.height;
    const buf = ctx.readPixels({
      framebuffer: fb,
      x: 0,
      y: 0,
      width: w,
      height: h,
    });
    fb.destroy();
    const thick = app.fluid._volumeThickness;
    const vals = [];
    for (let i = 0; i < w * h; i += 1) {
      const x = buf[i * 4];
      if (x > 1e-5) vals.push(x * 0.25 * thick);
    }
    vals.sort((a, b) => a - b);
    const q = (p) =>
      vals.length
        ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))]
        : 0;
    return {
      cells: vals.length,
      thick: Math.round(thick),
      p50: +q(0.5).toFixed(2),
      p90: +q(0.9).toFixed(2),
      p99: +q(0.99).toFixed(2),
      max: +(vals[vals.length - 1] ?? 0).toFixed(2),
    };
  };
  return { dom, reg, injected: app.injectedAmount() };
});
console.log("SETUP:", JSON.stringify(setup));

const marks = [2, 5, 10, 20, 35];
let prev = 0;
for (const t of marks) {
  await new Promise((r) => setTimeout(r, (t - prev) * 1000));
  prev = t;
  const s = await page.evaluate(() => window.__depthStats());
  console.log(`t=${t}s`, JSON.stringify(s));
}

await page.close();
await browser.disconnect();