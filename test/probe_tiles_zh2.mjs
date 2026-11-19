/**
 * 追问探测：候选中文/英文标注瓦片的可达性、透明背景比例，并落盘样图供人工检查。
 * 连 :9222（SwiftShader，仅网络测试）。
 *
 * 用法：node test/probe_tiles_zh2.mjs
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "").replace(/\//g, path.sep));
const OUT = DIR.endsWith(path.sep) ? DIR : DIR + path.sep;
const CDP = "http://127.0.0.1:9222";

const Z = 13;
const LON = 103.6, LAT = 30.7; // 四川（有城区与路网，便于目视中文）
const n = 2 ** Z;
const tx = Math.floor(((LON + 180) / 360) * n);
const latRad = (LAT * Math.PI) / 180;
const ty = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);

const CANDS = [
  { k: "amap8", u: `https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${tx}&y=${ty}&z=${Z}` },
  { k: "amap8scl2", u: `https://wprd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scl=2&style=8&x=${tx}&y=${ty}&z=${Z}` },
  { k: "amap7", u: `https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x=${tx}&y=${ty}&z=${Z}` },
  { k: "amap6sat", u: `https://wprd01.is.autonavi.com/appmaptile?size=1&scl=1&style=6&x=${tx}&y=${ty}&z=${Z}` },
  { k: "tdt-cva-badtk", u: `https://t0.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX=${Z}&TILEROW=${ty}&TILECOL=${tx}&tk=badtoken` },
  { k: "tdt-vec-nokey", u: `https://t0.tianditu.gov.cn/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX=${Z}&TILEROW=${ty}&TILECOL=${tx}` },
  { k: "esriCN-community", u: `https://cache1.arcgisonline.cn/arcgis/rest/services/ChinaOnlineCommunity/MapServer/tile/${Z}/${ty}/${tx}` },
  { k: "esriCOM-transport-en", u: `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/${Z}/${ty}/${tx}` },
  { k: "esriCOM-places-en", u: `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${Z}/${ty}/${tx}` },
];

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1200, height: 800 } });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8931/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction("window.__app && __app.ready === true", { timeout: 90000 }).catch(() => {});

const out = [];
for (const c of CANDS) {
  const r = await page.evaluate(async (url) => {
    const o = { ok: false, status: 0, bytes: 0, ms: 0, alphaPct: null, w: 0, h: 0, err: "", dataUrl: "" };
    const t0 = performance.now();
    try {
      const resp = await fetch(url, { mode: "cors", cache: "no-store" });
      o.status = resp.status;
      const blob = await resp.blob();
      o.bytes = blob.size;
      o.ms = Math.round(performance.now() - t0);
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
        if (o.w <= 512) o.dataUrl = cv.toDataURL("image/png");
      } else if (o.ok) {
        o.err = "not-image:" + blob.type;
      }
    } catch (e) {
      o.err = (e && e.name ? e.name + ": " : "") + (e && e.message ? e.message : String(e));
    }
    return o;
  }, c.u);
  out.push({ k: c.k, ...r });
  console.log(`${c.k}: ok=${r.ok} status=${r.status} bytes=${r.bytes} alpha=${r.alphaPct} ${r.err}`);
  if (r.dataUrl) {
    const b64 = r.dataUrl.split(",")[1];
    fs.writeFileSync(OUT + "tile_" + c.k + ".png", Buffer.from(b64, "base64"));
  }
}
fs.writeFileSync(OUT + "tiles_zh2.json", JSON.stringify(out, null, 2));
await page.close();
browser.disconnect();