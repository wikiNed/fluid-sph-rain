// 模拟精度回归：采样网格（地形保真度）与模拟网格（SPH 规模）的标注与可调性
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: null, protocolTimeout: 600000 });
for (const p of await browser.pages()) if (p.url() !== "about:blank") { try { await p.close(); } catch {} }
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 850 });
const fatal = [];
page.on("pageerror", (e) => { if (!/ResizeObserver/.test(e.message)) fatal.push(e.message); });
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR_|CORS/.test(m.text())) fatal.push(m.text()); });

const near = (a, b, rel = 1e-6) => Math.abs(a - b) <= Math.abs(b) * rel + 1e-6;

try {
  await page.goto("http://127.0.0.1:8931/index.html?prec=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });

  // 1 默认精度
  const init = await page.evaluate(() => window.__app.precisionInfo());
  check("默认采样网格 96² = 9,216 点", init.sampleGrid === 96 && init.samples === 9216, JSON.stringify(init.samples));
  check("模拟网格固定 1024² = 1,048,576 格", init.simGrid === 1024 && init.simCells === 1048576, `${init.simGrid}²`);
  check("未划域时精度文本提示未划定", /未划定模拟域/.test(init.text), init.text);

  // 2 GUI 存在精度控件
  const guiText = await page.evaluate(() => document.body.innerText);
  check("GUI 含「地形采样精度」控件", /地形采样精度/.test(guiText));
  check("GUI 含「模拟精度」只读行", /模拟精度/.test(guiText));

  // 3 切换采样精度
  const set192 = await page.evaluate(() => window.__app.setSampleGrid(192));
  check("切换到 192² → 36,864 点", set192.requestedGrid === 192 && set192.requestedSamples === 36864, JSON.stringify(set192.requestedSamples));

  // 4 全球地形划域后：采样点数、格距、状态栏文案
  const domain = [[0.1, 0.07], [0.93, 0.1], [0.96, 0.56], [0.79, 0.93], [0.3, 0.96], [0.06, 0.6]];
  const dom = await page.evaluate((v) => window.__app.commitGlobeDomain([103.978, 34.923, 104.016, 34.963], v), domain);
  check("全球地形建域成功", dom?.ok === true && dom?.hasMask === true, JSON.stringify(dom));
  await page.waitForFunction(() => window.__app.precisionInfo().extent !== null, { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 1200));

  const info = await page.evaluate(() => window.__app.precisionInfo());
  check("划域后采样网格沿用 192²", info.sampleGrid === 192 && info.samples === 36864, `${info.samples}`);
  const [w, s, e, n] = info.extent;
  const expectX = ((e - w) * 111320 * Math.cos(((s + n) / 2) * Math.PI / 180)) / 191;
  const expectY = ((n - s) * 110540) / 191;
  check("采样点距 = 跨度/(192-1)", near(info.sampleSpacing.x, expectX, 1e-4) && near(info.sampleSpacing.y, expectY, 1e-4),
    `${info.sampleSpacing.x.toFixed(2)}×${info.sampleSpacing.y.toFixed(2)} m vs ${expectX.toFixed(2)}×${expectY.toFixed(2)}`);
  check("模拟格距 = 跨度/1024", near(info.simSpacing.x, expectX * 191 / 1023, 1e-4) && near(info.simSpacing.y, expectY * 191 / 1023, 1e-4),
    `${info.simSpacing.x.toFixed(2)}×${info.simSpacing.y.toFixed(2)} m`);
  check("精度文本含 m/点 与 m/格", /m\/点/.test(info.text) && /m\/格/.test(info.text), info.text);

  const status = await page.evaluate(() => window.__app.statusText());
  check("状态栏标注 36864/36864 网格点", /36864\/36864/.test(status), status.split("\n")[1]);
  check("状态栏含 192×192 与采样间距", /192×192/.test(status) && /间距/.test(status), status.split("\n")[1]);

  // 5 512² 上限可用（换一个更小范围，采样更快）
  const set512 = await page.evaluate(() => window.__app.setSampleGrid(512));
  check("切换到 512² → 262,144 点（上限）", set512.requestedGrid === 512 && set512.requestedSamples === 262144, `${set512.requestedSamples}`);
  const dom2 = await page.evaluate(() => window.__app.commitGlobeDomain([103.99, 34.94, 104.0, 34.95], [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]));
  check("512² 建域成功", dom2?.ok === true, JSON.stringify(dom2?.vertices));
  await page.waitForFunction(() => window.__app.precisionInfo().sampleGrid === 512 && window.__app.precisionInfo().extent !== null, { timeout: 180000 });
  const info512 = await page.evaluate(() => window.__app.precisionInfo());
  check("512² 精度文本与点数正确", info512.samples === 262144 && /采样 512²/.test(info512.text), info512.text);
  check("512² 采样点距小于 3 m（约 1.7 m 级）", info512.sampleSpacing.x > 0 && info512.sampleSpacing.x < 5, info512.sampleSpacing.x.toFixed(2));

  check("无致命页面错误", fatal.length === 0, fatal.slice(0, 3).join(" | "));
} catch (err) {
  check("测试执行未中断", false, err.message);
} finally {
  const pass = results.filter((r) => r.ok).length;
  fs.writeFileSync("test/verify_precision.json", JSON.stringify({ pass, total: results.length, results }, null, 2));
  console.log(`\n==== ${pass}/${results.length} PASS ====`);
  try { await page.close(); } catch {}
  await browser.disconnect();
  process.exit(pass === results.length ? 0 : 1);
}