/**
 * fluid-sph 改造版冒烟测试（含「全球地形直接划域 → 域内降雨」新流程，以及上传高程图可选入口）：
 *  1) 页面加载：Cesium 初始化，默认进入全球地形模式（无 DEM/无流体）
 *  2) 全球模式画多边形 → 采样真实地形 → 生成域掩膜 → 启动流体
 *  3) 域内雨区成功 / 域外雨区被拒 → 降雨注入累加 / 停止后不增长
 *  4) 上传合成 GeoTIFF（EPSG:4326）→ 解析范围 → 划域 → 启动
 *  5) UTM 投影 GeoTIFF（EPSG:32650）→ 换算范围 → 划域 → 启动
 *  6) 无地理参考 PNG → 手动放置 → 划域 → 启动
 * 输出截图与 JSON 报告。
 */
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync } from "node:fs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CHROME =
  process.env.CHROME_PATH ??
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

const FIXTURE_BBOX = [116.2, 39.82, 116.44, 40.06];
const GLOBE_BBOX = [-119.55, 37.74, -119.47, 37.80]; // Tuolumne 山区，真实高程起伏大

const results = [];
const consoleErrors = [];
let failed = false;

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* keep waiting */
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`waitFor 超时: ${label}`);
    }
    await sleep(300);
  }
}

async function waitServer(url, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error("static server 未就绪");
    await sleep(250);
  }
}
await waitServer("http://127.0.0.1:8931/index.html");

