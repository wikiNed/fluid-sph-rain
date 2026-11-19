// 探测：参考图层 / 雨滴效果 / 5 档水深配色 是否正常加载（真 GPU :9223）
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
await page.setViewport({ width: 1280, height: 800 });
const logs = [];
page.on("console", (m) => {
  const t = m.text();
  if (/error|fail|shader|Invalid/i.test(t)) logs.push(`${m.type()}: ${t}`);
});
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${e.message}`));

await page.goto("http://127.0.0.1:8931/index.html?probe=" + Date.now(), {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForFunction(() => window.__app?.ready === true, {
  timeout: 90000,
});

// 等参考图层加载（异步网络）
await new Promise((r) => setTimeout(r, 8000));

const initial = await page.evaluate(() => ({
  ref: window.__app.refLayers(),
  depth: window.__app.depthConfig(),
  rainFx: window.__app.rainFxInfo(),
  status: window.__app.statusText().slice(0, 200),
}));
console.log("INITIAL:", JSON.stringify(initial, null, 1));

// 切换参考图层开关
const toggled = await page.evaluate(() => {
  const before = window.__app.refLayers();
  window.__app.options.refRoads = false;
  const after = window.__app.refLayers();
  window.__app.options.refRoads = true;
  return { before, after, restored: window.__app.refLayers() };
});
console.log(
  "TOGGLE refRoads:",
  JSON.stringify({
    before: toggled.before.layers,
    afterOff: toggled.after.layers,
    restored: toggled.restored.layers,
  }),
);

// 切换 5 档着色
const depthToggle = await page.evaluate(() => {
  const on = window.__app.depthConfig();
  window.__app.options.depthColorEnabled = false;
  window.__app.depthConfig();
  // updateDepthLegend 由 GUI onChange 触发，直接调用它验证
  return { on };
});
console.log("DEPTH:", JSON.stringify(depthToggle.on));

// 提交模拟域 + 雨区 + 开始降雨
const domain = await page.evaluate(async () => {
  return await window.__app.commitGlobeDomain([
    -119.52, 37.76, -119.47, 37.79,
  ]);
});
console.log("DOMAIN:", JSON.stringify(domain));

const region = await page.evaluate(() => window.__app.commitTestRegion(0.3, 0.3));
console.log("REGION:", JSON.stringify(region));

await page.evaluate(() => {
  window.__app.options.rainEnabled = true;
});
await new Promise((r) => setTimeout(r, 4000));
const raining = await page.evaluate(() => ({
  rainFx: window.__app.rainFxInfo(),
  injected: window.__app.injectedAmount(),
  thickness: window.__app.volumeThickness(),
  status: window.__app.statusText().slice(0, 120),
}));
console.log("RAINING:", JSON.stringify(raining));

await page.screenshot({ path: "test/probe_features2.png" });
console.log("LOGS:", JSON.stringify(logs.slice(0, 20), null, 1));

await page.close();
await browser.disconnect();