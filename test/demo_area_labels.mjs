// 生成「区域面积标注」演示截图（真实 GPU CDP :9223）
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9223",
  defaultViewport: null,
  protocolTimeout: 240000,
});
for (const p of await browser.pages()) {
  if (p.url() !== "about:blank") {
    try { await p.close(); } catch {}
  }
}
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 850 });
await page.goto("http://127.0.0.1:8931/index.html?area=" + Date.now(), {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 60000 });

await page.evaluate(() => { window.__app.options.globeSampleGrid = 64; });
await page.evaluate(async () => window.__app.commitGlobeDomain(
  [-119.55, 37.74, -119.47, 37.80],
  [[0.10, 0.10], [0.90, 0.12], [0.92, 0.88], [0.10, 0.90]],
));
await page.waitForFunction(() => !!window.__app?.fluid, { timeout: 60000 });
// onDomainCommitted 里的 flyTo 有 1.5s 动画，必须等它跑完再手动摆位，否则会被飞行覆盖
await new Promise((r) => setTimeout(r, 3500));
await page.evaluate(() => window.__app.commitTestRegion(0.32, 0.30));

// 高空俯视：让模拟域、雨区和两个面积标签同时入画
await page.evaluate(() => {
  const e = window.__app.extent;
  window.__app.viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      (e[0] + e[2]) / 2,
      (e[1] + e[3]) / 2,
      20000,
    ),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-80), roll: 0 },
  });
});
await new Promise((r) => setTimeout(r, 4000));
await page.screenshot({ path: "test/shot_area_labels.png" });
console.log(
  "labels:",
  JSON.stringify(await page.evaluate(() => window.__app.areaLabels())),
);
console.log("areas:", JSON.stringify(await page.evaluate(() => window.__app.areas())));
await page.close();
await browser.disconnect();