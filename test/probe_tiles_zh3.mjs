/**
 * 追问探测 2：找「透明背景 + 中文注记」的叠加瓦片（高德/百度变体），落盘样图。
 * 连 :9222（SwiftShader，仅网络测试）。
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "").replace(/\//g, path.sep));
const OUT = DIR.endsWith(path.sep) ? DIR : DIR + path.sep;
const CDP = "http://127.0.0.1:9222";

const Z = 13;
const LON = 103.6, LAT = 30.7;
const n = 2 ** Z;
const tx = Math.floor(((LON + 180) / 360) * n);
const latRad = (LAT * Math.PI) / 180;
const ty = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
const q = `x=${tx}&y=${ty}&z=${Z}`;

const CANDS = [
  { k: "webst8", u: `https://webst01.is.autonavi.com/appmaptile?style=8&${q}&lang=zh_cn&size=1&scl=1` },
  { k: "wprd8scl1", u: `https://wprd01.is.autonavi.com/appmaptile?style=8&${q}&lang=zh_cn&size=1&scl=1` },
  { k: "webrd8scale1", u: `https://webrd01.is.autonavi.com/appmaptile?style=8&${q}&lang=zh_cn&size=1&scale=1` },
  { k: "amap-labels-a", u: `https://wprd01.is.autonavi.com/appmaptile?x=${tx}&y=${ty}&z=${Z}&lang=zh_cn&size=1&scl=2&style=8` },
  { k: "amap-labels-b", u: `https://wprd01.is.autonavi.com/appmaptile?x=${tx}&y=${ty}&z=${Z}&lang=zh_cn&size=1&scl=1&style=8&ltype=0` },
  { k: "amap-vec7", u: `https://wprd01.is.autonavi.com/appmaptile?x=${tx}&y=${ty}&z=${Z}&lang=zh_cn&size=1&scl=1&style=7` },
  { k: "baidu-pl", u: `https://maponline0.bdimg.com/tile/?qt=tile&x=${tx - 618}&y=${ty - 337}&z=${Z}&styles=pl&scaler=1&p=1` },
  { k: "baidu-sl", u: `https://maponline0.bdimg.com/tile/?qt=tile&x=${tx - 618}&y=${ty - 337}&z=${Z}&styles=sl&scaler=1&p=1` },
];

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1200, height: 800 } });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8931/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction("window.__app && __app.ready === true", { timeout: 90000 }).catch(() => {});

for (const c of CANDS) {
  const r = await page.evaluate(async (url) => {
    const o = { ok: false, status: 0, bytes: 0, alphaPct: null, w: 0, h: 0, err: "", dataUrl: "" };
    try {
      const resp = await fetch(url, { mode: "cors", cache: "no-store" });
      o.status = resp.status;
      const blob = await resp.blob();
      o.bytes = blob.size;
      o.ok = resp.ok && blob.size > 0;
      if (o.ok && /image\//.test(blob.type || "")) {
        const bmp = await createImageBitmap(blob);
        o.w = bmp.width; o.h = bmp.height;
        const cv = document.createElement("canvas");
        cv.width = bmp.width; cv.height = bmp.height;
        const ctx = cv.getContext("2d");
        ctx.drawImage(bmp, 0, 0);
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let nz = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) nz++;
        o.alphaPct = +(100 * nz / (cv.width * cv.height)).toFixed(1);
        if (o.w <= 512 && o.bytes < 120000) o.dataUrl = cv.toDataURL("image/png");
      } else if (o.ok) o.err = "not-image:" + blob.type;
    } catch (e) {
      o.err = (e && e.name ? e.name + ": " : "") + (e && e.message ? e.message : String(e));
    }
    return o;
  }, c.u);
  console.log(`${c.k}: ok=${r.ok} status=${r.status} bytes=${r.bytes} alpha=${r.alphaPct} ${r.err}`);
  if (r.dataUrl) fs.writeFileSync(OUT + "tile2_" + c.k + ".png", Buffer.from(r.dataUrl.split(",")[1], "base64"));
}
await page.close();
browser.disconnect();