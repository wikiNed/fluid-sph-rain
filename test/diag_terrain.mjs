import puppeteer from "puppeteer-core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222" });
const pages = (await browser.pages()).filter((p) => p.url().includes("8931"));
const page = pages[pages.length - 1];

const info = await page.evaluate(() => {
  const v = window.__app.viewer;
  const tp = v.terrainProvider;
  return {
    terrainCtor: tp.constructor.name,
    terrainReady: tp.ready,
    terrainError: tp.errorEvent ? "has-event" : "n/a",
    heightAtCam: v.camera.positionCartographic.height,
    layers: v.imageryLayers.length,
    layer0: v.imageryLayers.get(0)?.imageryProvider?.constructor?.name,
  };
});
console.log(JSON.stringify(info, null, 2));

// 等地形/影像瓦片流入后再看
await sleep(6000);
console.log("terrainCtor after wait:", await page.evaluate(() => window.__app.viewer.terrainProvider.constructor.name));

// 斜视秦岭放置区（110,34.5）
await page.evaluate(() => {
  const C = window.Cesium;
  window.__app.viewer.camera.flyTo({
    destination: C.Cartesian3.fromDegrees(110.03, 34.46, 16000),
    orientation: { heading: C.Math.toRadians(15), pitch: C.Math.toRadians(-42), roll: 0 },
    duration: 1.0,
  });
});
await sleep(6500);
await page.screenshot({ path: path.join(DIR, "terrain_oblique.png") });

// 俯视样例区（加州 Sierra，样例数据本身所在的真实地形）
await page.evaluate(() => {
  const C = window.Cesium;
  window.__app.viewer.camera.flyTo({
    destination: C.Cartesian3.fromDegrees(-119.5085, 37.7712, 26000),
    orientation: { heading: 0, pitch: C.Math.toRadians(-60), roll: 0 },
    duration: 1.0,
  });
});
await sleep(6500);
await page.screenshot({ path: path.join(DIR, "terrain_sample.png") });

await browser.disconnect();
console.log("done");
