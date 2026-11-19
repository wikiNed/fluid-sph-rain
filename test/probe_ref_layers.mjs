// 探测：ArcGIS 路网 / 地名标注参考图层是否可用（在浏览器网络栈里测，node fetch 不可靠）
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9222",
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
page.on("console", (m) => {
  const t = m.text();
  if (/error|fail/i.test(t)) console.log("[console]", t.slice(0, 200));
});
await page.goto("http://127.0.0.1:8931/index.html?refprobe=" + Date.now(), {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 60000 });

const info = await page.evaluate(async () => {
  const out = { layers: [], providers: {} };
  const v = window.__app.viewer;
  out.layers = [];
  for (let i = 0; i < v.imageryLayers.length; i++) {
    const l = v.imageryLayers.get(i);
    out.layers.push({
      idx: i,
      type: l.imageryProvider?.constructor?.name,
      url: l.imageryProvider?.url,
      alpha: l.alpha,
      show: l.show,
    });
  }
  const urls = {
    transport:
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer",
    places:
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer",
  };
  for (const [k, u] of Object.entries(urls)) {
    const t0 = performance.now();
    try {
      const p = await Cesium.ArcGisMapServerImageryProvider.fromUrl(u);
      out.providers[k] = {
        ok: true,
        ms: Math.round(performance.now() - t0),
        max: p.maximumLevel,
        scheme: p.tilingScheme?.constructor?.name,
        credit: String(p.credit ?? "").slice(0, 60),
      };
    } catch (e) {
      out.providers[k] = {
        ok: false,
        ms: Math.round(performance.now() - t0),
        err: String(e?.message ?? e).slice(0, 200),
      };
    }
  }
  return out;
});
console.log(JSON.stringify(info, null, 1));

// 叠加一层试试能否出瓦片
const added = await page.evaluate(async () => {
  const v = window.__app.viewer;
  try {
    const p = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer",
    );
    const layer = v.imageryLayers.addImageryProvider(p);
    v.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(-119.51, 37.775, 40000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-89), roll: 0 },
    });
    await new Promise((r) => setTimeout(r, 6000));
    return { layers: v.imageryLayers.length, ready: layer.ready, tilesLoaded: v.scene.globe.tilesLoaded };
  } catch (e) {
    return { err: String(e?.message ?? e).slice(0, 200) };
  }
});
console.log("ADD:", JSON.stringify(added));
await page.screenshot({ path: "test/ref_probe.png" });
await page.close();
await browser.disconnect();