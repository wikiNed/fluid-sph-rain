import puppeteer from "puppeteer-core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9222",
  defaultViewport: { width: 1400, height: 860 },
});
// 清旧标签
for (const p of (await browser.pages()).filter((p) => p.url().includes("8931"))) {
  await p.close().catch(() => {});
}
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e?.message ?? e)));

await page.goto("http://127.0.0.1:8931/index.html", { waitUntil: "domcontentloaded" });
for (let i = 0; i < 150; i++) {
  if (await page.evaluate(() => window.__app?.ready === true)) break;
  await sleep(400);
}
console.log("ready");

// 1) 上传合成 DEM（北亮南暗）
const fileInput = await page.$("#fileInput");
await fileInput.uploadFile(path.join(DIR, "fixture_dem.tif"));
await page.waitForFunction(
  () => window.__app.statusText().includes("模拟进行中"),
  { timeout: 40000 },
);
console.log("tif loaded, extent:", await page.evaluate(() => window.__app.extent));

// 2) 西北象限雨区：u∈[0.1,0.45]（西），v_sim∈[0.05,0.4]（v 小=北）
const reg = await page.evaluate(() =>
  window.__app.commitRegionUV([
    [0.1, 0.05],
    [0.45, 0.05],
    [0.45, 0.4],
    [0.1, 0.4],
  ]),
);
console.log("region:", JSON.stringify(reg));

// 3) 温和雨强
await page.evaluate(() => {
  window.__app.options.rainIntensity = 0.015;
  window.__app.options.rainEnabled = true;
});

// 4) 正俯视（heading=0, pitch≈-90：屏幕上=北，左=西）
await page.evaluate(() => {
  const C = window.Cesium;
  const e = window.__app.extent;
  window.__app.viewer.camera.flyTo({
    destination: C.Cartesian3.fromDegrees((e[0] + e[2]) / 2, (e[1] + e[3]) / 2, 20000),
    orientation: { heading: 0, pitch: C.Math.toRadians(-89.5), roll: 0 },
    duration: 1.0,
  });
});
await sleep(9000); // 让雨水积累成形
const inj = await page.evaluate(() => window.__app.injectedAmount());
console.log("injected:", inj.toFixed(2));
await page.screenshot({ path: path.join(DIR, "fix_top.png") });

// 5) 斜视 45° 看贴地汇流形态
await page.evaluate(() => {
  const C = window.Cesium;
  const e = window.__app.extent;
  window.__app.viewer.camera.flyTo({
    destination: C.Cartesian3.fromDegrees((e[0] + e[2]) / 2, (e[1] + e[3]) / 2 - 0.05, 13000),
    orientation: { heading: 0, pitch: C.Math.toRadians(-45), roll: 0 },
    duration: 1.0,
  });
});
await sleep(2500);
await page.screenshot({ path: path.join(DIR, "fix_oblique.png") });

await browser.disconnect();
console.log("done");
