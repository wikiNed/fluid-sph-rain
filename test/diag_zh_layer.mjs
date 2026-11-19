/**
 * 诊断：高德中文叠加层为什么没有瓦片（直接调用 provider.requestImage + fetch 对照）
 */
import puppeteer from "puppeteer-core";
import path from "node:path";

const BASE = "http://127.0.0.1:8931/";
const CDP = "http://127.0.0.1:9223";
const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "").replace(/\//g, path.sep));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null, protocolTimeout: 300000 });
  for (const p of await browser.pages()) {
    if (p.url() !== "about:blank") { try { await p.close(); } catch {} }
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 850 });
  const logs = [];
  page.on("pageerror", (e) => logs.push("PAGEERROR: " + String(e.message).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") logs.push("CONSOLE: " + String(m.text()).slice(0, 200)); });
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (/autonavi|arcgisonline/.test(u)) logs.push("REQFAIL: " + u.slice(0, 130) + " :: " + r.failure()?.errorText);
  });
  try {
    await page.goto(BASE + "index.html?diagzh=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });
    const info = await page.evaluate(() => {
      const v = window.__app.viewer;
      const out = [];
      for (let i = 0; i < v.imageryLayers.length; i++) {
        const l = v.imageryLayers.get(i);
        const p = l.provider;
        out.push({
          i,
          show: !!l.show,
          provider: p?.constructor?.name,
          url: (p?._url || p?._resource?.url || p?.url || "").toString().slice(0, 90),
          maxLevel: p?.maximumLevel,
          cacheSize: l._imageryCache ? Object.keys(l._imageryCache).length : null,
        });
      }
      return out;
    });
    console.log("layers:", JSON.stringify(info, null, 1));

    // 直接请求一层瓦片 + fetch 对照（四川 103.6,30.7 z13）
    const res = await page.evaluate(async () => {
      const v = window.__app.viewer;
      const C = Cesium;
      const out = {};
      function tileXY(lon, lat, z) {
        const n = 2 ** z;
        const x = Math.floor(((lon + 180) / 360) * n);
        const latR = (lat * Math.PI) / 180;
        const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n);
        return { x, y, z };
      }
      const t = tileXY(103.6, 30.7, 13);
      const urls = {
        sat: `https://webst01.is.autonavi.com/appmaptile?style=6&lang=zh_cn&size=1&scl=1&x=${t.x}&y=${t.y}&z=${t.z}`,
        zh: `https://webst01.is.autonavi.com/appmaptile?style=8&lang=zh_cn&size=1&scl=1&x=${t.x}&y=${t.y}&z=${t.z}`,
      };
      for (const [k, u] of Object.entries(urls)) {
        try {
          const r = await fetch(u, { mode: "cors", cache: "no-store" });
          const blob = await r.blob();
          out[k + "Fetch"] = r.status + " " + blob.size;
        } catch (e) {
          out[k + "Fetch"] = "ERR " + e.message;
        }
      }
      // Cesium provider 直接取图
      const layers = [];
      for (let i = 0; i < v.imageryLayers.length; i++) layers.push(v.imageryLayers.get(i).provider);
      for (const p of layers) {
        if (!p || !p.requestImage) continue;
        try {
          const img = await p.requestImage(t.x, t.y, t.z);
          out["provider_" + (p.constructor?.name || "?") + "_" + (p._url ? "zhAmapUrl" : "other")] =
            img ? "img:" + (img.width || img.image?.width || "?") : "undefined";
        } catch (e) {
          out["providerErr"] = String(e.message).slice(0, 120);
        }
      }
      return out;
    });
    console.log("requests:", JSON.stringify(res, null, 1));
    console.log("LOGS:", JSON.stringify(logs.slice(0, 14), null, 1));
  } finally {
    await page.close().catch(() => {});
    browser.disconnect();
  }
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });