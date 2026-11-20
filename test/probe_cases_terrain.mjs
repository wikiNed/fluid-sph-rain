/**
 * 案例地形校验探针（真 GPU CDP :9223）：
 *  - 逐个案例在 extent 内采 5×5 网格高程，确认高程跨度与河谷形态
 *  - 采样案例机位地面高程，按 AGL 摆放相机并截图 test/case_<id>.png
 *  - 输出 JSON：test/case_terrain.json
 *
 * 运行：node test/probe_cases_terrain.mjs
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const OUT = "test/case_terrain.json";
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
let exitCode = 0;

try {
  await page.goto("http://127.0.0.1:8931/index.html?casesgeo=" + Date.now(), {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });
  await page.bringToFront();
  await page.waitForFunction(
    () => {
      const tp = window.__app?.viewer?.terrainProvider;
      return tp && typeof tp.requestTileGeometry === "function" &&
        tp.constructor?.name !== "EllipsoidTerrainProvider" && !!tp.availability;
    },
    { timeout: 60000 },
  ).catch(() => {});

  const probe = await page.evaluate(async () => {
    const app = window.__app;
    const viewer = app.viewer;
    const tp = viewer.terrainProvider;
    const out = {
      provider: tp?.constructor?.name ?? null,
      ready: app.ready,
      cases: [],
    };
    for (const c of app.cases()) {
      const full = (await import("/src/data/cases.js")).getCase(c.id);
      const [w, s, e, n] = full.extent;
      const pts = [];
      for (let iy = 0; iy < 5; iy++) {
        for (let ix = 0; ix < 5; ix++) {
          const lon = w + (ix / 4) * (e - w);
          const lat = s + (iy / 4) * (n - s);
          pts.push(Cesium.Cartographic.fromDegrees(lon, lat));
        }
      }
      let hs = [];
      try {
        hs = (await Cesium.sampleTerrainMostDetailed(tp, pts)).map((p) => p.height);
      } catch (err) {
        hs = [];
      }
      const mins = hs.length ? Math.min(...hs) : null;
      const maxs = hs.length ? Math.max(...hs) : null;

      const cam = full.camera;
      let ground = null;
      try {
        const cc = (await Cesium.sampleTerrainMostDetailed(tp, [
          Cesium.Cartographic.fromDegrees(cam.lon, cam.lat),
        ]))[0];
        ground = cc.height;
      } catch {}

      out.cases.push({
        id: c.id,
        name: c.name,
        extent: full.extent,
        minElev: mins,
        maxElev: maxs,
        relief: mins != null && maxs != null ? Math.round(maxs - mins) : null,
        camGround: ground != null ? Math.round(ground) : null,
        elevs: hs.map((h) => (h == null ? null : Math.round(h))),
      });

      if (ground != null) {
        const camera = viewer.camera;
        camera.cancelFlight();
        camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, ground + (cam.agl ?? 2000)),
          orientation: {
            heading: Cesium.Math.toRadians(cam.heading ?? 180),
            pitch: Cesium.Math.toRadians(cam.pitch ?? -30),
            roll: 0,
          },
        });
      }
    }
    return out;
  });

  console.log("PROVIDER:", probe.provider);
  for (const c of probe.cases) {
    console.log(
      `${c.id}: elev ${c.minElev}~${c.maxElev} (relief ${c.relief}) camGround ${c.camGround}`,
    );
    // 每个案例单独截一张
    await page.evaluate(async (id) => {
      const app = window.__app;
      const full = (await import("/src/data/cases.js")).getCase(id);
      const viewer = app.viewer;
      const cam = full.camera;
      const cc = (await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [
        Cesium.Cartographic.fromDegrees(cam.lon, cam.lat),
      ]))[0];
      const camera = viewer.camera;
      camera.cancelFlight();
      camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, cc.height + (cam.agl ?? 2000)),
        orientation: {
          heading: Cesium.Math.toRadians(cam.heading ?? 180),
          pitch: Cesium.Math.toRadians(cam.pitch ?? -30),
          roll: 0,
        },
      });
    }, c.id);
    await page.evaluate(
      () =>
        new Promise((r) => {
          const scene = window.__app.viewer.scene;
          const off = scene.postRender.addEventListener(() => {
            off();
            r();
          });
        }),
    );
    await new Promise((r) => setTimeout(r, 1200));
    await page.screenshot({ path: `test/case_${c.id}.png` });
  }

  fs.writeFileSync(OUT, JSON.stringify({ ...probe, logs }, null, 2));
  console.log("LOGS:", logs.slice(0, 10));
} catch (err) {
  exitCode = 1;
  console.error("PROBE FAILED:", err.message);
  console.log("LOGS:", logs.slice(0, 10));
} finally {
  try {
    await page.close();
  } catch {}
  await browser.disconnect();
}
process.exitCode = exitCode;