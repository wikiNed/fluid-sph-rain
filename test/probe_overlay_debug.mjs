// 调试：贴地多边形到底能不能用自定义材质、能不能半透明。
import puppeteer from "puppeteer-core";

const EXTENT = [103.978, 34.923, 104.016, 34.963];

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223" });
const page = await browser.newPage();
try {
  await page.setViewport({ width: 900, height: 600 });
  await page.goto("http://127.0.0.1:8931/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__app && window.__app.ready === true", { timeout: 90000 });

  const info = await page.evaluate((ext) => {
    const v = window.__app.viewer;
    const [w, s, e, n] = ext;
    const mk = (west, south, east, north) =>
      Cesium.Cartesian3.fromDegreesArray([west, south, east, south, east, north, west, north]);

    // A：纯色半透明（官方最常规用法）
    v.entities.add({
      polygon: {
        hierarchy: mk(w + 0.004, s + 0.004, w + 0.014, s + 0.014),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        material: Cesium.Color.RED.withAlpha(0.5),
      },
    });

    // B：自定义材质（恒定绿色 + alpha 0.5）
    const mat = new Cesium.Material({
      fabric: {
        type: "ProbeGreen",
        uniforms: { tint: new Cesium.Cartesian3(0, 1, 0), alpha: 1.0 },
        source: `
          uniform vec3 tint;
          uniform float alpha;
          czm_material czm_getMaterial(czm_materialInput materialInput) {
            czm_material m = czm_getDefaultMaterial(materialInput);
            m.diffuse = tint;
            m.alpha = 0.5 * alpha;
            return m;
          }
        `,
      },
    });
    v.entities.add({
      polygon: {
        hierarchy: mk(e - 0.014, n - 0.014, e - 0.004, n - 0.004),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        material: mat,
      },
    });

    const cam = v.camera;
    cam.cancelFlight?.();
    cam.setView({
      destination: Cesium.Cartesian3.fromDegrees((w + e) / 2, (s + n) / 2, 12000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-75), roll: 0 },
    });
    return { ok: true };
  }, EXTENT);

  await new Promise((r) => setTimeout(r, 4000));
  await page.screenshot({ path: "test/probe_overlay_debug.png" });
  console.log("PROBE:", JSON.stringify(info));
} finally {
  await page.close();
  await browser.disconnect();
}