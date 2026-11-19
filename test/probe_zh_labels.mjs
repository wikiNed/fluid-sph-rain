/**
 * 探测：中文路网/地名标注瓦片源是否可用（网络 + CORS）。
 * 连 :9222（SwiftShader，仅做网络与瓦片测试，不跑重模拟）。
 *
 * 用法：node test/probe_zh_labels.mjs
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const BASE = "http://127.0.0.1:8931/";
const CDP = "http://127.0.0.1:9222";
const OUT = new URL("./", import.meta.url).pathname.replace(/^\//, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANDIDATES = [
  {
    key: "esriCN-community",
    label: "Esri 中国 ChinaOnlineCommunity",
    url: "https://cache1.arcgisonline.cn/arcgis/rest/services/ChinaOnlineCommunity/MapServer/tile/{z}/{y}/{x}",
    type: "arcgis-tile",
  },
  {
    key: "esriCN-streetWarm",
    label: "Esri 中国 ChinaOnlineStreetWarm",
    url: "https://cache1.arcgisonline.cn/arcgis/rest/services/ChinaOnlineStreetWarm/MapServer/tile/{z}/{y}/{x}",
    type: "arcgis-tile",
  },
  {
    key: "amap-road-zh",
    label: "高德 webrd 中文路网(GCJ02)",
    url: "https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
    type: "xyz",
  },
  {
    key: "osm",
    label: "OpenStreetMap",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    type: "xyz",
  },
  {
    key: "tianditu-cva",
    label: "天地图 cva 中文注记（需 tk）",
    url: "https://t0.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={tk}",
    type: "xyz",
  },
];

const PLACES = [
  { name: "yosemite", lon: -119.5, lat: 37.78 },
  { name: "lhasa", lon: 91.1, lat: 29.65 },
  { name: "sichuan", lon: 103.4, lat: 30.9 },
];

const tileXY = (lon, lat, z) => {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
};

async function main() {
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: { width: 1300, height: 800 } });
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction("window.__app && __app.ready === true", { timeout: 90000 }).catch(() => {});
  console.log("page ready");

  const results = [];
  for (const c of CANDIDATES) {
    for (const place of PLACES) {
      for (const z of [12, 14]) {
        const t = tileXY(place.lon, place.lat, z);
        const url = c.url
          .replace("{z}", z).replace("{x}", t.x).replace("{y}", t.y)
          .replace("{tk}", "TESTKEY");
        const r = await page.evaluate(async (url) => {
          const t0 = performance.now();
          const out = { ok: false, status: 0, bytes: 0, ms: 0, cors: false, w: 0, h: 0, alphaPct: null, err: "" };
          try {
            const resp = await fetch(url, { mode: "cors", cache: "no-store" });
            out.status = resp.status;
            const blob = await resp.blob();
            out.bytes = blob.size;
            out.ms = Math.round(performance.now() - t0);
            out.ok = resp.ok && blob.size > 0;
            // 统计非透明像素比例（判断能否作为透明叠加层）
            if (out.ok && /image\/(png|jpeg|webp)/.test(blob.type || "")) {
              const bmp = await createImageBitmap(blob);
              out.w = bmp.width; out.h = bmp.height;
              const cv = document.createElement("canvas");
              cv.width = bmp.width; cv.height = bmp.height;
              const ctx = cv.getContext("2d");
              ctx.drawImage(bmp, 0, 0);
              const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
              let nz = 0;
              for (let i = 3; i < d.length; i += 4) if (d[i] > 8) nz++;
              out.alphaPct = +(100 * nz / (cv.width * cv.height)).toFixed(1);
            }
          } catch (e) {
            out.err = String(e && e.message ? e.message : e);
          }
          return out;
        }, url);
        results.push({ key: c.key, place: place.name, z, ...r });
        console.log(`${c.key} ${place.name} z${z}: ok=${r.ok} status=${r.status} ${r.bytes}B ${r.ms}ms alpha=${r.alphaPct} ${r.err}`);
      }
    }
  }

  // 文件形式保存
  fs.writeFileSync(OUT + "zh_labels_report.json", JSON.stringify(results, null, 2));
  console.log("done");
  await page.close();
  browser.disconnect();
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });