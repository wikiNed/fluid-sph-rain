/**
 * 截图对比：alpha=0 时「蓝色薄片」到底是水体还是降雨区填充。
 * 产出 test/alpha_case_water.png（隐藏域/雨区填充）、test/alpha_case_fill.png（显示填充）。
 */
import puppeteer from "puppeteer-core";

const CDP = "http://127.0.0.1:9223";
const PAGE = "http://127.0.0.1:8931/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null, protocolTimeout: 300000 });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 850 });

try {
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 120000 });
  await page.evaluate(() => window.__app.runCase("longcaogou-50"));
  await page.waitForFunction(() => !!window.__app.fluid, { timeout: 120000 });
  await sleep(35000);

  const info = await page.evaluate(() => {
    const f = window.__app.fluid;
    return {
      alpha: window.__app.options.waterAlpha,
      thick: f.volumeThickness?.(),
      dc: window.__app.depthConfig(),
      stats: window.__app.rainfallConfig().stats,
    };
  });
  console.log("INFO", JSON.stringify(info));

  await page.evaluate(() => {
    window.__app.setRainEnabled(false);
    window.__app.setRainFx(false);
    const s = window.__app.fluid._stages;
    for (let i = 0; i < 4; i++) s[i].show = false;
    window.__app.options.waterAlpha = 0; // 不透明档
  });
  await sleep(1500);

  // 1) 带填充
  await page.screenshot({ path: "test/alpha_case_fill.png" });

  // 2) 隐藏域 / 雨区 polygon + label
  await page.evaluate(() => {
    for (const e of window.__app.viewer.entities.values) {
      if (e.polygon) e.polygon.show = false;
      if (e.label) e.label.show = false;
    }
  });
  await sleep(800);
  await page.screenshot({ path: "test/alpha_case_water.png" });

  // 3) 关水（作参照）
  await page.evaluate(async () => {
    window.__app.fluid._stages[4].show = false;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await page.screenshot({ path: "test/alpha_case_off.png" });
  console.log("screenshots done");
} finally {
  try { await page.close(); } catch {}
  try { browser.disconnect(); } catch {}
  process.exit(0);
}