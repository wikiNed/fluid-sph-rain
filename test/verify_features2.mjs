// 验证：参考图层（道路网/地名标注）、雨滴下落效果、5 档水深配色
// 真 GPU Chrome（CDP :9223）——SwiftShader 复现不出 GPU 侧问题
import puppeteer from "puppeteer-core";

const CDP = process.env.DSH_CDP || "http://127.0.0.1:9223";
const URL = process.env.DSH_URL || "http://127.0.0.1:8931/index.html";

let pass = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`);
  } else {
    failures.push(name + (detail ? " — " + detail : ""));
    console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`);
  }
}

const browser = await puppeteer.connect({
  browserURL: CDP,
  defaultViewport: null,
  protocolTimeout: 300000,
});
for (const p of await browser.pages()) {
  if (p.url() !== "about:blank") {
    try {
      await p.close();
    } catch {}
  }
}
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 850 });
const fatal = [];
page.on("pageerror", (e) => fatal.push(String(e.message).slice(0, 200)));
page.on("console", (m) => {
  const t = m.text();
  if (/shader|compile|Invalid|Uncaught/i.test(t) && !/favicon|Failed to load resource/i.test(t)) {
    fatal.push(`${m.type()}: ${t.slice(0, 200)}`);
  }
});

await page.goto(`${URL}?verify2=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });
console.log("页面就绪");

/* ---------- 1. 参考图层（道路网 + 地名标注） ---------- */
let ref = null;
for (let i = 0; i < 24; i++) {
  ref = await page.evaluate(() => window.__app.refLayers());
  if (ref.imageryCount >= 3) break;
  await new Promise((r) => setTimeout(r, 500));
}
check("影像图层数量 ≥ 3（底图 + 道路网 + 地名标注）", ref.imageryCount >= 3, `imageryCount=${ref.imageryCount}`);
const road = ref.layers.find((l) => l.key === "refRoads");
const places = ref.layers.find((l) => l.key === "refPlaces");
check("道路网图层已加载且可见", !!road && road.show === true, JSON.stringify(road));
check("地名标注图层已加载且可见", !!places && places.show === true, JSON.stringify(places));

// GUI 开关联动（options 改动后 applyRefLayerVisibility 同步 show）
await page.evaluate(() => {
  window.__app.options.refRoads = false;
  window.__app.applyRefLayerVisibility();
});
let ref2 = await page.evaluate(() => window.__app.refLayers());
check("关闭「道路网」后图层 show=false", ref2.layers.find((l) => l.key === "refRoads")?.show === false);
await page.evaluate(() => {
  window.__app.options.refRoads = true;
  window.__app.applyRefLayerVisibility();
});
ref2 = await page.evaluate(() => window.__app.refLayers());
check("重新开启「道路网」后 show=true", ref2.layers.find((l) => l.key === "refRoads")?.show === true);

/* ---------- 2. 5 档水深配色配置 + 图例 ---------- */
const dc = await page.evaluate(() => window.__app.depthConfig());
check("水深分档着色默认开启", dc.enabled === true);
check(
  "4 个分界值按体积盒跨度自动缩放（2%/5%/10%/20%）",
  Array.isArray(dc.bands) &&
    dc.bands.length === 4 &&
    dc.bands.every((b, i) => Math.abs(b - Math.max(0.5, +(dc.bandFracs[i] * dc.boxThicknessM).toFixed(1))) < 0.11),
  `bands=${JSON.stringify(dc.bands)} box=${dc.boxThicknessM}`,
);
check("5 档颜色已定义", Array.isArray(dc.colors) && dc.colors.length === 5, JSON.stringify(dc.colors));
check("雨量换算标定值 depthFullM=40", dc.fullM === 40, `fullM=${dc.fullM}`);
check("图例可见且 5 行", dc.legendVisible === true && dc.legendRows === 5, `visible=${dc.legendVisible} rows=${dc.legendRows}`);

const legend = await page.evaluate(() => {
  const el = document.getElementById("depthLegend");
  if (!el) return null;
  const rows = [...el.querySelectorAll(".dl-row")].map((r) => ({
    color: r.querySelector(".dl-swatch")?.style.background || "",
    text: r.querySelector(".dl-text")?.textContent?.trim() || "",
  }));
  return { display: getComputedStyle(el).display, rows, title: el.querySelector(".dl-title")?.textContent?.trim() };
});
check("左下角图例 DOM 已显示", legend && legend.display !== "none", legend ? `display=${legend.display}` : "missing");
const fmtM = (v) => (Math.abs(v - Math.round(v)) < 0.01 ? String(Math.round(v)) : String(+v.toFixed(1)));
const expTexts = (() => {
  const b = [0, ...dc.bands];
  return [0, 1, 2, 3, 4].map((i) => (i === 4 ? `> ${fmtM(b[4])} m` : `${fmtM(b[i])} – ${fmtM(b[i + 1])} m`));
})();
check(
  `图例 5 行文案随盒跨度动态生成（${expTexts.join(" | ")}）`,
  legend && legend.rows.length === 5 && expTexts.every((t, i) => legend.rows[i].text === t),
  legend ? legend.rows.map((r) => r.text).join(" | ") : "missing",
);
check(
  "图例第 1 档色块为浅蓝 #7fd8ff",
  legend && /127,\s*216,\s*255/i.test(legend.rows[0].color),
  legend ? legend.rows[0].color : "missing",
);

/* ---------- 3. 雨滴下落效果 ---------- */
const fx0 = await page.evaluate(() => window.__app.rainFxInfo());
check("雨滴效果已创建（存在 PostProcessStage）", fx0.exists === true);
check("未降雨时雨滴 stage 关闭", fx0.stageEnabled === false, JSON.stringify(fx0));

// 建域 + 雨区 + 开降雨
await page.evaluate(async () =>
  window.__app.commitGlobeDomain(
    [-119.55, 37.74, -119.47, 37.8],
    [
      [0.1, 0.1],
      [0.9, 0.12],
      [0.92, 0.88],
      [0.1, 0.9],
    ],
  ),
);
await page.waitForFunction(() => !!window.__app?.fluid, { timeout: 90000 });
check("截图/测试用模拟域已建立", await page.evaluate(() => window.__app.hasDomain()));
// 建域后体积盒跨度变了，重新取一次动态分档与盒跨度
const dcAfterDomain = await page.evaluate(() => window.__app.depthConfig());

// 分档着色开关 → volume stage uniform 与图例联动（需在流体管线建立后）
const gfx = () =>
  page.evaluate(() => ({
    uniform: window.__app.fluid?._stages?.[4]?._uniformMap?.depthColorEnabled?.(),
    range: window.__app.fluid?._stages?.[4]?._uniformMap?.depthRangeM?.(),
    legend: getComputedStyle(document.getElementById("depthLegend")).display,
  }));
const gOn = await gfx();
await page.evaluate(() => {
  window.__app.options.depthColorEnabled = false;
  window.__app.syncDepthColors();
});
const gOff = await gfx();
await page.evaluate(() => {
  window.__app.options.depthColorEnabled = true;
  window.__app.syncDepthColors();
});
const gBack = await gfx();
check("分档着色开启 → uniform=1", gOn.uniform === 1, JSON.stringify(gOn));
check("关闭分档着色 → uniform=0 且图例隐藏", gOff.uniform === 0 && gOff.legend === "none", JSON.stringify(gOff));
check("恢复后 uniform=1 且图例重新显示", gBack.uniform === 1 && gBack.legend === "block", JSON.stringify(gBack));
check("depthRangeM uniform = 体积盒真实跨度（与几何同一把尺子）", gOn.range === dcAfterDomain.boxThicknessM, `range=${gOn.range} box=${dcAfterDomain.boxThicknessM}`);

await page.evaluate(() =>
  window.__app.commitRegionUV([
    [0.3, 0.2],
    [0.6, 0.2],
    [0.6, 0.45],
    [0.3, 0.45],
  ]),
);
const nActive = await page.evaluate(() => window.__app.activeRegions());
check("雨区已提交（1 个）", nActive === 1, `active=${nActive}`);

const fxNoRain = await page.evaluate(() => window.__app.rainFxInfo());
check("有雨区但未开降雨 → 雨滴仍关闭", fxNoRain.stageEnabled === false, JSON.stringify(fxNoRain));

await page.evaluate(() => {
  window.__app.options.rainEnabled = true;
});
await new Promise((r) => setTimeout(r, 800));
const fxRain = await page.evaluate(() => window.__app.rainFxInfo());
check("开降雨 → 雨滴 stage 开启", fxRain.stageEnabled === true, JSON.stringify(fxRain));
check("雨滴密度随雨强换算（0.8 左右）", fxRain.amount > 0.3 && fxRain.amount <= 1.25, `amount=${fxRain.amount}`);

/* 雨丝确实渲染：同机位雨滴开/关两帧做像素差分 */
const cam = await page.evaluate(() => {
  const e = window.__app.domain.extent;
  const cam = window.__app.viewer.camera;
  cam.cancelFlight();
  cam.setView({
    destination: Cesium.Cartesian3.fromDegrees((e[0] + e[2]) / 2, (e[1] + e[3]) / 2 - 0.055, 5200),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-30), roll: 0 },
  });
  return true;
});
await new Promise((r) => setTimeout(r, 1500));
const diffPct = await page.evaluate(async () => {
  const app = window.__app;
  const scene = app.viewer.scene;
  const gl = scene.context._gl;
  const W = scene.canvas.width,
    H = scene.canvas.height;
  const read = () => {
    const buf = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  };
  const grab = () =>
    new Promise((res) => {
      const cb = () => {
        scene.postRender.removeEventListener(cb);
        res(read());
      };
      scene.postRender.addEventListener(cb);
      scene.requestRender();
      setTimeout(() => {
        scene.postRender.removeEventListener(cb);
        res(read());
      }, 2500);
    });
  const keep = app.options.rainIntensity;
  app.options.rainIntensity = 0.00002;
  app.options.rainFx = true;
  await new Promise((r) => setTimeout(r, 700));
  const a = await grab();
  app.options.rainFx = false;
  await new Promise((r) => setTimeout(r, 700));
  const b = await grab();
  app.options.rainFx = true;
  app.options.rainIntensity = keep;
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > 12) diff++;
  }
  return +((diff / (W * H)) * 100).toFixed(2);
});
check("雨滴开关前后画面像素差 > 5%（雨丝确实渲染）", diffPct > 5, `diffPct=${diffPct}%`);
check("相机机位设置成功", cam === true);

/* 降雨累计仍在推进（顺手回归） */
await new Promise((r) => setTimeout(r, 2500));
const inj = await page.evaluate(() => window.__app.injectedAmount());
check("降雨累计注入量 > 0", Number.isFinite(inj) && inj > 0, `injected=${Number(inj).toFixed(3)}`);

const areaInfo = await page.evaluate(() => window.__app.areas());
check(
  "雨区面积统计可用（上一任务回归）",
  areaInfo.domainKm2 > 0 && areaInfo.rainTotalKm2 > 0,
  `domain=${areaInfo.domainKm2.toFixed(2)}km² rain=${areaInfo.rainTotalKm2.toFixed(3)}km²`,
);

check("无致命错误（shader/编译/未捕获异常）", fatal.length === 0, fatal.slice(0, 3).join(" | "));

await page.screenshot({ path: "test/verify_features2_shot.png" });
await page.close();
await browser.disconnect();

console.log(`\n结果：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  for (const f of failures) console.log("  ❌ " + f);
  process.exit(1);
}
console.log("ALL PASS");