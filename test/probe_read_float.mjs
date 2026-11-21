// 关键验证：能不能把浮点水面纹理读回 CPU（若能，就能用真网格贴地渲染水）。
import puppeteer from "puppeteer-core";

const EXTENT = [103.978, 34.923, 104.016, 34.963];
const DOMAIN_UV = [[0.1, 0.07], [0.93, 0.1], [0.96, 0.56], [0.79, 0.93], [0.3, 0.96], [0.06, 0.6]];
const RAIN_UV = [[0.3, 0.62], [0.72, 0.6], [0.66, 0.92], [0.34, 0.94]];

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223" });
const page = await browser.newPage();
try {
  await page.setViewport({ width: 900, height: 600 });
  await page.goto("http://127.0.0.1:8931/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__app && window.__app.ready === true", { timeout: 120000 });

  await page.evaluate(
    async (ext, domUv, rainUv) => {
      const app = window.__app;
      const mk = (uv) => uv.map(([u, v]) => [ext[0] + (ext[2] - ext[0]) * u, ext[1] + (ext[3] - ext[1]) * v]);
      app.commitGlobeDomain(ext, domUv.map(([u, v]) => [u, v]));
      for (let i = 0; i < 120 && !app.fluid; i += 1) await new Promise((r) => setTimeout(r, 500));
      app.commitRegionUV(rainUv);
      app.setRainfall(60, 30, "amount");
      app.setRainEnabled(true);
    },
    EXTENT, DOMAIN_UV, RAIN_UV,
  );

  await new Promise((r) => setTimeout(r, 8000));

  const out = await page.evaluate(() => {
    const app = window.__app;
    const tex = app.fluid._simTextures[2];
    const gl = app.viewer.scene.context._gl;
    const w = 512;
    const h = 512;
    const res = {};

    const fb = new Cesium.Framebuffer({
      context: app.viewer.scene.context,
      colorTextures: [tex],
      destroyAttachments: false,
    });

    for (const [name, readFn] of [
      ["float", () => {
        const arr = new Float32Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, arr);
        return arr;
      }],
      ["uint8", () => {
        const arr = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, arr);
        return arr;
      }],
    ]) {
      try {
        const arr = readFn();
        const err = gl.getError();
        let nz = 0;
        let max = 0;
        for (let i = 0; i < Math.min(arr.length, 512 * 512 * 4); i += 4) {
          if (arr[i] > 0) nz += 1;
          if (arr[i] > max) max = arr[i];
        }
        res[name] = { err, nonzero: nz, max, len: arr.length, head: Array.from(arr.slice(0, 4)) };
      } catch (e) {
        res[name] = { error: String(e).slice(0, 160) };
      }
    }
    res.texInfo = {
      w: tex.width, h: tex.height,
      format: tex.pixelFormat && tex.pixelFormat.webglFormat,
      dtype: tex.pixelDatatype && tex.pixelDatatype.webglDatatype,
    };
    return res;
  });

  console.log("READ:", JSON.stringify(out));
} finally {
  await page.close();
  await browser.disconnect();
}