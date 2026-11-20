// 四个案例逐一实跑：检查域/雨区/雨量目标/机位，截图 test/case_run_<id>.png
import puppeteer from "puppeteer-core";

const IDS = ["shuangshimen-50", "shuangshimen-150", "longcaogou-50", "datong-80"];

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: null, protocolTimeout: 600000 });
for (const p of await browser.pages()) if (p.url() !== "about:blank") { try { await p.close(); } catch {} }
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 850 });
const fatal = [];
page.on("pageerror", (e) => fatal.push(String(e.message).slice(0, 200)));
const rows = [];
try {
  await page.goto("http://127.0.0.1:8931/index.html?all=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });
  await page.bringToFront();
  for (const id of IDS) {
    const t0 = Date.now();
    await page.evaluate((cid) => window.__app.runCase(cid), id);
    const ok = await page
      .waitForFunction(
        (cid) => !!window.__app.fluid && window.__app.activeCase() === cid,
        { timeout: 150000, polling: 400 },
        id,
      )
      .then(() => true)
      .catch(() => false);
    const info = await page.evaluate(() => {
      const a = window.__app.areas();
      const cfg = window.__app.rainfallConfig();
      const cam = window.__app.viewer.camera;
      return {
        areas: a,
        mode: cfg.mode,
        mm: cfg.amountMm,
        dur: cfg.durationSec,
        targetMass: cfg.stats?.targetMass,
        status: window.__app.statusText(),
        camHeight: Math.round(cam.positionCartographic.height),
        camLon: (cam.positionCartographic.longitude * 180) / Math.PI,
        camLat: (cam.positionCartographic.latitude * 180) / Math.PI,
      };
    });
    await new Promise((r) => setTimeout(r, 2500));
    await page.screenshot({ path: `test/case_run_${id}.png` });
    rows.push({ id, ok, sec: ((Date.now() - t0) / 1000).toFixed(1), ...info });
    console.log(JSON.stringify(rows.at(-1)));
  }
  console.log("FATAL:", JSON.stringify(fatal.slice(0, 4)));
  const bad = rows.filter((r) => !r.ok || !(r.areas.rainTotalKm2 > 0) || !(r.targetMass > 0) || r.mm !== r.mm);
  console.log(bad.length === 0 ? "ALL 4 CASES OK" : `PROBLEM CASES: ${bad.map((b) => b.id).join(",")}`);
} finally {
  try { await page.close(); } catch {}
  await browser.disconnect();
}