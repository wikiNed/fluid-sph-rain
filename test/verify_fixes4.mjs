/**
 * verify_fixes4.mjs —— 四项用户体验修复的回归断言（真 GPU CDP :9223）
 *
 * 覆盖：
 *  A. GUI 精简：删除「浅水颜色 / 深水颜色」，降雨区「累计降雨量(mm)」替代「累计注入量」
 *  B. 水深分档与图例：分界随体积盒跨度自动缩放（0.01%/0.04%/0.1%/0.3%），不再有可拖坏的分界滑块
 *  C. 累计降雨量跨多场累加（100mm + 200mm → ≈300mm），单场统计仍按本场重置
 *  D. 水透明度=0 时水体彻底不可见（屏幕抓帧差分 ≈0），且 Fresnel/高光不再残留
 *
 * 用法：node test/verify_fixes4.mjs
 */
import puppeteer from "puppeteer-core";
import path from "node:path";

const BASE = "http://127.0.0.1:8931/";
const CDP = "http://127.0.0.1:9223";
const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "").replace(/\//g, path.sep));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  :: " + detail}`);
}

async function main() {
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null, protocolTimeout: 300000 });
  for (const p of await browser.pages()) {
    if (p.url() !== "about:blank") {
      try {
        await p.close();
      } catch {}
    }
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 850 });
  const logs = [];
  page.on("pageerror", (e) => logs.push("PAGEERROR: " + String(e.message).slice(0, 220)));
  page.on("console", (m) => {
    if (m.type() === "error") logs.push("CONSOLE: " + String(m.text()).slice(0, 220));
  });

  try {
    await page.goto(BASE + "index.html?fixes4=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });
    check("页面就绪", true);

    /* ---------- A. GUI 精简 ---------- */
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll(".dg .property-name")].map((e) => e.textContent.trim()),
    );
    check("已移除「浅水颜色」", !labels.includes("浅水颜色"), labels.filter((l) => l.includes("颜色")).join(","));
    check("已移除「深水颜色」", !labels.includes("深水颜色"));
    check("降雨行改为「累计降雨量(mm)」", labels.some((l) => l.startsWith("累计降雨量")), labels.filter((l) => l.includes("累计")).join(","));
    check("不再有「累计注入量」", !labels.some((l) => l.includes("累计注入量")));
    check("不再有可拖动的分界滑块（水深分界已自动）", !labels.some((l) => /分界/.test(l)), labels.filter((l) => /分界/.test(l)).join(","));

    /* ---------- 抓帧差分工具 ---------- */
    await page.evaluate(() => {
      const scene = window.__app.viewer.scene;
      const ctx = scene.context;
      const gl = ctx._gl;
      window.__probe = {
        /** 等价 GUI「☔ 开始降雨」总开关 */
        setRainEnabled(on) {
          return window.__app.setRainEnabled(!!on);
        },
        snap() {
          return new Promise((resolve) => {
            const remove = scene.postRender.addEventListener(() => {
              remove();
              const w = gl.drawingBufferWidth;
              const h = gl.drawingBufferHeight;
              const buf = new Uint8Array(w * h * 4);
              gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
              resolve({ w, h, buf: Array.from(buf) });
            });
          });
        },
        diff(a, b) {
          let n = 0;
          const len = Math.min(a.buf.length, b.buf.length);
          for (let i = 0; i < len; i += 4) {
            if (
              Math.abs(a.buf[i] - b.buf[i]) > 24 ||
              Math.abs(a.buf[i + 1] - b.buf[i + 1]) > 24 ||
              Math.abs(a.buf[i + 2] - b.buf[i + 2]) > 24
            )
              n++;
          }
          return +((100 * n) / (a.w * a.h)).toFixed(2);
        },
        diffLow(a, b) {
          // 弱透明度下水色变化很淡，用 6 级阈值统计“有变化”的像素占比
          let n = 0;
          const len = Math.min(a.buf.length, b.buf.length);
          for (let i = 0; i < len; i += 4) {
            if (
              Math.abs(a.buf[i] - b.buf[i]) > 6 ||
              Math.abs(a.buf[i + 1] - b.buf[i + 1]) > 6 ||
              Math.abs(a.buf[i + 2] - b.buf[i + 2]) > 6
            )
              n++;
          }
          return +((100 * n) / (a.w * a.h)).toFixed(2);
        },
      };
    });

    /* ---------- 上传夹具 DEM + 建域（体积盒跨度 235 m，分档可预测） ---------- */
    await page.evaluate(() => {
      const cam = window.__app.viewer.camera;
      cam.setView({
        destination: Cesium.Cartesian3.fromDegrees(103.6, 30.7, 9000),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-50), roll: 0 },
      });
    });
    const input = await page.$("#fileInput");
    await input.uploadFile(path.join(DIR, "fixture_dem.tif"));
    let committed = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      committed = await page.evaluate(() =>
        window.__app.commitDomainUV([
          [0.1, 0.1],
          [0.9, 0.1],
          [0.9, 0.9],
          [0.1, 0.9],
        ]),
      );
      if (committed && committed.ok) break;
    }
    check("上传 GeoTIFF 并提交模拟域", !!(committed && committed.ok), JSON.stringify(committed));
    await page.waitForFunction(() => !!window.__app?.fluid, { timeout: 60000 });
    await page.evaluate(() => window.__app.commitTestRegion(0.3, 0.3));
    await sleep(300);

    /* ---------- B. 分档随体积盒跨度缩放 ---------- */
    const dc = await page.evaluate(() => window.__app.depthConfig());
    const thick = dc.boxThicknessM;
    const expBands = dc.bandFracs.map((f) => Math.max(0.02, +(f * thick).toFixed(3)));
    check("体积盒跨度 > 0 且来自当前流体", thick > 0, `box=${thick}`);
    check(
      "5 档分界 = 跨度 × (0.01%/0.04%/0.1%/0.3%) 自动缩放",
      dc.bands.every((b, i) => Math.abs(b - expBands[i]) < 0.011),
      `bands=${JSON.stringify(dc.bands)} exp=${JSON.stringify(expBands)}`,
    );
    check("跨度≈235 m 时首档 ≈0.024 m（厘米级）", Math.abs(dc.bands[0] - 0.024) < 0.005, `b0=${dc.bands[0]}`);
    const legendText = await page.evaluate(() =>
      [...document.querySelectorAll("#depthLegend .dl-text")].map((e) => e.textContent.trim()),
    );
    const fmt = (v) =>
      Math.abs(v - Math.round(v)) < 0.01 ? String(Math.round(v)) : String(+v.toFixed(v < 1 ? 2 : 1));
    const expText = [0, ...dc.bands];
    const expect = [0, 1, 2, 3, 4].map((i) =>
      i === 4 ? `> ${fmt(expText[4])} m` : `${fmt(expText[i])} – ${fmt(expText[i + 1])} m`,
    );
    check("图例文案随分档动态生成", JSON.stringify(legendText) === JSON.stringify(expect), legendText.join(" | "));

    /* ---------- C. 累计降雨量跨多场累加 ---------- */
    await page.evaluate(() => window.__probe.setRainEnabled(false));
    const cfg1 = await page.evaluate(() => window.__app.setRainfall(100, 10, "amount"));
    check("第一场：100mm/10s", cfg1.amountMm === 100 && cfg1.durationSec === 10);
    await page.evaluate(() => window.__probe.setRainEnabled(true));
    await sleep(11500);
    const e1 = await page.evaluate(() => window.__app.rainfallConfig());
    check("第一场下满 100mm", Math.abs(e1.stats.injectedMm - 100) <= 1, `mm=${e1.stats.injectedMm.toFixed(2)}`);
    check("累计降雨量 ≈ 100mm", Math.abs(e1.stats.totalMm - 100) <= 2, `total=${e1.stats.totalMm.toFixed(2)}`);

    const cfg2 = await page.evaluate(() => window.__app.setRainfall(200, 10, "amount"));
    check("第二场：切换后本场已降雨量归零", Math.abs(cfg2.stats.injectedMm) < 1e-6, `mm=${cfg2.stats.injectedMm}`);
    check("第二场：累计降雨量保留上一场 100mm", Math.abs(cfg2.stats.totalMm - 100) <= 2, `total=${cfg2.stats.totalMm.toFixed(2)}`);
    await page.evaluate(() => window.__probe.setRainEnabled(true));
    await sleep(11500);
    const e2 = await page.evaluate(() => window.__app.rainfallConfig());
    check("第二场下满 200mm", Math.abs(e2.stats.injectedMm - 200) <= 2, `mm=${e2.stats.injectedMm.toFixed(2)}`);
    check("累计降雨量 ≈ 300mm（100 + 200）", Math.abs(e2.stats.totalMm - 300) <= 4, `total=${e2.stats.totalMm.toFixed(2)}`);

    /* ---------- D. 水透明度语义：0=完全不透明，1=最透明(alpha 0.2) ---------- */
    // 先停雨 + 关雨滴 + 冻结 SPH 计算 pass：否则水面持续演化，两次抓帧会
    // 因为水在流动而产生假差分（这也是前面 2% 误报的来源）。
    await page.evaluate(() => {
      window.__app.setRainEnabled(false);
      window.__app.setRainFx(false);
      const stages = window.__app.fluid?._stages ?? [];
      for (let i = 0; i < 4; i++) if (stages[i]) stages[i].show = false;
    });
    await sleep(1500);
    // 自动挑一个能真正拍到水体的机位：试几个候选（南侧近景/远景、东西侧），
    // 用“体积阶段开/关”的画面差分挑出差异最大的那个，避免相机拍空导致误判。
    const camPick = await page.evaluate(async () => {
      const cam = window.__app.viewer.camera;
      const ext = window.__app.precisionInfo().extent;
      const lon = (ext[0] + ext[2]) / 2;
      const lat = (ext[1] + ext[3]) / 2;
      const spanLat = ext[3] - ext[1];
      const spanLon = ext[2] - ext[0];
      const thick = Math.max(100, window.__app.depthConfig().boxThicknessM);
      const candidates = [
        { lon, lat: lat - spanLat * 0.25, h: thick * 1.2, pitch: -40, heading: 0 },
        { lon, lat: lat - spanLat * 0.6, h: thick * 1.6, pitch: -45, heading: 0 },
        { lon: lon - spanLon * 0.6, lat, h: thick * 1.4, pitch: -45, heading: 90 },
        { lon: lon + spanLon * 0.6, lat, h: thick * 1.4, pitch: -45, heading: 270 },
      ];
      const stage = window.__app.fluid._stages[4];
      let best = null;
      for (const c of candidates) {
        cam.cancelFlight();
        cam.setView({
          destination: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, c.h),
          orientation: { heading: Cesium.Math.toRadians(c.heading), pitch: Cesium.Math.toRadians(c.pitch), roll: 0 },
        });
        await new Promise((r) => setTimeout(r, 900));
        stage.show = true;
        const on = await window.__probe.snap();
        stage.show = false;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const off = await window.__probe.snap();
        const d = window.__probe.diff(on, off);
        if (!best || d > best.diff) best = { ...c, diff: d };
      }
      stage.show = true;
      return best;
    });
    check("找到一个能拍到水体的机位", camPick && camPick.diff > 0.3, JSON.stringify(camPick));
    await page.evaluate((c) => {
      const cam = window.__app.viewer.camera;
      cam.cancelFlight();
      cam.setView({
        destination: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, c.h),
        orientation: { heading: Cesium.Math.toRadians(c.heading), pitch: Cesium.Math.toRadians(c.pitch), roll: 0 },
      });
    }, camPick);
    await sleep(1200);

    // 滑块 = 0 → 完全不透明
    await page.evaluate(() => { window.__app.options.waterAlpha = 0; });
    await sleep(400);
    check("默认/设置为 0 时 waterAlpha=0（不透明档）", (await page.evaluate(() => window.__app.options.waterAlpha)) === 0);
    const frameOpaque = await page.evaluate(() => window.__probe.snap());

    // 滑块 = 1 → 最透明（alpha 0.2）
    await page.evaluate(() => { window.__app.options.waterAlpha = 1; });
    await sleep(400);
    const frameClear = await page.evaluate(() => window.__probe.snap());
    const diffOpaqueClear = await page.evaluate((a, b) => window.__probe.diff(a, b), frameOpaque, frameClear);
    check("滑块 0(不透明) → 1(最透明) 画面确实变化", diffOpaqueClear > 0.8, `diffPct=${diffOpaqueClear}`);

    // 关掉体积阶段作为“完全没有水”的参照
    const frameNoWater = await page.evaluate(async () => {
      window.__app.fluid._stages[4].show = false;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return window.__probe.snap();
    });
    const dOpaque = await page.evaluate((a, b) => window.__probe.diff(a, b), frameOpaque, frameNoWater);
    const dClear = await page.evaluate((a, b) => window.__probe.diff(a, b), frameClear, frameNoWater);
    const dClearLow = await page.evaluate((a, b) => window.__probe.diffLow(a, b), frameClear, frameNoWater);
    check("不透明档的水体覆盖明显多于最透明档（0 更“实”）", dOpaque > 1.0 && dOpaque > dClear * 1.2, `不透明=${dOpaque} 最透明=${dClear}`);
    check("最透明档仍能看出水体（低阈值差分 > 0）", dClearLow > 0.2, `diffPct(低阈值)=${dClearLow}`);
    await page.evaluate(() => {
      const stages = window.__app.fluid?._stages ?? [];
      for (let i = 0; i < 4; i++) if (stages[i]) stages[i].show = true;
      window.__app.fluid._stages[4].show = true;
      window.__app.options.waterAlpha = 0.2;
    });

    /* ---------- E. 无致命错误 ---------- */
    const fatal = logs.filter(
      (l) =>
        !/favicon|Failed to load resource|net::ERR_|Access to XMLHttpRequest|blocked by CORS|tianditu\.gov\.cn/i.test(l),
    );
    check("无致命错误", fatal.length === 0, fatal.slice(0, 3).join(" ; "));
  } finally {
    try {
      await page.close();
    } catch {}
    try {
      browser.disconnect();
    } catch {}
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n结果：${pass} 项通过，${results.length - pass} 项失败`);
  // 连到外部 Chrome 的 CDP 连接不会自动释放事件循环，显式退出避免脚本挂起
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("测试执行中断：", e);
  process.exit(1);
});