// usage: node test/bisect_check.mjs <label>
import puppeteer from "puppeteer-core";
const label = process.argv[2] || "variant";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: { width: 1200, height: 750 }, protocolTimeout: 180000 });
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => { if (/compile|link|error occurred/i.test(m.text())) logs.push(m.text()); });
await page.goto("http://127.0.0.1:8931/index.html?cb=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 60000 });
await page.evaluate(() => { window.__app.options.globeSampleGrid = 24; });
const dom = await page.evaluate(() => window.__app.commitGlobeDomain([-119.55, 37.74, -119.47, 37.80]));
await new Promise((r) => setTimeout(r, 2500));
const dlg = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => /An error occurred while rendering/.test(e.textContent || "") && e.children.length === 0).length);
const compileErr = logs.filter((l) => /failed to compile|failed to link|translation failed/i.test(l)).length;
console.log(JSON.stringify({ label, domainOk: dom.ok, dialog: dlg, compileErr }));
await page.close();
await browser.disconnect();