let browser;
try {
  const versionUrl = "http://127.0.0.1:9222/json/version";
  {
    const t0 = Date.now();
    for (;;) {
      try {
        const r = await fetch(versionUrl);
        if (r.ok) break;
      } catch {}
      if (Date.now() - t0 > 30000) throw new Error("Chrome 调试端口未就绪");
      await sleep(300);
    }
  }
  browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: { width: 1500, height: 850 },
    protocolTimeout: 120000,
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) =>
    consoleErrors.push("PAGEERROR: " + String(e?.message ?? e)),
  );
  page.on("console", (m) => {
    const t = m.type();
    if (t === "error" || t === "warning") {
      consoleErrors.push(`${t.toUpperCase()}: ${m.text()}`);
    }
  });

  // ---------- Step1 加载：默认全球地形模式 ----------
  console.log("→ 打开页面…");
  await page.goto("http://127.0.0.1:8931/index.html", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await waitFor(
    () => page.evaluate(() => window.__app?.ready === true),
    60000,
    "__app.ready",
  ).catch(async () => {
    const err = await page.evaluate(() => window.__app?.initError);
    throw new Error(`初始化失败: ${err}`);
  });
  record("页面加载完成（__app.ready）", true);

  const step1 = await page.evaluate(() => ({
    hasViewer: !!window.__app.viewer,
    extent: window.__app.extent,
    hasFluid: !!window.__app.fluid,
    status: window.__app.statusText(),
    hasDomain: window.__app.hasDomain(),
    hasGlobeBtn: !!document.getElementById("btnGlobe"),
    domainBtnEnabled: document.getElementById("btnDomain")?.disabled === false,
  }));
  record("Cesium Viewer 已创建", step1.hasViewer);
  record("默认进入全球地形模式（尚未启动模拟）", /全球地形模式/.test(step1.status) && !step1.hasFluid, step1.status.replace(/\n/g, " | ").slice(0, 90));
  record("此时无模拟域/无覆盖范围", step1.hasDomain === false && !step1.extent);
  record("全球地形按钮存在且划域按钮可用", step1.hasGlobeBtn && step1.domainBtnEnabled);

  // ---------- Step2 全球模式划域 → 采样真实地形 → 启动 ----------
  console.log("→ 全球地形模式划域（采样真实高程）…");
  await page.evaluate(() => { window.__app.options.globeSampleGrid = 32; });
  const dom1 = await page.evaluate(() => window.__app.commitGlobeDomain(
    [-119.55, 37.74, -119.47, 37.80],
    [[0.08,0.08],[0.92,0.10],[0.95,0.90],[0.50,0.95],[0.05,0.60]],
  ));
  record("全球模式划域成功（真实地形采样 + 域掩膜 + 域约束）", dom1.ok === true && dom1.hasMask === true && dom1.domainEnabled === true, JSON.stringify(dom1));
  record("模拟域顶点=5（任意多边形）", dom1.vertices === 5, `vertices=${dom1.vertices}`);
  record("模拟范围=所画多边形bbox", Math.abs(dom1.extent[0] - GLOBE_BBOX[0]) < 0.02 && Math.abs(dom1.extent[3] - GLOBE_BBOX[3]) < 0.02, `extent=${dom1.extent?.map((v)=>+v.toFixed(3))}`);
  record("来源模式=globe", dom1.sourceMode === "globe", dom1.sourceMode);
  const running1 = await page.evaluate(() => ({
    hasFluid: !!window.__app.fluid,
    hasDomain: window.__app.hasDomain(),
    status: window.__app.statusText(),
  }));
  record("全球划域后流体启动", running1.hasFluid && running1.hasDomain && /模拟进行中/.test(running1.status), running1.status.replace(/\n/g, " | ").slice(0, 100));

  await sleep(2500);
  await page.screenshot({ path: path.join(DIR, "shot1_globe.png") });
  const errBeforeUpload = consoleErrors.filter((e) => /shader|webgl/i.test(e));
  record("无着色器编译错误(阶段1)", errBeforeUpload.length === 0, errBeforeUpload[0] ?? "");

  // ---------- Step3 雨区：域内成功 / 域外被拒 ----------
  console.log("→ 提交测试雨区并开启降雨…");
  const before = await page.evaluate(() => window.__app.activeRegions());
  await page.evaluate(() => window.__app.commitRegionUV([[0.02,0.02],[0.08,0.02],[0.08,0.08],[0.02,0.08]]));
  const afterOutside = await page.evaluate(() => window.__app.activeRegions());
  record("域外雨区被拒绝", afterOutside === before, `before=${before} after=${afterOutside}`);
  const reg = await page.evaluate(() => window.__app.commitTestRegion());
  record("域内降雨区域划定成功(活动数≥1)", reg.active >= 1 && reg.ok, JSON.stringify(reg));
  record("降雨掩膜纹理已生成", reg.hasMask === true);

  await page.evaluate(() => { window.__app.options.rainEnabled = true; });
  const injected = await waitFor(
    async () => {
      const v = await page.evaluate(() => window.__app.injectedAmount());
      return v > 0.05 ? v : false;
    },
    25000,
    "注入量>0.05",
  );
  record("降雨持续注入并累加", injected > 0.05, `累计=${injected.toFixed(3)}`);
  await page.screenshot({ path: path.join(DIR, "shot3_raining.png") });

  await page.evaluate(() => { document.getElementById("btnWholeRain").click(); });
  const wholeOn = await page.evaluate(() => window.__app.options.wholeAreaRain === true);
  record("全域降雨开关生效", wholeOn);
  await page.evaluate(() => { document.getElementById("btnWholeRain").click(); });
  await page.evaluate(() => { window.__app.options.rainEnabled = false; });
  const a = await page.evaluate(() => window.__app.injectedAmount());
  await sleep(1200);
  const b = await page.evaluate(() => window.__app.injectedAmount());
  record("停止降雨后注入停止增长", b - a < 0.002, `${a.toFixed(3)} -> ${b.toFixed(3)}`);

  // ---------- Step4 GeoTIFF 上传（EPSG:4326） ----------
  console.log("→ 上传合成 GeoTIFF…");
  const fileInput = await page.$("#fileInput");
  await fileInput.uploadFile(path.join(DIR, "fixture_dem.tif"));
  await waitFor(
    () => page.evaluate(() => window.__app.statusText().includes("请划定模拟域")),
    40000,
    "GeoTIFF 解析完成待划域",
  );
  const ext2 = await page.evaluate(() => window.__app.extent);
  const matchesFixture =
    Array.isArray(ext2) &&
    ext2.length === 4 &&
    ext2.every((v, i) => Math.abs(v - FIXTURE_BBOX[i]) < 1e-6);
  record("GeoTIFF 覆盖范围自动解析正确", matchesFixture, `extent=${JSON.stringify(ext2)}`);
  const statusText2 = await page.evaluate(() => window.__app.statusText());
  record("状态栏包含数据摘要信息", /EPSG/.test(statusText2) || /高程/.test(statusText2), statusText2.replace(/\n/g, " | ").slice(0, 140));
  await page.evaluate(() => window.__app.commitTestDomain(0.12, 0.12));
  await page.screenshot({ path: path.join(DIR, "shot2_geotiff.png") });

  // ---------- Step5 UTM 投影 GeoTIFF 上传（EPSG:32650）----------
  console.log("→ 上传 UTM 投影 GeoTIFF…");
  const fileInputUtm = await page.$("#fileInput");
  await fileInputUtm.uploadFile(path.join(DIR, "fixture_utm.tif"));
  await waitFor(
    () => page.evaluate(() => window.__app.statusText().includes("请划定模拟域")),
    40000,
    "UTM 解析完成待划域",
  );
  const ext2b = await page.evaluate(() => window.__app.extent);
  const utmMatches =
    Array.isArray(ext2b) &&
    ext2b.length === 4 &&
    ext2b.every((v, i) => Math.abs(v - FIXTURE_BBOX[i]) < 0.02);
  record("UTM 投影 GeoTIFF 自动换算范围正确", utmMatches, `extent=${JSON.stringify(ext2b.map((v) => +v.toFixed(4)))}`);
  const statusText2b = await page.evaluate(() => window.__app.statusText());
  record("状态栏标注 UTM 投影已换算", /32650|自动换算/.test(statusText2b), statusText2b.replace(/\n/g, " | ").slice(0, 140));
  await page.evaluate(() => window.__app.commitTestDomain(0.12, 0.12));
  await page.screenshot({ path: path.join(DIR, "shot2b_utm.png") });

  // ---------- Step6 无地理参考 PNG 手动放置 ----------
  console.log("→ 构造无边框 PNG 并走手动放置流程…");
  await page.evaluate(async () => {
    const S = 256;
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#101010";
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(40, 60, S - 80, S - 110);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "plain_height.png", { type: "image/png" }));
    const input = document.getElementById("fileInput");
    input.files = dt.files;
    input.dispatchEvent(new Event("change"));
  });
  await waitFor(
    () => page.evaluate(() => window.__app.statusText().includes("中心")),
    20000,
    "进入手动放置模式",
  );
  record("无参考图片触发手动放置提示", true);
  await page.evaluate(() => window.__app.testPlaceAt(110.0, 34.5));
  await waitFor(
    () => page.evaluate(() => window.__app.statusText().includes("请划定模拟域")),
    30000,
    "手动放置完成待划域",
  );
  const ext4 = await page.evaluate(() => window.__app.extent);
  const widthMeters = 10 * 1000;
  const expectedSpanLon =
    (widthMeters / (6378137 * Math.cos((34.5 * Math.PI) / 180))) * (180 / Math.PI);
  const lonSpanOk = Math.abs(ext4[2] - ext4[0] - expectedSpanLon) < 1e-5;
  const centerOk =
    Math.abs((ext4[0] + ext4[2]) / 2 - 110.0) < 1e-9 &&
    Math.abs((ext4[1] + ext4[3]) / 2 - 34.5) < 1e-6;
  record("手动放置范围按放置宽度计算", lonSpanOk && centerOk, `extent=${ext4.map((x) => x.toFixed(5))}`);
  await page.evaluate(() => window.__app.commitTestDomain(0.15, 0.15));
  await sleep(1800);
  await page.screenshot({ path: path.join(DIR, "shot4_placed.png") });

  // ---------- 汇总 ----------
  const fatalErrors = consoleErrors.filter(
    (e) =>
      /PAGEERROR/i.test(e) ||
      /Shader.*error|gl\w*Error|Failed to link|compile error|failed to compile|translation failed|Fragment shader failed|An error occurred while rendering/i.test(e),
  );
  record("无致命控制台错误", fatalErrors.length === 0, fatalErrors.slice(0, 3).join(" ; "));
} catch (err) {
  failed = true;
  record("测试执行中断", false, String(err?.message ?? err));
} finally {
  try {
    await browser?.disconnect();
  } catch {}
}

writeFileSync(path.join(DIR, "report.json"), JSON.stringify({ results }, null, 2));
console.log(failed ? "\n== 结果: FAIL ==" : "\n== 结果: ALL PASS ==");
process.exit(failed ? 1 : 0);
