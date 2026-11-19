// 出图：雨滴下落效果（近景深色林坡背景，雨丝最明显）
import puppeteer from "puppeteer-core";

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
page.on("pageerror", (e) => logs.push(String(e.message).slice(0, 200)));

await page.goto("http://127.0.0.1:8931/index.html?rainonly2=" + Date.now(), {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });

await page.evaluate(async () =>
  window.__app.commitGlobeDomain(
    [-119.55, 37.74, -119.47, 37.8],
    [
      [0.1, 0.1],
      [0.9, 0.12],
      [0.92, 0.88],
      [0.1, 0.9],
    ],
  ),
);
await page.waitForFunction(() => !!window.__app?.fluid, { timeout: 90000 });

const setCam = (lon, lat, height, pitch, heading = 0) =>
  page.evaluate(
    ([lon, lat, height, pitch, heading]) => {
      const cam = window.__app.viewer.camera;
      cam.cancelFlight();
      for (const en of window.__app.viewer.entities.values) if (en.label) en.label.show = false;
      cam.setView({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
        orientation: {
          heading: Cesium.Math.toRadians(heading),
          pitch: Cesium.Math.toRadians(pitch),
          roll: 0,
        },
      });
    },
    [lon, lat, height, pitch, heading],
  );

const center = await page.evaluate(() => {
  const e = window.__app.domain.extent;
  return { lon: (e[0] + e[2]) / 2, lat: (e[1] + e[3]) / 2, e };
});

await page.evaluate(() => {
  window.__app.commitRegionUV([
    [0.28, 0.35],
    [0.72, 0.35],
    [0.72, 0.72],
    [0.28, 0.72],
  ]);
  window.__app.options.rainIntensity = 0.0015; // 雨丝密度 1.25
  window.__app.options.rainEnabled = true;
});

// 低机位贴山坡（北向俯视森林坡面），雨丝在深色背景上清晰
await setCam(center.lon, center.lat - 0.055, 2700, -12, 0);
await new Promise((r) => setTimeout(r, 2600));
await page.screenshot({ path: "test/rain_fx_close.png" });

// 中景全景，同时能看到雨区与雨丝
await setCam(center.lon, center.lat - 0.075, 4200, -26, 0);
await new Promise((r) => setTimeout(r, 2200));
await page.screenshot({ path: "test/rain_fx_wide.png" });

console.log("FX:", JSON.stringify(await page.evaluate(() => window.__app.rainFxInfo())));
console.log("LOGS:", JSON.stringify(logs.slice(0, 4)));
await page.close();
await browser.disconnect();