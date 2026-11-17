/**
 * fluid-sph 改造版冒烟测试（含「先划模拟域 → 再划雨区」流程）：
 *  1) 页面加载：Cesium 初始化、示例数据解析出覆盖范围，停在「请划定模拟域」
 *  2) 提交测试模拟域 → 生成域掩膜 → 启动流体 → 域掩膜纹理与开关就绪
 *  3) 上传合成 GeoTIFF（EPSG:4326）→ 自动解析范围 → 再划域 → 启动
 *  4) UTM 投影 GeoTIFF（EPSG:32650）→ 自动换算范围 → 再划域 → 启动
 *  5) 域内雨区成功 / 域外雨区被拒 → 开启降雨 → 注入量持续累加
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

const SAMPLE_EXTENT = [
  -119.5509508318, 37.7379837881, -119.4661638949, 37.8045600379,
];
const FIXTURE_BBOX = [116.2, 39.82, 116.44, 40.06];

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

  // ---------- Step1 加载：应停在「请划定模拟域」 ----------
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
  }));
  record("Cesium Viewer 已创建", step1.hasViewer);
  record(
    "示例数据覆盖范围解析正确",
    Array.isArray(step1.extent) &&
      step1.extent.length === 4 &&
      step1.extent.every((v, i) => Math.abs(v - SAMPLE_EXTENT[i]) < 1e-6),
    `extent=${JSON.stringify(step1.extent)}`,
  );
  record("上传后停在划定模拟域阶段（尚未启动模拟）", !step1.hasFluid && /划定模拟域|请划定/.test(step1.status), step1.status.replace(/\n/g, " | ").slice(0, 120));
  record("此时无模拟域", step1.hasDomain === false);

  // 提交矩形测试模拟域 → 启动模拟
  const dom1 = await page.evaluate(() => window.__app.commitTestDomain(0.12, 0.12));
  record("提交模拟域成功（域掩膜生成 + 域约束开启）", dom1.ok === true && dom1.hasMask === true && dom1.domainEnabled === true, JSON.stringify(dom1));
  const running1 = await page.evaluate(() => ({
    hasFluid: !!window.__app.fluid,
    hasDomain: window.__app.hasDomain(),
    status: window.__app.statusText(),
  }));
  record("模拟域提交后流体启动", running1.hasFluid && running1.hasDomain && /模拟进行中/.test(running1.status), running1.status.replace(/\n/g, " | ").slice(0, 100));

  await sleep(2500); // 渲染若干帧
  await page.screenshot({ path: path.join(DIR, "shot1_sample.png") });
  const errBeforeUpload = consoleErrors.filter((e) => /shader|webgl/i.test(e));
  record("无着色器编译错误(阶段1)", errBeforeUpload.length === 0, errBeforeUpload[0] ?? "");

  // ---------- Step2 GeoTIFF 上传（EPSG:4326） ----------
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

  // ---------- Step2b UTM 投影 GeoTIFF 上传（EPSG:32650）----------
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

  // ---------- Step3 雨区：域内成功 / 域外被拒 ----------
  console.log("→ 提交测试雨区并开启降雨…");
  // 域外雨区（uv 0.02~0.08，在域 [0.12,0.88] 之外）应被拒绝
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
  await sleep(2000);
  await page.screenshot({ path: path.join(DIR, "shot3_raining.png") });

  // 全域降雨切换（域外不注水由域掩膜保证）
  await page.evaluate(() => { document.getElementById("btnWholeRain").click(); });
  const wholeOn = await page.evaluate(() => window.__app.options.wholeAreaRain === true);
  record("全域降雨开关生效", wholeOn);
  await page.evaluate(() => { document.getElementById("btnWholeRain").click(); });

  await page.evaluate(() => { window.__app.options.rainEnabled = false; });
  const a = await page.evaluate(() => window.__app.injectedAmount());
  await sleep(1200);
  const b = await page.evaluate(() => window.__app.injectedAmount());
  record("停止降雨后注入停止增长", b - a < 0.002, `${a.toFixed(3)} -> ${b.toFixed(3)}`);

  // ---------- Step4 无地理参考 PNG 手动放置 ----------
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
      /Shader.*error|gl\w*Error|Failed to link|compile error/i.test(e),
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
