// 判断 GroundPrimitive/entity 多边形里的 materialInput.st 是否真实可用：
// 把 st 直接当颜色输出（红=st.x 绿=st.y），有渐变说明可用，纯色说明被压成常量。
import puppeteer from "puppeteer-core";

const EXTENT = [103.978, 34.923, 104.016, 34.963];

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223" });
const page = await browser.newPage();
try {
  await page.setViewport({ width: 1000, height: 700 });
  await page.goto("http://127.0.0.1:8931/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__app && window.__app.ready === true", { timeout: 120000 });

  const info = await page.evaluate(async (ext) => {
    const v = window.__app.viewer;
    const [w, s, e, n] = ext;
    const dx = e - w;
    const dy = n - s;
    const ring = (u0, v0, u1, v1) =>
      Cesium.Cartesian3.fromDegreesArray([
        w + dx * u0, s + dy * v0,
        w + dx * u1, s + dy * v0,
        w + dx * u1, s + dy * v1,
        w + dx * u0, s + dy * v1,
      ]);

    const stMat = new Cesium.Material({
      fabric: {
        type: "ProbeST",
        uniforms: {},
        source: `
          czm_material czm_getMaterial(czm_materialInput materialInput) {
            czm_material m = czm_getDefaultMaterial(materialInput);
            m.emission = vec3(materialInput.st.x, materialInput.st.y, 0.2);
            m.alpha = 1.0;
            return m;
          }`,
      },
    });

    v.entities.add({
      polygon: {
        hierarchy: ring(0.2, 0.3, 0.8, 0.8),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        material: stMat,
      },
    });

    const cam = v.camera;
    cam.cancelFlight?.();
    let ground = 3000;
    try {
      const c = await Cesium.sampleTerrainMostDetailed(v.terrainProvider, [
        Cesium.Cartographic.fromDegrees(w + dx / 2, s + dy / 2),
      ]);
      if (Number.isFinite(c[0]?.height)) ground = c[0].height;
    } catch (err) { /* ignore */ }
    cam.setView({
      destination: Cesium.Cartesian3.fromDegrees(w + dx / 2, s + dy * 0.12, ground + 2200),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 },
    });
    v.scene.fog.enabled = false;
    await new Promise((r) => setTimeout(r, 6000));
    return { ground };
  }, EXTENT);

  await page.screenshot({ path: "test/probe_st.png" });
  console.log("ST:", JSON.stringify(info));
} finally {
  await page.close();
  await browser.disconnect();
}