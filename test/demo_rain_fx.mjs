// 出图 + 像素差分证据：雨滴下落效果（雨滴开/关对比）
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9223",
  defaultViewport: null,
  protocolTimeout: 300000,
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
const logs = [];
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${String(e.message).slice(0, 200)}`));
page.on("console", (m) => {
  if (/shader|Invalid|Uncaught/i.test(m.text())) logs.push(m.type() + ": " + m.text().slice(0, 160));
});

await page.goto("http://127.0.0.1:8931/index.html?rainfx=" + Date.now(), {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });

await page.evaluate(async () =>
  window.__app.commitGlobeDomain(
    [-119.55, 37.74, -119.47, 37.8],
    [
      [0.1, 0.1],
      [0.9, 0.12],
      [0.92, 0.88],
      [0.1, 0.9],
    ],
  ),
);
await page.waitForFunction(() => !!window.__app?.fluid, { timeout: 90000 });

await page.evaluate(() => {
  window.__app.commitRegionUV([
    [0.35, 0.3],
    [0.65, 0.3],
    [0.65, 0.62],
    [0.35, 0.62],
  ]);
  window.__app.options.rainEnabled = true;
  window.__app.options.rainIntensity = 0.0004;
});

const view = (lon, lat, height, pitchDeg) =>
  page.evaluate(
    ([lon, lat, height, pitchDeg]) => {
      const cam = window.__app.viewer.camera;
      cam.cancelFlight();
      cam.setView({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
        orientation: { heading: Cesium.Math.toRadians(0), pitch: Cesium.Math.toRadians(pitchDeg), roll: 0 },
      });
    },
    [lon, lat, height, pitchDeg],
  );

const center = await page.evaluate(() => {
  const e = window.__app.domain.extent;
  return { lon: (e[0] + e[2]) / 2, lat: (e[1] + e[3]) / 2 };
});

// 低机位看山坡（雨丝在深色背景上最明显）
await view(center.lon, center.lat - 0.045, 1600, -22);
await new Promise((r) => setTimeout(r, 3000));

// 逐帧差分：雨滴效果开 vs 关（同一机位连续两帧）
const diffExpr = () =>
  page.evaluate(async () => {
    const app = window.__app;
    const scene = app.viewer.scene;
    const gl = scene.context._gl;
    const W = scene.canvas.width, H = scene.canvas.height;
    const read = () => {
      const buf = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    };
    const grab = () =>
      new Promise((res) => {
        const cb = () => {
          scene.postRender.removeEventListener(cb);
          res(read());
        };
        scene.postRender.addEventListener(cb);
        scene.requestRender();
        setTimeout(() => {
          scene.postRender.removeEventListener(cb);
          res(read());
        }, 2500);
      });
    const fx = app.rainFxInfo();
    // 雨强调到接近 0，避免两次采样之间水量变化干扰差分
    const keepIntensity = app.options.rainIntensity;
    app.options.rainIntensity = 0.00002;
    app.options.rainFx = true;
    await new Promise((r) => setTimeout(r, 800));
    const a = await grab();
    app.options.rainFx = false;
    await new Promise((r) => setTimeout(r, 800));
    const b = await grab();
    app.options.rainFx = true;
    app.options.rainIntensity = keepIntensity;
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d > 12) diff++;
    }
    return { fx, diffPct: +((diff / (W * H)) * 100).toFixed(2) };
  });

const d = await diffExpr();
console.log("RAINFX DIFF:", JSON.stringify(d));

await page.evaluate(() => {
  window.__app.options.rainEnabled = true;
  window.__app.options.rainFx = true;
  for (const e of window.__app.viewer.entities.values) if (e.label) e.label.show = false;
});
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: "test/rainfx_on.png" });

await page.evaluate(() => {
  window.__app.options.rainFx = false;
});
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: "test/rainfx_off.png" });

console.log("LOGS:", JSON.stringify(logs.slice(0, 6)));
await page.close();
await browser.disconnect();