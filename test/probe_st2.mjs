// 用 GroundPrimitive + TEXTURED 顶点格式，验证 materialInput.st 是否能覆盖整个多边形。
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
    const positions = Cesium.Cartesian3.fromDegreesArray([w, s, e, s, e, n, w, n]);

    const stMat = new Cesium.Material({
      fabric: {
        type: "ProbeST2",
        uniforms: {},
        source: `
          czm_material czm_getMaterial(czm_materialInput materialInput) {
            czm_material m = czm_getDefaultMaterial(materialInput);
            m.emission = vec3(materialInput.st.x, materialInput.st.y, 0.2);
            m.alpha = 0.9;
            return m;
          }`,
      },
    });

    const geometry = new Cesium.PolygonGeometry({
      polygonHierarchy: new Cesium.PolygonHierarchy(positions),
      vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
      stRotation: 0,
    });

    v.scene.primitives.add(
      new Cesium.GroundPrimitive({
        geometryInstances: new Cesium.GeometryInstance({ geometry }),
        appearance: new Cesium.MaterialAppearance({
          material: stMat,
          translucent: true,
          flat: true,
        }),
      }),
    );

    const cam = v.camera;
    cam.cancelFlight?.();
    let ground = 3000;
    try {
      const c = await Cesium.sampleTerrainMostDetailed(v.terrainProvider, [
        Cesium.Cartographic.fromDegrees((w + e) / 2, (s + n) / 2),
      ]);
      if (Number.isFinite(c[0]?.height)) ground = c[0].height;
    } catch (err) { /* ignore */ }
    cam.setView({
      destination: Cesium.Cartesian3.fromDegrees((w + e) / 2, s + (n - s) * 0.12, ground + 2400),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-50), roll: 0 },
    });
    v.scene.fog.enabled = false;
    await new Promise((r) => setTimeout(r, 6000));
    return { ground };
  }, EXTENT);

  await page.screenshot({ path: "test/probe_st2.png" });
  console.log("ST2:", JSON.stringify(info));
} finally {
  await page.close();
  await browser.disconnect();
}