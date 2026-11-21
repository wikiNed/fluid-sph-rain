/**
 * verify_rainfall.mjs —— 「按实际降雨量(mm)模拟」的回归断言（真 GPU CDP :9223）
 *
 * 覆盖：
 *  A. 雨量模式的配置与换算（rainMode/rainAmountMm/rainDurationSec、massPerMm、等效雨强）
 *  B. 一场 100mm 降雨：注入量随时间推进 → 达到设定值后自动停（passInjection=0）
 *  C. 水量真实落地：回读 surfaceTexture 的 data.x 换算水深（data.x × 0.25 × depthFullM）
 *  D. 100mm vs 1000mm：回读水体总质量比 ≈ 10（体积守恒）
 *  E. 「🧹 重置模拟」把水量与雨量累计归零；切回强度模式仍按旧雨强注入
 *  F. 5 档图例与致命错误过滤回归
 *
 * 用法：node test/verify_rainfall.mjs
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
    await page.goto(BASE + "index.html?rainfall=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });
    check("页面就绪", true);

    /* ---------- A. 默认配置与换算 ---------- */
    const cfg0 = await page.evaluate(() => window.__app.rainfallConfig());
    check("默认降雨模式为强度模式", cfg0.mode === "intensity", cfg0.mode);
    check("默认雨量 50mm / 历时 120s", cfg0.amountMm === 50 && cfg0.durationSec === 120);
    check(
      "massPerMm 由体积盒跨度推出 = 1/(250·T)",
      Math.abs(cfg0.massPerMm - 1 / (250 * cfg0.boxThicknessM)) < 1e-12,
      `massPerMm=${cfg0.massPerMm} T=${cfg0.boxThicknessM}`,
    );
    check("默认等效雨强 1500 mm/h", Math.abs(cfg0.rateMmH - 1500) < 1e-6, cfg0.rateMmH);
    const guiInit = await page.evaluate(() => window.__app.rainGuiState());
    check(
      "强度模式默认：显示雨强、隐藏雨量控件",
      !!guiInit && guiInit.intensity === true && guiInit.amount === false && guiInit.preset === false,
      JSON.stringify(guiInit),
    );

    // 安装测试辅助
    await page.evaluate(() => {
      window.__probe = {
        /** 设置雨量模式参数（走 __app.setRainfall 同一路径） */
        setRain(mm, dur, mode) {
          return window.__app.setRainfall(mm, dur, mode);
        },
        setRainEnabled(on) {
          window.__app.options.rainEnabled = !!on;
          return window.__app.options.rainEnabled;
        },
        stats() {
          return window.__app.rainfallConfig();
        },
        /** 回读 surfaceTexture（_simTextures[2]）：data.x = 水量(归一化) */
        readSurface() {
          const C = Cesium;
          const scene = window.__app.viewer.scene;
          const ctx = scene.context;
          const tex = window.__app.fluid?._simTextures?.[2];
          if (!tex) return Promise.resolve(null);
          const fb = new C.Framebuffer({ context: ctx, colorTextures: [tex], destroyAttachments: false });
          return new Promise((resolve) => {
            const remove = scene.postRender.addEventListener(() => {
              remove();
              const w = tex.width;
              const h = tex.height;
              let data;
              try {
                data = ctx.readPixels({ framebuffer: fb, x: 0, y: 0, width: w, height: h });
              } finally {
                try { fb.destroy(); } catch {}
              }
              if (!data) return resolve(null);
              let sum = 0;
              let wet = 0;
              let max = 0;
              for (let i = 0; i < w * h; i++) {
                const x = data[i * 4];
                if (Number.isFinite(x)) {
                  if (x > 0) { sum += x; wet++; if (x > max) max = x; }
                }
              }
              const thick = window.__app.depthConfig().boxThicknessM;
              resolve({
                w, h, sum: +sum.toFixed(6), wet, wetPct: +((100 * wet) / (w * h)).toFixed(2), max,
                // 真实水深(米) = data.x × heightScale(0.25) × 体积盒高程跨度
                maxDepthM: +(max * 0.25 * thick).toFixed(3),
                meanDepthM: wet > 0 ? +((sum * 0.25 * thick) / wet).toFixed(4) : 0,
              });
            });
          });
        },
      };
    });

    /* ---------- 上传夹具 DEM 并提交模拟域 ---------- */
    await page.evaluate(() => {
      const cam = window.__app.viewer.camera;
      cam.setView({ destination: Cesium.Cartesian3.fromDegrees(103.6, 30.7, 18000), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-89), roll: 0 } });
    });
    const input = await page.$("#fileInput");
    await input.uploadFile(path.join(DIR, "fixture_dem.tif"));
    let committed = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      committed = await page.evaluate(() =>
        window.__app.commitDomainUV([[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]),
      );
      if (committed && committed.ok) break;
    }
    check("上传 GeoTIFF 并提交模拟域", !!(committed && committed.ok), JSON.stringify(committed));
    await page.waitForFunction(() => !!window.__app?.fluid, { timeout: 60000 });
    await page.evaluate(() => window.__app.commitTestRegion(0.3, 0.3));
    await sleep(300);

    /* ---------- B. 100mm 一场雨（历时 10s，GUI 最小历时） ---------- */
    const cfg100 = await page.evaluate(() => window.__probe.setRain(100, 10, "amount"));
    check("切换雨量模式成功", cfg100.mode === "amount" && cfg100.amountMm === 100 && cfg100.durationSec === 10, JSON.stringify({ mode: cfg100.mode, mm: cfg100.amountMm, d: cfg100.durationSec }));
    check("切换后已降雨量归零", (cfg100.stats?.injectedMm ?? -1) === 0, String(cfg100.stats?.injectedMm));
    const guiAmount = await page.evaluate(() => window.__app.rainGuiState());
    check(
      "雨量模式：雨强滑杆隐藏、雨量/历时/预设/读数显示",
      !!guiAmount && guiAmount.intensity === false && guiAmount.amount === true && guiAmount.duration === true && guiAmount.preset === true && guiAmount.mm === true,
      JSON.stringify(guiAmount),
    );
    check(
      "雨量模式：整行隐藏生效（面板比强度模式高，非留下空行）",
      !!guiAmount && !!guiInit && guiAmount.folderHeight > guiInit.folderHeight,
      `amount=${guiAmount?.folderHeight} intensity=${guiInit?.folderHeight}`,
    );

    await page.evaluate(() => window.__probe.setRainEnabled(true));
    await sleep(1000);
    const mid = await page.evaluate(() => window.__probe.stats());
    check("降雨中：已降雨量随时间推进", mid.stats.injectedMm > 1, `mm=${mid.stats.injectedMm.toFixed(2)}`);
    check("降雨中：每 pass 注入量 > 0", mid.stats.passInjection > 0, `pass=${mid.stats.passInjection.toExponential(2)}`);

    await sleep(10500);
    const done100 = await page.evaluate(() => window.__probe.stats());
    check("10s 历时结束：已降雨量 ≈ 100mm（±1mm）", Math.abs(done100.stats.injectedMm - 100) <= 1, `mm=${done100.stats.injectedMm.toFixed(3)}`);
    check("历时结束：注入自动停止（passInjection=0）", done100.stats.passInjection === 0, String(done100.stats.passInjection));
    check("历时结束：已降雨时长 ≈ 10s", done100.stats.elapsedSec >= 9.5, `elapsed=${done100.stats.elapsedSec.toFixed(2)}s`);

    await page.evaluate(() => window.__probe.setRainEnabled(false));
    await sleep(500);
    const stopped = await page.evaluate(() => window.__probe.stats());
    check("关闭降雨后注入量不再增长", stopped.stats.injectedMm === done100.stats.injectedMm, `mm=${stopped.stats.injectedMm.toFixed(3)}`);

    const surf100 = await page.evaluate(() => window.__probe.readSurface());
    check("100mm 降雨后地形上出现水体（回读 data.x>0）", !!surf100 && surf100.wet > 0, JSON.stringify(surf100 && { wet: surf100.wet, wetPct: surf100.wetPct, maxDepthM: surf100.maxDepthM }));
    check(
      "100mm 水深量级合理（均匀 0.1m，汇流后局部 < 3m）",
      !!surf100 && surf100.maxDepthM > 0.02 && surf100.maxDepthM < 3,
      `maxDepthM=${surf100?.maxDepthM} mean=${surf100?.meanDepthM}`,
    );
    await page.screenshot({ path: OUT + "rainfall_100mm.png" });

    /* ---------- E1. 重置模拟 → 水量归零 ---------- */
    const rs = await page.evaluate(() => {
      const r = window.__app.restartSimulation();
      return r;
    });
    check("重置模拟后存在新流体实例", !!rs.hasFluid, JSON.stringify(rs));
    await sleep(400);
    const surfReset = await page.evaluate(() => window.__probe.readSurface());
    check("重置后水体质量归零（< 重置前 1%）", !!surfReset && surfReset.sum < surf100.sum * 0.01, surfReset ? `sum=${surfReset.sum} vs before=${surf100.sum}` : "null");
    const cfgReset = await page.evaluate(() => window.__probe.stats());
    check("重置后雨量累计归零", cfgReset.stats.injectedMm === 0, String(cfgReset.stats.injectedMm));

    /* ---------- C/D. 1000mm 一场雨 + 质量比 ---------- */
    const cfg1000 = await page.evaluate(() => window.__probe.setRain(1000, 10, "amount"));
    check("设置 1000mm / 10s", cfg1000.amountMm === 1000 && cfg1000.durationSec === 10, JSON.stringify({ mm: cfg1000.amountMm, d: cfg1000.durationSec }));
    await page.evaluate(() => window.__probe.setRainEnabled(true));
    await sleep(11500);
    const done1000 = await page.evaluate(() => window.__probe.stats());
    check("1000mm 历时结束：注入量 ≈ 1000mm（±10mm）", Math.abs(done1000.stats.injectedMm - 1000) <= 10, `mm=${done1000.stats.injectedMm.toFixed(2)}`);
    check("1000mm 历时结束：注入自动停止", done1000.stats.passInjection === 0, String(done1000.stats.passInjection));
    const surf1000 = await page.evaluate(() => window.__probe.readSurface());
    check("1000mm 降雨后水体质量 > 0", !!surf1000 && surf1000.sum > 0, surf1000 ? `sum=${surf1000.sum}` : "null");
    const ratio = surf1000 && surf100 ? surf1000.sum / surf100.sum : 0;
    check("1000mm / 100mm 水体总质量比 ≈ 10（7~13）", ratio >= 7 && ratio <= 13, `ratio=${ratio.toFixed(2)}`);
    check("1000mm 水深 > 100mm 水深", !!surf1000 && !!surf100 && surf1000.maxDepthM > surf100.maxDepthM, `maxM 100mm=${surf100?.maxDepthM} 1000mm=${surf1000?.maxDepthM}`);
    await page.screenshot({ path: OUT + "rainfall_1000mm.png" });

    /* ---------- E2. 切回强度模式 ---------- */
    const back = await page.evaluate(() => window.__probe.setRain(1000, 120, "intensity"));
    check("切回强度模式", back.mode === "intensity", back.mode);
    const guiIntensity = await page.evaluate(() => window.__app.rainGuiState());
    check(
      "强度模式：雨强滑杆恢复显示、雨量控件隐藏",
      !!guiIntensity && guiIntensity.intensity === true && guiIntensity.amount === false && guiIntensity.preset === false,
      JSON.stringify(guiIntensity),
    );
    check(
      "强度模式：面板比雨量模式矮（雨量行整行隐藏）",
      !!guiIntensity && !!guiAmount && guiIntensity.folderHeight < guiAmount.folderHeight,
      `now=${guiIntensity?.folderHeight} amountMode=${guiAmount?.folderHeight}`,
    );
    await page.evaluate(() => window.__probe.setRainEnabled(true));
    await sleep(1200);
    const inten = await page.evaluate(() => window.__probe.stats());
    check("强度模式：passInjection = 雨强 0.0004", Math.abs(inten.stats.passInjection - 0.0004) < 1e-9, String(inten.stats.passInjection));
    check("强度模式：注入量持续增长（不设上限）", inten.stats.injectedMm === 0 && (await page.evaluate(() => window.__app.injectedAmount())) > 0);
    await page.evaluate(() => window.__probe.setRainEnabled(false));

    /* ---------- F. 图例 / 致命错误 ---------- */
    const depth = await page.evaluate(() => window.__app.depthConfig());
    check("5 档图例仍为 5 行", depth.legendRows === 5 && depth.bands.length === 4, `bands=${JSON.stringify(depth.bands)}`);

    const fatal = logs.filter(
      (l) =>
        !/favicon\.ico/.test(l) &&
        !/Failed to load resource/.test(l) &&
        !/ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED|ERR_NAME_NOT_RESOLVED|ERR_SOCKET_NOT_CONNECTED|net::ERR_/.test(l) &&
        !/图层加载失败|图层加载超时/.test(l) &&
        !/An error occurred in "ImageryLayer"/.test(l) &&
        !/404/.test(l),
    );
    check("无致命页面错误", fatal.length === 0, JSON.stringify(fatal.slice(0, 3)));

    fs.writeFileSync(
      OUT + "verify_rainfall.json",
      JSON.stringify({ results, cfg0, mid, done100, done1000, surf100, surf1000, surfReset, ratio }, null, 2),
    );
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n===== ${passed}/${results.length} PASS =====`);
    if (passed !== results.length) process.exitCode = 1;
  } finally {
    await page.close().catch(() => {});
    browser.disconnect();
  }
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });