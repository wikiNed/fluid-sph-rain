import puppeteer from "puppeteer-core";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: { width: 1400, height: 800 } });
const page = await browser.newPage();
const logs = [];
page.on("pageerror", (e) => logs.push("[pageerror] " + e.message));
page.on("console", (m) => logs.push("[" + m.type() + "] " + m.text()));
await page.goto("http://127.0.0.1:8931/", { waitUntil: "domcontentloaded", timeout: 60000 });
try {
  await page.waitForFunction("window.__app && __app.ready === true", { timeout: 60000 });
} catch (e) {
  console.log("ready timeout");
}
const st = await page.evaluate(() => ({
  ready: __app.ready,
  initError: __app.initError,
  terrain: !!__app.viewer.terrainProvider,
  terrainType: __app.viewer.terrainProvider?.constructor?.name,
  imagery: __app.viewer.imageryLayers?.length,
  refLayers: __app.refLayers(),
  extent: __app.extent,
  rainFx: __app.rainFxInfo(),
  depth: __app.depthConfig(),
}));
console.log(JSON.stringify(st, null, 2));
console.log("LOGS:", logs.slice(0, 20).join(" | ") || "(empty)");
await sleep(300);
await page.screenshot({ path: "check_page.png" });
await page.close();
browser.disconnect();