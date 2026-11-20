/**
 * 山洪案例库回归（真 GPU CDP :9223）：
 *  - #btnCases 打开面板、卡片数 == CASES.length
 *  - 点卡片 → 详情含案例名
 *  - 点「▶ 一键复演」→ 模拟域/雨区建立、雨量模式参数生效、开始降雨、水面出现
 *  - __app.activeCase() / caseState() 一致、状态栏含案例名、无致命错误
 * 产物：test/verify_cases.json、test/cases_panel.png、test/cases_run.png
 *
 * 运行：node test/verify_cases.mjs
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
};

const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9223",
  defaultViewport: null,
  protocolTimeout: 600000,
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
page.on("pageerror", (e) => {
  const msg = String(e.message ?? e);
  if (!/ResizeObserver|WebGL context lost/.test(msg)) fatal.push(msg.slice(0, 300));
});
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (/Failed to load resource|CORS|net::ERR|404|tianditu/.test(t)) return;
  fatal.push(`CONSOLE: ${t.slice(0, 200)}`);
});

let exitCode = 0;
try {
  await page.goto("http://127.0.0.1:8931/index.html?cases=" + Date.now(), {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForFunction(() => window.__app?.ready === true, { timeout: 90000 });
  await page.bringToFront();

  const caseList = await page.evaluate(() => window.__app.cases());
  check("案例清单可见（4 条）", caseList.length === 4, caseList.map((c) => c.id).join(","));
  check(
    "清单含双石门/龙槽沟/大通",
    ["shuangshimen-50", "shuangshimen-150", "longcaogou-50", "datong-80"].every((id) =>
      caseList.some((c) => c.id === id),
    ),
  );

  // 打开面板
  await page.click("#btnCases");
  await page.waitForFunction(() => !document.getElementById("casePanel")?.hidden, { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 400));
  const cards = await page.$$eval("#caseList .case-card", (els) => els.length);
  check("点击「📚 案例库」打开面板", true);
  check("卡片数等于案例数", cards === caseList.length, `${cards} 张`);
  await page.screenshot({ path: "test/cases_panel.png" });

  // 选第二张卡（shuangshimen-150）
  await page.click('#caseList .case-card[data-case-id="shuangshimen-150"]');
  await new Promise((r) => setTimeout(r, 300));
  const detailText = await page.$eval("#caseDetail", (el) => el.innerText);
  check("点卡片显示详情", /双石门沟/.test(detailText) && /150 mm/.test(detailText), detailText.slice(0, 40));
  const btnRun = await page.$(".case-run");
  check("详情含「▶ 一键复演」按钮", !!btnRun);

  // 一键复演
  await btnRun.click();
  const loaded = await page
    .waitForFunction(() => !!window.__app.fluid && window.__app.activeCase() === "shuangshimen-150", {
      timeout: 150000,
      polling: 500,
    })
    .then(() => true)
    .catch(() => false);
  check("一键复演后进入案例模拟（activeCase 已设）", loaded, String(await page.evaluate(() => window.__app.activeCase())));

  const st = await page.evaluate(() => ({
    state: window.__app.caseState(),
    cfg: window.__app.rainfallConfig(),
    regions: window.__app.activeRegions(),
    areas: window.__app.areas(),
    status: window.__app.statusText(),
    domain: window.__app.hasDomain(),
  }));
  check("案例面板复演后自动关闭", st.state.open === false);
  check("模拟域已建立", st.domain === true, JSON.stringify(st.areas));
  check("雨区已建立且面积 > 0", st.regions > 0 && (st.areas.rainTotalKm2 ?? 0) > 0, JSON.stringify(st.areas));
  check(
    "雨量模式参数与案例一致",
    st.cfg.mode === "amount" && st.cfg.amountMm === 150 && st.cfg.durationSec === 60,
    `${st.cfg.mode}/${st.cfg.amountMm}mm/${st.cfg.durationSec}s`,
  );
  check("开始降雨已开启且目标质量 > 0", st.cfg.rainEnabled === true && (st.cfg.stats?.targetMass ?? 0) > 0, JSON.stringify(st.cfg.stats));
  check("状态栏显示案例名", /双石门沟/.test(st.status));

  // 用屏幕像素差分判定"水出现了"：先关降雨得到干净基线，再开降雨等水量积累
  await page.evaluate(async () => {
    window.__app.setRainEnabled(false);
    window.__snaps = {};
    window.__snap = (label) =>
      new Promise((resolve) => {
        const scene = window.__app.viewer.scene;
        const gl = scene.context._gl;
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const off = scene.postRender.addEventListener(() => {
          off();
          const buf = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          window.__snaps[label] = { w, h, buf };
          resolve(true);
        });
        scene.requestRender?.();
      });
    window.__diff = (a, b) => {
      const A = window.__snaps[a];
      const B = window.__snaps[b];
      if (!A || !B) return null;
      const n = A.w * A.h;
      let changed = 0;
      let blueB = 0;
      let blueA = 0;
      for (let i = 0; i < n; i++) {
        const r = B.buf[i * 4], g = B.buf[i * 4 + 1], bl = B.buf[i * 4 + 2];
        const dr = Math.abs(r - A.buf[i * 4]);
        const dg = Math.abs(g - A.buf[i * 4 + 1]);
        const db = Math.abs(bl - A.buf[i * 4 + 2]);
        if (dr + dg + db > 75) changed++;
        if (bl > 90 && bl > r + 15 && bl > g + 5) blueB++;
        const ar = A.buf[i * 4], ag = A.buf[i * 4 + 1], ab = A.buf[i * 4 + 2];
        if (ab > 90 && ab > ar + 15 && ab > ag + 5) blueA++;
      }
      return {
        diffPct: (changed / n) * 100,
        bluePctAfter: (blueB / n) * 100,
        bluePctBefore: (blueA / n) * 100,
      };
    };
    // 雨滴效果会改变大量像素，先关掉，保证差分只反映水面
    window.__app.setRainFx(false);
  });
  await page.evaluate(() => window.__app.setRainEnabled(false));
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => window.__snap("base"));
  await page.evaluate(() => window.__app.setRainEnabled(true));
  // 等注入量达到 ~40 mm（雨量模式 150mm/60s → 约 16 秒），水面才有明显覆盖
  const gotRain = await page
    .waitForFunction(
      () => (window.__app.rainfallConfig()?.stats?.injectedMm ?? 0) >= 40,
      { timeout: 120000, polling: 400 },
    )
    .then(() => true)
    .catch(() => false);
  check("降雨推进（注入 >= 40 mm）", gotRain, String(await page.evaluate(() => window.__app.rainfallConfig()?.stats?.injectedMm)));
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => window.__snap("wet"));
  const diff = await page.evaluate(() => window.__diff("base", "wet"));
  check(
    "水面出现（画面差分 > 0.15% 或蓝色像素增加 > 0.08%）",
    !!diff && (diff.diffPct > 0.15 || diff.bluePctAfter - diff.bluePctBefore > 0.08),
    JSON.stringify(diff),
  );
  await page.screenshot({ path: "test/cases_run.png" });
  check("无致命页面错误", fatal.length === 0, fatal.slice(0, 3).join(" | "));

  const summary = {
    cases: caseList.map((c) => c.id),
    state: st,
    diff,
    fatal,
    pass: results.filter((r) => r.ok).length,
    total: results.length,
  };
  fs.writeFileSync("test/verify_cases.json", JSON.stringify(summary, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} PASS`);
} catch (err) {
  exitCode = 1;
  console.error("TEST FAILED:", err.message);
  results.push({ name: "测试执行", ok: false, detail: err.message });
} finally {
  try {
    await page.close();
  } catch {}
  await browser.disconnect();
}
if (results.some((r) => !r.ok)) exitCode = 1;
process.exitCode = exitCode;