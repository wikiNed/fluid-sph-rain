import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223" });
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 200)));
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${String(e).slice(0, 300)}`));
try {
  await page.goto("http://127.0.0.1:8931/", { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 24; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await page.evaluate(() => ({
      hasApp: !!window.__app,
      ready: window.__app?.ready,
      initError: window.__app?.initError ?? null,
      canvases: document.querySelectorAll("canvas").length,
      status: document.getElementById("statusBar")?.textContent?.slice(0, 120) ?? "",
    }));
    console.log(i, JSON.stringify(s));
    if (s.ready === true || s.initError) break;
  }
  console.log("LOGS:", JSON.stringify(logs.slice(0, 10)));
} finally {
  await page.close();
  await browser.disconnect();
}