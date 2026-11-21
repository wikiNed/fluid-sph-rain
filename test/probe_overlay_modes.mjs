// 对比四种"贴地显示"写法，找出真正能显示半透明色块的那一种。
import puppeteer from "puppeteer-core";

const EXTENT = [103.978, 34.923, 104.016, 34.963];

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223" });
const page = await browser.newPage();
try {
  await page.setViewport({ width: 1200, height: 800 });
  await page.goto("http://127.0.0.1:8931/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__app && window.__app.ready === true", { timeout: 120000 });

  const info = await page.evaluate(async (ext) => {
    const v = window.__app.viewer;
    const [w, s, e, n] = ext;
    const dx = e - w;
    const dy = n - s;
    const rect = (u0, v0, u1, v1) =>
      Cesium.Cartesian3.fromDegreesArray([
        w + dx * u0, s + dy * v0,
        w + dx * u1, s + dy * v0,
        w + dx * u1, s + dy * v1,
        w + dx * u0, s + dy * v1,
      ]);

    const quad = (u0, v0, u1, v1) =>
      Cesium.PolygonGeometry.fromPositions({
        positions: rect(u0, v0, u1, v1),
        vertexFormat: Cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT,
      });

    const results = [];

    // A：entity + CLAMP_TO_GROUND + 颜色
    const a = v.entities.add({
      polygon: {
        hierarchy: rect(0.05, 0.62, 0.2, 0.75),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        material: Cesium.Color.RED.withAlpha(0.75),
      },
    });
    results.push({ k: "A_entity_clamp_color", ok: !!a });

    // B：entity + CLAMP_TO_GROUND + classificationType BOTH
    const b = v.entities.add({
      polygon: {
        hierarchy: rect(0.25, 0.62, 0.4, 0.75),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        classificationType: Cesium.ClassificationType.BOTH,
        material: Cesium.Color.BLUE.withAlpha(0.75),
      },
    });
    results.push({ k: "B_entity_clamp_both", ok: !!b });

    // C：GroundPrimitive + PerInstanceColor（半透明）
    try {
      v.scene.primitives.add(
        new Cesium.GroundPrimitive({
          geometryInstances: new Cesium.GeometryInstance({
            geometry: quad(0.45, 0.62, 0.6, 0.75),
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.YELLOW.withAlpha(0.8)) },
          }),
          appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: false }),
        }),
      );
      results.push({ k: "C_ground_primitive_color", ok: true });
    } catch (err) {
      results.push({ k: "C_ground_primitive_color", ok: false, err: String(err).slice(0, 120) });
    }

    // D：GroundPrimitive + MaterialAppearance（自发光材质）
    try {
      const mat = new Cesium.Material({
        fabric: {
          type: "ProbeD",
          uniforms: {},
          source: `
            czm_material czm_getMaterial(czm_materialInput materialInput) {
              czm_material m = czm_getDefaultMaterial(materialInput);
              m.emission = vec3(0.1, 1.0, 0.15);
              m.alpha = 0.85;
              return m;
            }`,
        },
      });
      v.scene.primitives.add(
        new Cesium.GroundPrimitive({
          geometryInstances: new Cesium.GeometryInstance({
            geometry: Cesium.PolygonGeometry.fromPositions({
              positions: rect(0.65, 0.62, 0.8, 0.75),
              vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
            }),
          }),
          appearance: new Cesium.MaterialAppearance({
            material: mat,
            translucent: true,
            flat: true,
          }),
        }),
      );
      results.push({ k: "D_ground_primitive_material", ok: true });
    } catch (err) {
      results.push({ k: "D_ground_primitive_material", ok: false, err: String(err).slice(0, 160) });
    }

    const cam = v.camera;
    cam.cancelFlight?.();
    let ground = 3000;
    try {
      const c = await Cesium.sampleTerrainMostDetailed(v.terrainProvider, [
        Cesium.Cartographic.fromDegrees(w + dx * 0.4, s + dy * 0.6),
      ]);
      if (Number.isFinite(c[0]?.height)) ground = c[0].height;
    } catch (err) { /* ignore */ }
    cam.setView({
      destination: Cesium.Cartesian3.fromDegrees(w + dx * 0.4, s + dy * 0.35, ground + 2200),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 },
    });
    v.scene.fog.enabled = false;
    await new Promise((r) => setTimeout(r, 6000));
    return { ground, results, entities: v.entities.values.length };
  }, EXTENT);

  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: "test/probe_overlay_modes.png" });
  console.log("MODES:", JSON.stringify(info));
} finally {
  await page.close();
  await browser.disconnect();
}