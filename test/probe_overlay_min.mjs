// 验证「贴地多边形 + 自定义材质」在真实地形上的表现（相机按离地高度取，不埋进山里）。
import puppeteer from "puppeteer-core";

const EXTENT = [103.978, 34.923, 104.016, 34.963];
const CENTER = [(EXTENT[0] + EXTENT[2]) / 2, (EXTENT[1] + EXTENT[3]) / 2];

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223" });
const page = await browser.newPage();
try {
  await page.setViewport({ width: 1200, height: 800 });
  await page.goto("http://127.0.0.1:8931/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__app && window.__app.ready === true", { timeout: 120000 });

  const info = await page.evaluate(async (ext) => {
    const v = window.__app.viewer;
    const [w, s, e, n] = ext;
    const ring = (a, b, c, d) => Cesium.Cartesian3.fromDegreesArray([a, b, c, b, c, d, a, d]);

    // 半透明纯色
    v.entities.add({
      polygon: {
        hierarchy: ring(w + 0.004, s + 0.004, w + 0.011, s + 0.011),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        material: Cesium.Color.RED.withAlpha(0.65),
      },
    });
    // 自定义材质：金色，半透明
    const gold = new Cesium.Material({
      fabric: {
        type: "ProbeGold",
        uniforms: {},
        source: `
          czm_material czm_getMaterial(czm_materialInput materialInput) {
            czm_material m = czm_getDefaultMaterial(materialInput);
            m.emission = vec3(1.0, 0.75, 0.1);
            m.alpha = 0.75;
            return m;
          }`,
      },
    });
    v.entities.add({
      polygon: {
        hierarchy: ring(e - 0.011, n - 0.011, e - 0.004, n - 0.004),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        material: gold,
      },
    });

    const cam = v.camera;
    cam.cancelFlight?.();
    var ground = 3000;
    try {
      const carto = await Cesium.sampleTerrainMostDetailed(v.terrainProvider, [
        Cesium.Cartographic.fromDegrees((w + e) / 2, (s + n) / 2),
      ]);
      if (Number.isFinite(carto[0]?.height)) ground = carto[0].height;
    } catch (err) {
      /* 忽略：拿不到地形就用默认高度 */
    }
    cam.setView({
      destination: Cesium.Cartesian3.fromDegrees((w + e) / 2, s + 0.008, ground + 1400),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-50), roll: 0 },
    });
    v.scene.fog.enabled = false;
    await new Promise((r) => setTimeout(r, 6000));
    return { ground, imagery: v.imageryLayers.length, entities: v.entities.values.length };
  }, EXTENT);

  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: `test/probe_overlay_min_${Date.now()}.png` });
  console.log("MIN:", JSON.stringify(info));
  console.log("SHOT: test/probe_overlay_min_<ts>.png (latest in dir)");
} finally {
  await page.close();
  await browser.disconnect();
}