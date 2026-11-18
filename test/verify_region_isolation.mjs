// 验证「画降雨区域」不会反过来替换模拟域（真机 UI 点击级回归）
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: null, protocolTimeout: 240000 });
for (const p of await browser.pages()) { if (p.url() !== "about:blank") { try { await p.close(); } catch {} } }
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("PAGEERR:" + (e.stack || e.message)));
page.on("console", (m) => { if (m.type() === "error") errs.push("CONSOLE:" + m.text()); });
await page.setViewport({ width: 1500, height: 850 });
await page.goto("http://127.0.0.1:8931/index.html?iso=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 60000 });

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`); ok ? pass++ : fail++; };

// 相机：俯视 Tuolumne 一带，保证画布点击能拾到地表
await page.evaluate(() => {
  const v = window.__app.viewer;
  v.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-119.51, 37.775, 9000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-89), roll: 0 },
  });
  window.__app.options.globeSampleGrid = 32;
});
await new Promise((r) => setTimeout(r, 3000));

const clickAt = async (x, y, button = "left") => { await page.mouse.click(x, y, { button }); await new Promise((r) => setTimeout(r, 250)); };

// 1) 画大框作为模拟域
const bigPts = [[380, 260], [980, 260], [980, 600], [380, 600]];
console.log("→ 用鼠标点击画模拟域（大框）…");
for (const [x, y] of bigPts) await clickAt(x, y);
await page.mouse.click(980, 600, { button: "right" });
await page.waitForFunction(() => window.__app.statusText().includes("模拟进行中"), { timeout: 90000 });
const domAfterBig = await page.evaluate(() => ({
  n: window.__app.domain?.cartos?.length ?? -1,
  extent: window.__app.domain?.extent ?? null,
  status: window.__app.statusText().slice(0, 60),
}));
console.log("BIG DOMAIN:", JSON.stringify(domAfterBig));
check("模拟域已用大框建立", domAfterBig.n >= 3, "vertices=" + domAfterBig.n);
check("模拟已启动", domAfterBig.status.includes("模拟进行中"), domAfterBig.status);

// 2) 画小框作为降雨区域
// 注意：域提交后 index.js 会 camera.flyTo 到域中心（pitch -55），
// 画面坐标已经变了，必须先重新设定相机，否则点击落点在域外。
await page.evaluate(() => {
  const e = window.__app.domain.extent;
  const lon = (e[0] + e[2]) / 2, lat = (e[1] + e[3]) / 2;
  window.__app.viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, 5000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-89), roll: 0 },
  });
});
await new Promise((r) => setTimeout(r, 3000));
console.log("→ 点击「绘制降雨区域」并在框内画雨区（小框）…");
await page.click("#btnDraw");
await new Promise((r) => setTimeout(r, 400));
const smallPts = [[700, 360], [820, 360], [820, 480], [700, 480]];
for (const [x, y] of smallPts) await clickAt(x, y);
await page.mouse.click(820, 480, { button: "right" });
await new Promise((r) => setTimeout(r, 2500));

const after = await page.evaluate(() => ({
  n: window.__app.domain?.cartos?.length ?? -1,
  extent: window.__app.domain?.extent ?? null,
  rainActive: window.__app.activeRegions?.() ?? -1,
  hasRainMask: !!window.__app.fluid?._rainMaskLive,
  hasFluid: !!window.__app.fluid,
  edExtent: window.__app.editor?._extent ?? null,
  edDrawing: window.__app.editor?.drawing ?? null,
  status: window.__app.statusText().slice(0, 120),
}));
console.log("AFTER RAIN REGION:", JSON.stringify(after));

check("画雨区后模拟域顶点数不变", after.n === domAfterBig.n, `before=${domAfterBig.n} after=${after.n}`);
const sameExtent = JSON.stringify(after.extent) === JSON.stringify(domAfterBig.extent);
check("画雨区后模拟域范围不变（未被雨区顶替）", sameExtent, JSON.stringify(after.extent));
check("雨区已成功创建（活动数≥1）", after.rainActive >= 1, "active=" + after.rainActive);
check("雨区掩膜已生成", after.hasRainMask === true);
check("流体模拟仍在运行", after.hasFluid === true);
check("无控制台错误", errs.length === 0, errs.slice(0, 3).join(" | "));

await page.screenshot({ path: "test/iso_after.png" });
console.log(`\n== 结果: ${fail === 0 ? "ALL PASS" : fail + " FAILED"} (pass=${pass}, fail=${fail}) ==`);
await page.close(); await browser.disconnect();
process.exit(fail === 0 ? 0 : 1);
