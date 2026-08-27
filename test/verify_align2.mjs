import puppeteer from "puppeteer-core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9222",
  defaultViewport: { width: 1400, height: 860 },
});
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

await page.evaluate(() =>
  window.__app.commitRegionUV([
    [0.3, 0.25],
    [0.65, 0.25],
    [0.65, 0.55],
    [0.3, 0.55],
  ]),
);
await page.evaluate(() => {
  window.__app.options.rainIntensity = 0.015;
  window.__app.options.rainEnabled = true;
});

// 斜视：让盒子居中（高度9000m、俯角70°、中心偏南约2.8km）
await page.evaluate(() => {
  const C = window.Cesium;
  const e = window.__app.extent;
  const lonC = (e[0] + e[2]) / 2, latC = (e[1] + e[3]) / 2;
  window.__app.viewer.camera.flyTo({
    destination: C.Cartesian3.fromDegrees(lonC, latC - 0.025, 9000),
    orientation: { heading: 0, pitch: C.Math.toRadians(-70), roll: 0 },
    duration: 1.0,
  });
});
await sleep(9000);
await page.screenshot({ path: path.join(DIR, "align2_oblique.png") });

// 侧视（低角度看水面是否贴在山体表面）
await page.evaluate(() => {
  const C = window.Cesium;
  const e = window.__app.extent;
  const lonC = (e[0] + e[2]) / 2, latC = (e[1] + e[3]) / 2;
  window.__app.viewer.camera.flyTo({
    destination: C.Cartesian3.fromDegrees(lonC, latC - 0.05, 4200),
    orientation: { heading: 0, pitch: C.Math.toRadians(-18), roll: 0 },
    duration: 1.0,
  });
});
await sleep(2500);
await page.screenshot({ path: path.join(DIR, "align2_side.png") });

console.log("injected:", await page.evaluate(() => window.__app.injectedAmount()));
await browser.disconnect();
console.log("done");
