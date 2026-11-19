// 探测 2：判断参考图层瓦片是否为“透明叠加”材质（含 alpha 统计），并逐层截图
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9223",
  defaultViewport: null,
  protocolTimeout: 240000,
});
for (const p of await browser.pages()) {
  if (p.url() !== "about:blank") {
    try {
      await p.close();
    } catch {}
  }
}
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800 });
await page.goto("http://127.0.0.1:8931/index.html?refprobe2=" + Date.now(), {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 60000 });

const alpha = await page.evaluate(async () => {
  // ArcGIS tile: level 10 / row / col 覆盖加州 Sierra 一带
  const paths = {
    transport:
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/10/408/173",
    places:
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/10/408/173",
    street:
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/10/408/173",
  };
  const out = {};
  for (const [k, u] of Object.entries(paths)) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
      const b = await r.blob();
      const bmp = await createImageBitmap(b);
      const cv = document.createElement("canvas");
      cv.width = bmp.width;
      cv.height = bmp.height;
      const g = cv.getContext("2d");
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      let opaque = 0,
        semi = 0,
        transparent = 0;
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] > 200) opaque++;
        else if (d[i] > 10) semi++;
        else transparent++;
      }
      out[k] = {
        status: r.status,
        size: [bmp.width, bmp.height],
        opaque,
        semi,
        transparent,
        opaquePct: +((opaque / (d.length / 4)) * 100).toFixed(1),
      };
    } catch (e) {
      out[k] = { err: String(e?.message ?? e).slice(0, 120) };
    }
  }
  return out;
});
console.log("ALPHA:", JSON.stringify(alpha, null, 1));

const shots = await page.evaluate(async () => {
  const v = window.__app.viewer;
  v.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-119.51, 37.775, 22000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-89), roll: 0 },
  });
  await new Promise((r) => setTimeout(r, 7000));
  return { tilesLoaded: v.scene.globe.tilesLoaded, layers: v.imageryLayers.length };
});
console.log("BASE:", JSON.stringify(shots));
await page.screenshot({ path: "test/ref_base.png" });

for (const [name, url] of [
  ["places", "Reference/World_Boundaries_and_Places"],
  ["transport", "Reference/World_Transportation"],
]) {
  const added = await page.evaluate(async (u) => {
    const v = window.__app.viewer;
    const p = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
      "https://server.arcgisonline.com/ArcGIS/rest/services/" + u + "/MapServer",
    );
    v.imageryLayers.addImageryProvider(p);
    await new Promise((r) => setTimeout(r, 7000));
    return { layers: v.imageryLayers.length };
  }, url);
  console.log(name, JSON.stringify(added));
  await page.screenshot({ path: `test/ref_${name}.png` });
}

await page.close();
await browser.disconnect();