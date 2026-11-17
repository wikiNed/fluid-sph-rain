import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9222",
  defaultViewport: { width: 1500, height: 850 },
  protocolTimeout: 180000,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => {
  errors.push("PAGEERROR: " + (e.stack || e.message));
});
page.on("console", (m) => {
  if (m.type() === "error") errors.push("CONSOLE: " + m.text());
});

let pass = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
}

await page.goto("http://127.0.0.1:8931/index.html", {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForFunction(() => window.__app?.ready === true, { timeout: 60000 });
check("页面加载完成", true);

const init = await page.evaluate(() => ({
  status: window.__app.statusText(),
  hasFluid: !!window.__app.fluid,
  hasDomain: window.__app.hasDomain(),
  btnGlobe: !!document.getElementById("btnGlobe"),
  btnDomainDisabled: document.getElementById("btnDomain").disabled,
}));
check("默认进入全球地形模式", /全球地形模式/.test(init.status) && !init.hasFluid, init.status.slice(0, 90));
check("全球地形按钮存在", init.btnGlobe);
check("划域按钮默认可用", init.btnDomainDisabled === false);

// 全球模式：在 Tuolumne 区域画一个多边形，采样真实地形
await page.evaluate(() => {
  window.__app.options.globeSampleGrid = 32; // 测试用小网格加速
});
console.log("→ 全球模式提交模拟域（采样真实地形）…");
const t0 = Date.now();
const dom = await page.evaluate(() =>
  window.__app.commitGlobeDomain([-119.55, 37.74, -119.47, 37.80], [
    [0.08, 0.08], [0.92, 0.10], [0.95, 0.90], [0.50, 0.95], [0.05, 0.60],
  ]),
);
console.log(`  (耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s)`, JSON.stringify(dom));
check("全球模式划域成功并启动模拟", dom.ok && dom.hasMask && dom.domainEnabled, JSON.stringify(dom));
check("模拟域顶点=5", dom.vertices === 5, `vertices=${dom.vertices}`);
check(
  "模拟范围=所画多边形bbox",
  Math.abs(dom.extent[0] + 119.55) < 0.01 && Math.abs(dom.extent[2] + 119.47) < 0.01,
  `extent=${JSON.stringify(dom.extent)}`,
);
check("来源模式=globe", dom.sourceMode === "globe", dom.sourceMode);

const st = await page.evaluate(() => window.__app.statusText());
check("状态栏显示模拟进行中", /模拟进行中/.test(st), st.slice(0, 100));

// 全域降雨 → 注入累加
await page.evaluate(() => {
  window.__app.options.rainIntensity = 0.02;
  window.__app.options.rainEnabled = true;
  window.__app.options.wholeAreaRain = true;
});
await new Promise((r) => setTimeout(r, 4000));
const inj1 = await page.evaluate(() => window.__app.injectedAmount());
check("全域降雨注入累加", inj1 > 0, `injected=${inj1}`);

await page.screenshot({ path: "E:/DSH/FluidSim/fluid-sph/test/shot_globe_domain.png" });

// 切换回全球模式（重新划域）
await page.evaluate(() => window.__app.commitGlobeDomain([-119.55, 37.74, -119.47, 37.80]));
const dom2 = await page.evaluate(() => ({
  status: window.__app.statusText(),
  hasFluid: !!window.__app.fluid,
}));
check("可重新划域（全球模式再次提交）", dom2.hasFluid, dom2.status.slice(0, 60));

check("无致命控制台错误", errors.length === 0, errors.slice(0, 3).join(" | "));

console.log(`\n== 结果: ${pass === 12 ? "ALL PASS" : "FAIL"} (${pass}/12) ==`);
await browser.disconnect();
process.exit(pass === 12 ? 0 : 1);
