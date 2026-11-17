import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: { width: 1500, height: 850 }, protocolTimeout: 120000 });
const page = await browser.newPage();
page.on("pageerror", e => console.log("PAGEERROR:", e.stack || e.message));
await page.goto("http://127.0.0.1:8931/index.html", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 60000 });
// 提交一个「凸五边形」模拟域（非矩形），验证域掩膜按多边形裁剪
const dom = await page.evaluate(() => window.__app.commitDomainUV([
  [0.10, 0.10], [0.90, 0.15], [0.95, 0.85], [0.50, 0.95], [0.05, 0.60],
]));
console.log("DOMAIN:", JSON.stringify(dom));
// 全域降雨：注入会发生在整个域内（域外由掩膜拦截）
await page.evaluate(() => {
  document.getElementById("btnWholeRain").click();
  window.__app.options.rainIntensity = 0.02;
  window.__app.options.rainEnabled = true;
});
await new Promise(r => setTimeout(r, 6000));
await page.screenshot({ path: "E:/DSH/FluidSim/fluid-sph/test/shot_irregular_domain.png" });
console.log("injected:", await page.evaluate(() => window.__app.injectedAmount()));
await browser.disconnect();
