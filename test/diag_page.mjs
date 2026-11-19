// 快速诊断：页面是否初始化、JS 报错、模块是否加载
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9223",
  defaultViewport: null,
  protocolTimeout: 120000,
});
for (const p of await browser.pages()) {
  if (p.url() !== "about:blank") {
    try {
      await p.close();
    } catch {}
  }
}
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${String(e.message).slice(0, 400)}`));
page.on("requestfailed", (r) =>
  logs.push(`REQFAIL: ${r.url().slice(0, 120)} ${r.failure()?.errorText}`),
);

await page.goto("http://127.0.0.1:8931/index.html?diag=" + Date.now(), {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await new Promise((r) => setTimeout(r, 12000));
const info = await page.evaluate(() => ({
  hasApp: typeof window.__app,
  ready: window.__app?.ready,
  initError: window.__app?.initError,
  status: window.__app?.statusText?.()?.slice(0, 300),
  ceContainer: !!document.getElementById("cesiumContainer"),
  canvases: document.querySelectorAll("canvas").length,
  legend: !!document.getElementById("depthLegend"),
  scripts: [...document.querySelectorAll("script[src]")].map((s) => s.src),
}));
console.log("INFO:", JSON.stringify(info, null, 1));
console.log("LOGS:", JSON.stringify(logs.slice(0, 40), null, 1));
await page.screenshot({ path: "test/diag_page.png" });
await page.close();
await browser.disconnect();