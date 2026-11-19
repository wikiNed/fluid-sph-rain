// 验证：模拟域/雨区面积标注 + 「清空模拟状态」从 0 重启（真实 GPU CDP :9223）
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9223",
  defaultViewport: null,
  protocolTimeout: 240000,
});
for (const p of await browser.pages()) {
  if (p.url() !== "about:blank") {
    try { await p.close(); } catch {}
  }
}
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + (e.stack || e.message)));
page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });
await page.setViewport({ width: 1500, height: 850 });

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
}

await page.goto("http://127.0.0.1:8931/index.html?ar=" + Date.now(), {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 60000 });
check("页面加载完成", true);

// 1) 全球模式划域 → 面积
await page.evaluate(() => { window.__app.options.globeSampleGrid = 48; });
const dom = await page.evaluate(async () => window.__app.commitGlobeDomain(
  [-119.55, 37.74, -119.47, 37.80],
  [[0.10, 0.10], [0.90, 0.12], [0.92, 0.88], [0.10, 0.90]],
));
await page.waitForFunction(() => !!window.__app?.fluid, { timeout: 60000 });
check("全球模式划域成功", dom.ok === true, JSON.stringify(dom.extent ?? null));

const areas = await page.evaluate(() => window.__app.areas());
check("模拟域面积已计算", areas.domainKm2 > 0, `${areas.domainKm2.toFixed(2)} km²`);

// bbox 面积（同纬度带近似）用于交叉校验：多边形面积应小于 bbox 面积
const bboxKm2 = await page.evaluate(() => {
  const e = window.__app.extent;
  const latMid = (e[1] + e[3]) / 2;
  const w = (e[2] - e[0]) * 111.32 * Math.cos((latMid * Math.PI) / 180);
  const h = (e[3] - e[1]) * 110.57;
  return w * h;
});
check(
  "多边形面积 < 外接矩形面积且同一量级",
  areas.domainKm2 > bboxKm2 * 0.3 && areas.domainKm2 < bboxKm2,
  `多边形 ${areas.domainKm2.toFixed(2)} / 矩形 ${bboxKm2.toFixed(2)} km²`,
);

const labels1 = await page.evaluate(() => window.__app.areaLabels());
check(
  "模拟域标签含面积标注",
  labels1.some((t) => /模拟域/.test(t) && /面积/.test(t)),
  labels1.join(" | "),
);

// 2) 划雨区 → 面积 + 标签
const reg = await page.evaluate(() => window.__app.commitTestRegion(0.3, 0.3));
check("雨区划定成功", reg.ok === true && reg.active === 1, JSON.stringify(reg));
const areas2 = await page.evaluate(() => window.__app.areas());
check(
  "雨区面积已计算且包含在域内",
  areas2.rainKm2.length === 1 && areas2.rainKm2[0] > 0 && areas2.rainKm2[0] < areas2.domainKm2,
  `雨区 ${areas2.rainKm2[0]?.toFixed(2)} km² / 域 ${areas2.domainKm2.toFixed(2)} km²`,
);
const labels2 = await page.evaluate(() => window.__app.areaLabels());
check(
  "雨区标签含面积标注",
  labels2.some((t) => /雨区/.test(t) && /面积/.test(t)),
  labels2.filter((t) => /雨区/.test(t)).join(" | "),
);

// 3) 工具栏重置按钮状态
const btn = await page.evaluate(() => {
  const b = document.getElementById("btnReset");
  return b ? { exists: true, disabled: b.disabled, text: b.textContent.trim() } : { exists: false };
});
check("工具栏存在「重置模拟」按钮且可用", btn.exists && !btn.disabled, btn.text);

// 4) 开启降雨 → 累计注入
await page.click("#btnWholeRain");
await page.evaluate(() => {
  window.__app.options.rainIntensity = 0.02; // 测试用大强度（真机 GPU 帧率高）
  window.__app.options.rainEnabled = true;
});
await new Promise((r) => setTimeout(r, 6000));
const injectedBefore = await page.evaluate(() => window.__app.fluid.getInjectedAmount());
check("降雨使累计注入量增加", injectedBefore > 0.05, injectedBefore.toFixed(3));

// 5) 清空模拟状态
const reset = await page.evaluate(() => window.__app.restartSimulation());
check("重置后仍有流体实例", reset.hasFluid === true, JSON.stringify(reset));
check("重置后累计注入量归零", reset.injected < 1e-6, String(reset.injected));

const after = await page.evaluate(() => ({
  hasDomain: window.__app.hasDomain(),
  domainKm2: window.__app.areas().domainKm2,
  active: window.__app.activeRegions(),
  status: window.__app.statusText(),
}));
check("重置保留模拟域", after.hasDomain === true, `${after.domainKm2.toFixed(2)} km²`);
check("重置保留雨区", after.active === 1, `active=${after.active}`);
check("状态栏提示已清空", /已清空模拟状态/.test(after.status), after.status.split("\n")[0]);

// 6) 重置后可重新累计
await new Promise((r) => setTimeout(r, 6000));
const injectedAfter = await page.evaluate(() => window.__app.fluid.getInjectedAmount());
check("重置后降雨重新累计", injectedAfter > 0.05, `${injectedBefore.toFixed(3)} → 0 → ${injectedAfter.toFixed(3)}`);

// 7) 截图（俯视域中心）
await page.evaluate(() => {
  const e = window.__app.extent;
  window.__app.viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees((e[0] + e[2]) / 2, (e[1] + e[3]) / 2, 5200),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-60), roll: 0 },
  });
});
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: "test/shot_area_reset.png" });

// 只把真正的脚本错误计为致命错误：
// - /favicon.ico 的 404、外部 ArcGIS 瓦片的 socket 失败属环境噪声，忽略
const fatalErrors = errors.filter(
  (e) =>
    !/favicon\.ico/i.test(e) &&
    !/Failed to load resource/i.test(e) &&
    !/net::ERR_SOCKET_NOT_CONNECTED|net::ERR_CONNECTION_CLOSED|net::ERR_TIMED_OUT/i.test(e),
);

check("无致命控制台错误", fatalErrors.length === 0, fatalErrors.slice(0, 3).join(" | "));
console.log(`\n== 结果: ${fail === 0 ? "ALL PASS" : `${pass} pass / ${fail} fail`} ==`);
await page.close();
await browser.disconnect();
process.exit(fail === 0 ? 0 : 1);