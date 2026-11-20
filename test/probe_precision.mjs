// 精度探针：设置采样网格 → 全球地形划域 → 读回 precisionInfo/状态栏
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: null, protocolTimeout: 600000 });
for (const p of await browser.pages()) if (p.url() !== "about:blank") { try { await p.close(); } catch {} }
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 850 });
const logs = [];
page.on("pageerror", (e) => logs.push("PAGEERROR " + e.message));
page.on("console", (m) => { if (m.type() === "error") logs.push("ERR " + m.text().slice(0, 160)); });
try {
  await page.goto("http://127.0.0.1:8931/index.html?p=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });
  console.log("init:", JSON.stringify(await page.evaluate(() => window.__app.precisionInfo())));
  console.log("set:", JSON.stringify(await page.evaluate(() => window.__app.setSampleGrid(192))));
  const domain = [[0.1, 0.07], [0.93, 0.1], [0.96, 0.56], [0.79, 0.93], [0.3, 0.96], [0.06, 0.6]];
  console.log("dom:", JSON.stringify(await page.evaluate((v) => window.__app.commitGlobeDomain([103.978, 34.923, 104.016, 34.963], v), domain)));
  await page.waitForFunction(() => window.__app.precisionInfo().extent !== null, { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 1500));
  console.log("info:", JSON.stringify(await page.evaluate(() => window.__app.precisionInfo())));
  console.log("status:", JSON.stringify(await page.evaluate(() => window.__app.statusText())));
  console.log("dem:", JSON.stringify(await page.evaluate(() => window.__app.demInfo?.() ?? null)));
  console.log("logs:", JSON.stringify(logs.slice(0, 6)));
} finally {
  try { await page.close(); } catch {}
  await browser.disconnect();
}