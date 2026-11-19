/**
 * verify_features3.mjs —— 两处新需求的回归断言（真 GPU CDP :9223）
 *
 * 覆盖：
 *  A. 中文标注图层（高德透明叠加层 / 天地图 tk 行为）
 *  B. 相机进入体积盒后水体仍然可见（cull BACK → 盒内全剔除 的修复）
 *
 * 注意：当前沙箱网络对 ArcGIS 不可达，测试里用「高德卫星」当底图验证中文叠加
 *      的可见性（只是测试手段，不影响应用本身的底图逻辑）。
 *
 * 用法：node test/verify_features3.mjs
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:8931/";
const CDP = "http://127.0.0.1:9223";
const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "").replace(/\//g, path.sep));
const OUT = DIR.endsWith(path.sep) ? DIR : DIR + path.sep;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  :: " + detail}`);
}

async function main() {
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null, protocolTimeout: 300000 });
  for (const p of await browser.pages()) {
    if (p.url() !== "about:blank") { try { await p.close(); } catch {} }
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 850 });
  const logs = [];
  page.on("pageerror", (e) => logs.push("PAGEERROR: " + String(e.message).slice(0, 220)));
  page.on("console", (m) => { if (m.type() === "error") logs.push("CONSOLE: " + String(m.text()).slice(0, 220)); });

  try {
    await page.goto(BASE + "index.html?verify3=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });
    check("页面就绪", true);

    /* ---------------- A. 中文标注图层 ---------------- */
    const zh0 = await page.evaluate(() => ({
      state: window.__app.refLayers(),
      optAmap: window.__app.options.refZhAmap,
      optTdt: window.__app.options.refTdtLabels,
      token: window.__app.options.tdtToken,
    }));
    check("配置项 refZhAmap 默认 true", zh0.optAmap === true);
    check("配置项 refTdtLabels 默认 false", zh0.optTdt === false);
    check("高德中文叠加层已创建", zh0.state.zh.amapCreated === true);
    check("高德中文叠加层默认显示", zh0.state.zh.amap === true);
    check("天地图图层未创建（无 tk）", zh0.state.zh.tdtCreated === false);

    await page.evaluate(() => {
      window.__probe = {
        addAmapSatelliteBottom() {
          const C = Cesium;
          const v = window.__app.viewer;
          const p = new C.UrlTemplateImageryProvider({
            url: "https://webst0{s}.is.autonavi.com/appmaptile?style=6&lang=zh_cn&size=1&scl=1&x={x}&y={y}&z={z}",
            subdomains: ["1", "2", "3", "4"],
            maximumLevel: 18,
          });
          const l = v.imageryLayers.addImageryProvider(p);
          v.imageryLayers.lowerToBottom(l);
          return v.imageryLayers.length;
        },
        removeAmapSatelliteBottom() {
          const v = window.__app.viewer;
          const first = v.imageryLayers.get(0);
          if (first && first !== window.__probe._amapZhLayer && v.imageryLayers.length > 2) {
            v.imageryLayers.remove(first, true);
          }
          return v.imageryLayers.length;
        },
        readFrame() {
          return new Promise((resolve) => {
            const scene = window.__app.viewer.scene;
            const remove = scene.postRender.addEventListener(() => {
              const gl = scene.context._gl;
              const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
              const px = new Uint8Array(w * h * 4);
              gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
              remove();
              resolve({ w, h, px: Array.from(px) });
            });
          });
        },
        diffPct(on, off) {
          const { w, h } = on;
          let changed = 0;
          for (let i = 0; i < on.px.length; i += 4) {
            const d = Math.abs(on.px[i] - off.px[i]) + Math.abs(on.px[i + 1] - off.px[i + 1]) + Math.abs(on.px[i + 2] - off.px[i + 2]);
            if (d > 24) changed++;
          }
          return +(100 * changed / (w * h)).toFixed(2);
        },
        volumeDiffPct() {
          const stage = window.__app.fluid?._stages?.[4];
          if (!stage) return null;
          return new Promise((resolve) => {
            const scene = window.__app.viewer.scene;
            const read = () =>
              new Promise((res) => {
                const remove = scene.postRender.addEventListener(() => {
                  const gl = scene.context._gl;
                  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
                  const px = new Uint8Array(w * h * 4);
                  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
                  remove();
                  res({ w, h, px: Array.from(px) });
                });
              });
            (async () => {
              stage.show = false;
              const off = await read();
              stage.show = true;
              const on = await read();
              let changed = 0;
              for (let i = 0; i < on.px.length; i += 4) {
                const d = Math.abs(on.px[i] - off.px[i]) + Math.abs(on.px[i + 1] - off.px[i + 1]) + Math.abs(on.px[i + 2] - off.px[i + 2]);
                if (d > 24) changed++;
              }
              resolve(+(100 * changed / (on.w * on.h)).toFixed(2));
            })();
          });
        },
        insideFlag() {
          return !!window.__app.fluid?._stages?.[4]?._insideBox;
        },
        view(lon, lat, h, pitchDeg, headingDeg = 0) {
          const cam = window.__app.viewer.camera;
          cam.cancelFlight();
          cam.setView({
            destination: Cesium.Cartesian3.fromDegrees(lon, lat, h),
            orientation: { heading: Cesium.Math.toRadians(headingDeg), pitch: Cesium.Math.toRadians(pitchDeg), roll: 0 },
          });
        },
      };
    });

    const countWithSat = await page.evaluate(() => window.__probe.addAmapSatelliteBottom());
    check("叠加高德卫星底图后影像层数 ≥3", countWithSat >= 3, `layers=${countWithSat}`);
    await page.evaluate(() => window.__probe.view(103.6, 30.7, 4000, -35));
    await sleep(7000);

    await page.evaluate(() => { window.__app.options.refZhAmap = true; window.__app.applyRefLayerVisibility(); });
    await sleep(1200);
    const zhOn = await page.evaluate(() => window.__probe.readFrame());
    await page.screenshot({ path: OUT + "verify3_zh_labels.png" });
    await page.evaluate(() => { window.__app.options.refZhAmap = false; window.__app.applyRefLayerVisibility(); });
    await sleep(1200);
    const zhOff = await page.evaluate(() => window.__probe.readFrame());
    const zhDiff = await page.evaluate((a, b) => window.__probe.diffPct(a, b), zhOn, zhOff);
    check("中文叠加层开/关像素差 > 0.5%（瓦片真实渲染）", zhDiff > 0.5, `diffPct=${zhDiff}`);
    const zhOffState = await page.evaluate(() => window.__app.refLayers().zh);
    check("取消勾选后高德层隐藏", zhOffState.amap === false && zhOffState.amapCreated === true);
    const zhOnState = await page.evaluate(() => {
      window.__app.options.refZhAmap = true;
      window.__app.applyRefLayerVisibility();
      return window.__app.refLayers().zh;
    });
    check("重新勾选后高德层显示", zhOnState.amap === true);

    // 天地图 tk 行为
    const tdtNoToken = await page.evaluate(() => {
      window.__app.options.refTdtLabels = true;
      window.__app.options.tdtToken = "";
      window.__app.applyRefLayerVisibility();
      return window.__app.refLayers().zh;
    });
    check("天地图：无 tk 不创建图层", tdtNoToken.tdtCreated === false);
    const tdtFake = await page.evaluate(() => {
      window.__app.options.tdtToken = "fake_token_for_test";
      window.__app.applyRefLayerVisibility();
      return window.__app.refLayers().zh;
    });
    check("天地图：填 tk 后创建并显示图层", tdtFake.tdtCreated === true && tdtFake.tdt === true, `token=${tdtFake.tdtTokenApplied}`);
    const tdtOff = await page.evaluate(() => {
      window.__app.options.refTdtLabels = false;
      window.__app.applyRefLayerVisibility();
      return window.__app.refLayers().zh;
    });
    check("天地图：取消勾选后隐藏（图层保留）", tdtOff.tdt === false && tdtOff.tdtCreated === true);
    await page.evaluate(() => {
      window.__app.options.tdtToken = "";
      window.__app.options.refTdtLabels = false;
      window.__app.options.refZhAmap = true;
      window.__app.applyRefLayerVisibility();
      window.__probe.removeAmapSatelliteBottom();
    });

    /* ---------------- B. 盒内可见性 ---------------- */
    await page.evaluate(() => window.__probe.view(103.6, 30.7, 20000, -89));
    const input = await page.$("#fileInput");
    await input.uploadFile(path.join(DIR, "fixture_dem.tif"));
    let committed = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      committed = await page.evaluate(() =>
        window.__app.commitDomainUV([
          [0.15, 0.15],
          [0.85, 0.15],
          [0.85, 0.85],
          [0.15, 0.85],
        ]),
      );
      if (committed && committed.ok) break;
    }
    check("上传 GeoTIFF 并提交模拟域", !!(committed && committed.ok), JSON.stringify(committed));
    await page.waitForFunction(() => !!window.__app?.fluid, { timeout: 60000 });
    const box = await page.evaluate(() => {
      const f = window.__app.fluid;
      return { thickness: f._volumeThickness, center: f._volumeCenterElevation, top: f._volumeCenterElevation + f._volumeThickness / 2, bottom: f._volumeCenterElevation - f._volumeThickness / 2 };
    });
    check("体积盒厚度 > 200m（夹具 DEM）", box.thickness > 200, JSON.stringify(box));

    await page.evaluate(() => {
      window.__app.commitTestRegion(0.3, 0.3);
      window.__app.options.rainIntensity = 0.001;
      window.__app.options.rainEnabled = true;
    });
    const center = await page.evaluate(() => {
      const e = window.__app.extent;
      return { lon: (e[0] + e[2]) / 2, lat: (e[1] + e[3]) / 2 };
    });
    await sleep(16000);
    const injected = await page.evaluate(() => Number(window.__app.injectedAmount()));
    check("降雨累计注入 > 0", injected > 0, `injected=${injected}`);

    // 盒外高位：inside=false，水体可见
    await page.evaluate((lon, lat, hh) => window.__probe.view(lon, lat, hh, -25), center.lon, center.lat, box.top + 400);
    await sleep(1500);
    const outsideFlag = await page.evaluate(() => window.__probe.insideFlag());
    const outsideDiff = await page.evaluate(() => window.__probe.volumeDiffPct());
    check("盒外机位 _insideBox=false", outsideFlag === false);
    check("盒外机位水体贡献像素 > 1%", outsideDiff > 1, `diffPct=${outsideDiff}`);
    await page.screenshot({ path: OUT + "verify3_outside.png" });

    // 盒内中位：inside=true，水体仍然可见（修复前为 0）
    await page.evaluate((lon, lat, hh) => window.__probe.view(lon, lat, hh, -25), center.lon, center.lat, box.center);
    await sleep(1500);
    const insideFlag = await page.evaluate(() => window.__probe.insideFlag());
    const insideDiff = await page.evaluate(() => window.__probe.volumeDiffPct());
    check("盒内机位 _insideBox=true", insideFlag === true);
    check("盒内机位水体贡献像素 > 1%（修复前≈0）", insideDiff > 1, `diffPct=${insideDiff}`);
    await page.screenshot({ path: OUT + "verify3_inside.png" });

    // 盒内底部（贴近地面）：仍然可见
    await page.evaluate((lon, lat, hh) => window.__probe.view(lon, lat, hh, -12), center.lon, center.lat, box.bottom + box.thickness * 0.08);
    await sleep(1500);
    const lowFlag = await page.evaluate(() => window.__probe.insideFlag());
    const lowDiff = await page.evaluate(() => window.__probe.volumeDiffPct());
    check("盒内近地面机位 _insideBox=true", lowFlag === true);
    check("盒内近地面水体贡献像素 > 1%", lowDiff > 1, `diffPct=${lowDiff}`);
    await page.screenshot({ path: OUT + "verify3_near_ground.png" });

    // 5 档图例回归
    const depth = await page.evaluate(() => window.__app.depthConfig());
    check("5 档图例仍为 5 行", depth.legendRows === 5 && depth.bands.length === 4, `bands=${JSON.stringify(depth.bands)}`);

    // 致命错误过滤（网络噪声不计；天地图假 tk 的 CORS 报错是本测试故意制造的）
    const fatal = logs.filter(
      (l) =>
        !/favicon\.ico/.test(l) &&
        !/Failed to load resource/.test(l) &&
        !/Access to XMLHttpRequest/.test(l) &&
        !/has been blocked by CORS policy/.test(l) &&
        !/tianditu\.gov\.cn/.test(l) &&
        !/ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED|ERR_NAME_NOT_RESOLVED|ERR_SOCKET_NOT_CONNECTED|net::ERR_/.test(l) &&
        !/图层加载失败|图层加载超时/.test(l) &&
        !/An error occurred in "ImageryLayer"/.test(l) &&
        !/404/.test(l),
    );
    check("无致命页面错误", fatal.length === 0, JSON.stringify(fatal.slice(0, 3)));

    fs.writeFileSync(OUT + "verify_features3.json", JSON.stringify({ results, box, zhDiff, outsideDiff, insideDiff, lowDiff, injected }, null, 2));
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n===== ${passed}/${results.length} PASS =====`);
    if (passed !== results.length) process.exitCode = 1;
  } finally {
    await page.close().catch(() => {});
    browser.disconnect();
  }
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });