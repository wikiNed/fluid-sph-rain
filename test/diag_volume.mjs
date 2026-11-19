// 诊断：体积渲染是否在画面上产生像素贡献（red/blue 统计 + 关闭体积阶段对比）
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
await page.setViewport({ width: 1000, height: 700 });
const logs = [];
page.on("console", (m) => {
  const t = m.text();
  if (/shader|Invalid|Uncaught|error/i.test(t)) logs.push(`${m.type()}: ${t.slice(0, 300)}`);
});
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${String(e.message).slice(0, 300)}`));

await page.goto("http://127.0.0.1:8931/index.html?diag=" + Date.now(), {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });

const EXT = [-119.5509508318, 37.7379837881, -119.4661638949, 37.8045600379];
await page.evaluate(async (ext) => await window.__app.commitGlobeDomain(ext), EXT);
await page.evaluate(() => window.__app.commitTestRegion(0.2, 0.2));
const thickness = await page.evaluate(() => window.__app.volumeThickness());
await page.evaluate((ext, thickness) => {
  const lon = (ext[0] + ext[2]) / 2;
  const lat = (ext[1] + ext[3]) / 2;
  window.__app.viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat - 0.0001, thickness + 4500),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
  });
}, EXT, thickness);

await page.evaluate(() => {
  window.__app.options.rainEnabled = true;
});
await new Promise((r) => setTimeout(r, 15000));

const stats = await page.evaluate(() => {
  const v = window.__app.viewer;
  const gl = v.scene.context._gl;
  const w = v.canvas.width;
  const h = v.canvas.height;
  const read = () => {
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let red = 0, blue = 0, total = w * h, rSum = 0, gSum = 0, bSum = 0;
    for (let i = 0; i < total; i++) {
      const r = buf[i * 4], g = buf[i * 4 + 1], b = buf[i * 4 + 2];
      rSum += r; gSum += g; bSum += b;
      if (r > 110 && r > g + 40 && r > b + 40) red++;
      if (b > 90 && b > r + 30) blue++;
    }
    return {
      redPct: +((red / total) * 100).toFixed(2),
      bluePct: +((blue / total) * 100).toFixed(2),
      avg: [Math.round(rSum / total), Math.round(gSum / total), Math.round(bSum / total)],
    };
  };
  const withVolume = (() => {
    v.render();
    return read();
  })();
  const stage = window.__app.fluid._stages[4];
  const wasShow = stage.show;
  stage.show = false;
  v.render();
  const withoutVolume = read();
  stage.show = wasShow;
  v.render();
  // 统计 surfaceTexture 的非零格占比与最大水高
  const tex = window.__app.fluid._simTextures[2];
  const fb = new Cesium.Framebuffer({ context: v.scene.context, colorTextures: [tex], destroyAttachments: false });
  const px = v.scene.context.readPixels({ framebuffer: fb, x: 0, y: 0, width: tex.width, height: tex.height });
  fb.destroy();
  let nz = 0, maxx = 0;
  for (let i = 0; i < tex.width * tex.height; i++) {
    if (px[i * 4] > 0.001) nz++;
    if (px[i * 4] > maxx) maxx = px[i * 4];
  }
  return {
    withVolume,
    withoutVolume,
    stageShow: wasShow,
    volumePixelsChangedPct: +(
      (Math.abs(withVolume.avg[0] - withoutVolume.avg[0]) +
        Math.abs(withVolume.avg[1] - withoutVolume.avg[1]) +
        Math.abs(withVolume.avg[2] - withoutVolume.avg[2])) / 3
    ).toFixed(2),
    texNonZeroPct: +((nz / (tex.width * tex.height)) * 100).toFixed(1),
    texMaxX: +maxx.toFixed(3),
  };
});
console.log("STATS:", JSON.stringify(stats, null, 1));
await page.screenshot({ path: "test/diag_volume.png" });
console.log("LOGS:", JSON.stringify(logs.slice(0, 6)));
await page.close();
await browser.disconnect();