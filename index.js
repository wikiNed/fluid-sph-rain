import {
  FluidComputeStage,
  FluidVolumeStage,
} from "./src/render/FluidPipelineStages.js";
import { createSimulationTexture } from "./src/render/simulationTexture.js";
import {
  sphKernelSource,
  particleIntegrationSource,
  particleSimulationSource,
  surfaceSmoothingSource,
  fluidVolumeFragmentSource,
} from "./src/sim/shaders.js";
import { loadElevationFile } from "./src/io/elevationLoader.js";
import { sampleTerrainDem } from "./src/io/terrainSampler.js";
import { RainRegionEditor } from "./src/ui/rainRegionEditor.js";
import { DomainEditor } from "./src/ui/domainEditor.js";
import { createRainEffect } from "./src/render/rainEffect.js";
import { createWaterSurface } from "./src/render/waterSurface.js";
import { CASES, getCase } from "./src/data/cases.js";
import { rasterizeRainMask } from "./src/sim/rainMask.js";
import { rasterizeDomainMask } from "./src/sim/domainMask.js";
import {
  rectangleAroundCenter,
  extentIsValid,
  extentAreaLabel,
  areaLabel,
  cellSizeMeters,
  precisionSummary,
} from "./src/sim/geoUtils.js";

// 当前代码来自[少年啦1997]的开源代码，如果你是购买源码，请联系商家进行退款
const Cesium = globalThis.Cesium;

/**
 * 可选：配置 Cesium Ion Token 后将叠加 Ion 影像底图；
 * 留空时自动使用 OpenStreetMap 免费底图，离线环境也可运行（无底图但不影响模拟）。
 */
const CESIUM_ION_TOKEN = "";

/** 内置示例数据（与原版一致）：加州 Tuolumne 一带 DEM 灰度图 */
const SAMPLE_CONFIG = {
  url: "./static/1722500831109.png",
  minElevation: 1207.798735464857,
  maxElevation: 3002.2227180334735,
  extent: [-119.5509508318, 37.7379837881, -119.4661638949, 37.8045600379],
};

/** 免 Token 的全球基础地形 / 卫星影像服务 */
const BASEMAP_SOURCES = {
  arcgisImagery:
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer",
  arcgisElevation:
    "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer",
  osm: "https://tile.openstreetmap.org/",
  // —— 公共参考图层（透明叠加，2026-11 实测不透明像素仅 3%~5%）——
  // 道路网：公路/县道/山路，带路名与编号盾牌
  arcgisTransport:
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer",
  // 地名标注：城市/村镇/山峰/河流/湖泊名 + 行政边界
  arcgisPlaces:
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer",
  // —— 中文标注（中国境内）——
  // 高德「路网 + 中文注记」叠加层：实测瓦片透明背景（不透明像素约 8%），
  // 可直接叠在卫星影像上；坐标系为 GCJ-02（火星坐标），与 WGS84 影像约有
  // 数百米偏移，仅作视觉参考。{s} 为 Cesium 的 subdomains 占位符。
  amapZhOverlay:
    "https://webst0{s}.is.autonavi.com/appmaptile?style=8&lang=zh_cn&size=1&scl=1&x={x}&y={y}&z={z}",
  // 天地图「中文注记」WMTS（cva）：WGS84/CGCS2000，与影像无偏移，但必须
  // 自带 tk（https://console.tianditu.gov.cn 免费申请），URL 里的 {tk}
  // 由代码用 options.tdtToken 替换。
  tiandituZhOverlay:
    "https://t{s}.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk={tk}",
};

const colorOptions = {
  shallowColor: "#48cae4",
  deepColor: "#023e8a",
};

/**
 * 5 档水深配色（sRGB，GUI 可改）。
 * 映射：<2m 浅蓝 → 2~5m 深蓝 → 5~10m 黄 → 10~20m 深黄 → >20m 红。
 * 分档依据是实测水深分布：默认雨强下 10s 中位数约 2.9m、20s 约 5.5m、
 * 35s 最大约 22m，正好覆盖这套档位（见开发记录 §5.10）。
 */
const depthColorOptions = {
  c0: "#7fd8ff", // 0 ~ 2 m  浅蓝
  c1: "#0a2f8f", // 2 ~ 5 m  深蓝
  c2: "#ffd400", // 5 ~ 10 m 黄
  c3: "#e0a800", // 10 ~ 20m 深黄
  c4: "#ff3b30", // > 20 m   红
};

/**
 * 5 档水深按「体积盒高度的百分比」分界（而不是固定米数）。
 * 水深着色与水体几何高度必须用同一把尺子：着色器里 waterDepth 是占体积盒高度的
 * 归一化比例，再乘以体积盒真实跨度得到米数，才能与眼睛里看到的水深一致。
 * 取 0.01% / 0.04% / 0.1% / 0.3%：1000 m 级山区体积盒上约 0.1 / 0.4 / 1.1 / 3.2 m，
 * 正好覆盖「几厘米面流 → 半米沟道积水 → 米级漫滩 → 数米深槽」的真实山洪水深范围；
 * 换到起伏 235 m 的小流域自动缩到 0.024 / 0.09 / 0.24 / 0.71 m。
 * 早期用过 0.2%/0.5%/1%/2%（≈2/5/10/20 m），真实雨量下（50 mm 只有 5 cm）所有水
 * 都挤在第一档，看起来“有水但永远浅蓝”。
 */
const DEPTH_BAND_FRACS = [0.0001, 0.0004, 0.001, 0.003];

/** 当前体积盒高程跨度（米），用于把水深比例换算成米 */
function currentBoxThicknessM() {
  const t = fluid?.volumeThickness?.();
  if (Number.isFinite(t) && t > 0) return t;
  const dem = state.currentDem;
  if (dem && Number.isFinite(dem.maxElevation) && Number.isFinite(dem.minElevation)) {
    return Math.max(1, dem.maxElevation - dem.minElevation);
  }
  return 1000;
}

/** 当前 5 档分界（米）：随体积盒高程跨度自动缩放，保留 3 位小数以适配厘米级水深 */
function currentDepthBands() {
  const thick = currentBoxThicknessM();
  return DEPTH_BAND_FRACS.map((f) => Math.max(0.02, +(f * thick).toFixed(3)));
}

/** 传给着色器的 vec3 uniform（sRGB 原值，着色器里再 gammaCorrect） */
const depthColorUniforms = {
  c0: new Cesium.Cartesian3(1, 1, 1),
  c1: new Cesium.Cartesian3(1, 1, 1),
  c2: new Cesium.Cartesian3(1, 1, 1),
  c3: new Cesium.Cartesian3(1, 1, 1),
  c4: new Cesium.Cartesian3(1, 1, 1),
};

function cssColorToUniform(css) {
  const c = Cesium.Color.fromCssColorString(css);
  return new Cesium.Cartesian3(c.red, c.green, c.blue);
}

function syncDepthColorUniforms() {
  depthColorUniforms.c0 = cssColorToUniform(depthColorOptions.c0);
  depthColorUniforms.c1 = cssColorToUniform(depthColorOptions.c1);
  depthColorUniforms.c2 = cssColorToUniform(depthColorOptions.c2);
  depthColorUniforms.c3 = cssColorToUniform(depthColorOptions.c3);
  depthColorUniforms.c4 = cssColorToUniform(depthColorOptions.c4);
  syncWaterSurface();
}

const options = {
  // —— 模拟参数（沿用原版）——
  waterAddRate: 0.03, // 点源注水速率
  waterSourceRadius: 0.05, // 点源半径(归一化)
  gravity: 4.5,
  initialWaterLevel: 0.0,
  depth: 180,
  shallow: Cesium.Color.fromCssColorString(colorOptions.shallowColor),
  deep: Cesium.Color.fromCssColorString(colorOptions.deepColor),
  // 水透明度滑块：0 = 完全不透明（alpha 1.0），1 = 最透明（alpha 0.2）。
  // 默认 0.2 对应 alpha≈0.84，与早期固定 0.85 的观感一致。
  waterAlpha: 0.2,

  // —— 新增：数据放置 ——
  placementWidthKm: 10.0, // 无地理参考图片的手动放置宽度
  reliefMeters: 600, // 无地理参考图片的地形起伏跨度(米)，盒子将贴合真实地表
  globeSampleGrid: 96, // 全球地形模式的采样网格边长（越大越精细但越慢，预设 96~512）

  // —— 新增：降雨控制 ——
  rainEnabled: false, // 降雨总开关
  rainIntensity: 0.0004, // 全局降雨强度（每子步每格注入质量；每秒注入 = 120 × 该值）
  // 降雨驱动模式：
  //   "intensity" = 强度模式（沿用原版：按雨强连续注入，雨不停水不停）
  //   "amount"    = 雨量模式（按「累计降雨量(mm) + 降雨历时(秒)」注入，
  //                 注满该场次总雨量后自动停止，可模拟 1mm~1000mm 的一场雨）
  rainMode: "intensity",
  rainAmountMm: 50, // 雨量模式：本场累计降雨量（毫米），范围 1~1000
  rainDurationSec: 120, // 雨量模式：降雨历时（秒，模拟时间），决定注入速率
  wholeAreaRain: false, // 是否全域降雨（不勾选则仅在雨区内）
  pointSource: false, // 点击点源注水（原版交互）

  // —— 新增：雨滴视觉效果（屏幕空间雨丝，纯视觉）——
  rainFx: true, // 降雨时是否显示下落的雨滴

  // —— 新增：5 档水深配色 ——
  depthColorEnabled: true, // 是否用 5 档水深配色替换默认浅水→深水渐变
  // 分档米数由体积盒高程跨度 × DEPTH_BAND_FRACS 自动推导，没有可调标定值了：
  // 真实水深与画面几何高度、配色米数是同一把尺子（见 §5.11）。

  // —— 新增：公共参考图层（叠加在卫星影像之上）——
  refRoads: true, // 道路网（含路名 / 公路编号）
  refPlaces: true, // 地名标注 + 行政边界

  // —— 新增：中文标注（中国境内）——
  refZhAmap: true, // 高德中文路网/地名叠加层（免 tk；GCJ-02 偏移，仅视觉参考）
  refTdtLabels: false, // 天地图中文注记叠加层（需 tk；CGCS2000 无偏移）
  tdtToken: "", // 天地图 tk，留空则不加天地图图层
};

/* ==================================================================== */
/* 全局状态                                                              */
/* ==================================================================== */

let viewer;
/** @type {TerrainFluidSimulation|null} */
let fluid = null;
/** @type {ReturnType<typeof createWaterSurface>|null} 贴地水体叠加层（地形遮挡天然正确） */
let waterSurface = null;
/** @type {RainRegionEditor} */
let regionEditor = null;
/** @type {DomainEditor} */
let domainEditor = null;

const state = {
  /** @type {[number,number,number,number]|null} 当前模拟范围 [minLon,minLat,maxLon,maxLat] */
  extent: null,
  demInfo: "尚未加载数据",
  /** 最近一次全球地形采样用的网格边长（用于精度显示） */
  lastSampleGrid: 0,
  /** 等待手动放置中心点的数据包 */
  pendingPlaceDem: null,
  /** 已解析但等待划定模拟域的数据包 */
  pendingDomainDem: null,
  /** 已提交的模拟域 {simPoly, cartos, label} */
  domain: null,
  /** 数据来源模式：'globe'=直接在当前全球地形上划域（默认）；'upload'=上传/示例/放置高程图 */
  sourceMode: "globe",
  drapeLayer: null,
  /** 模拟范围矩形/标签等 UI 实体，随模拟重建一起清理 */
  uiEntities: [],
  /** 当前模拟使用的高程数据包与域掩膜画布（供「重置模拟」从 0 重新开始） */
  currentDem: null,
  domainMaskCanvas: null,
  /** 雨滴屏幕空间后处理阶段（{stage,setEnabled,...}） */
  rainFx: null,
  /** 公共参考图层 [{layer, provider, key, label}]（道路网 / 地名标注） */
  refLayers: [],
  /** 中文标注图层 {amap, tdt, tdtTokenApplied} */
  zhLayers: { amap: null, tdt: null, tdtTokenApplied: "" },
};

const dom = {};

function $(id) {
  return document.getElementById(id);
}

function setStatus(html) {
  if (dom.statusBar) dom.statusBar.innerHTML = html;
}

/* ==================================================================== */
/* 初始化                                                                */
/* ==================================================================== */

/**
 * 公共参考图层：在底图影像之上叠加「道路网」与「地名标注」。
 *
 * 两个服务都是 ArcGIS Reference 系列，瓦片本身透明（实测不透明像素仅
 * 3%~5%），因此可以直接叠在卫星影像上而不遮挡地表；道路网自带路名与
 * 公路编号盾牌，地名标注带城市/村镇/山峰/河流名与行政边界。
 */
async function addReferenceLayers(messages) {
  const defs = [
    { key: "refRoads", label: "道路网", url: BASEMAP_SOURCES.arcgisTransport },
    { key: "refPlaces", label: "地名标注", url: BASEMAP_SOURCES.arcgisPlaces },
  ];
  state.refLayers = [];
  // 并行加载，且每个图层最多等 6 秒：网络抖动/被限流时不能阻塞场景就绪。
  // 超时后请求继续在后台进行，一旦返回仍会把图层加到影像栈里。
  await Promise.all(
    defs.map(
      (d) =>
        new Promise((resolve) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            console.warn(`${d.label}图层加载超时（后台继续）`);
            resolve(false);
          }, 6000);
          Cesium.ArcGisMapServerImageryProvider.fromUrl(d.url)
            .then((provider) => {
              const layer = viewer.imageryLayers.addImageryProvider(provider);
              layer.show = options[d.key] !== false;
              state.refLayers.push({ layer, key: d.key, label: d.label });
              messages.push(d.label);
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(true);
              }
            })
            .catch((err) => {
              console.warn(`${d.label}图层加载失败（不影响模拟）:`, err);
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(false);
              }
            });
        }),
    ),
  );
}

/** GUI 勾选变化 → 同步参考图层显隐 */
function syncRefLayers() {
  for (const r of state.refLayers) r.layer.show = options[r.key] !== false;
}

/* ---------------- 中文标注图层（高德 / 天地图）---------------- */

/** 高德中文叠加层：透明背景的路网 + 中文地名，免 tk，中国境内有效 */
function ensureAmapZhLayer() {
  if (!viewer) return null;
  if (state.zhLayers.amap) return state.zhLayers.amap;
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: BASEMAP_SOURCES.amapZhOverlay,
    subdomains: ["1", "2", "3", "4"],
    maximumLevel: 18,
    credit: "高德地图",
  });
  const layer = viewer.imageryLayers.addImageryProvider(provider);
  layer.show = false;
  state.zhLayers.amap = layer;
  return layer;
}

/** 天地图中文注记层：需要 tk（tk 变化时重建图层） */
function ensureTdtZhLayer() {
  if (!viewer) return null;
  const token = String(options.tdtToken || "").trim();
  if (!token) return null;
  if (state.zhLayers.tdt && state.zhLayers.tdtTokenApplied === token) {
    return state.zhLayers.tdt;
  }
  if (state.zhLayers.tdt) {
    try {
      viewer.imageryLayers.remove(state.zhLayers.tdt, true);
    } catch (err) {
      console.warn("移除旧天地图图层失败:", err);
    }
    state.zhLayers.tdt = null;
  }
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: BASEMAP_SOURCES.tiandituZhOverlay.replace(
      "{tk}",
      encodeURIComponent(token),
    ),
    subdomains: ["0", "1", "2", "3", "4", "5", "6", "7"],
    maximumLevel: 18,
    credit: "天地图",
  });
  const layer = viewer.imageryLayers.addImageryProvider(provider);
  layer.show = false;
  state.zhLayers.tdt = layer;
  state.zhLayers.tdtTokenApplied = token;
  return layer;
}

/** 把 options.refZhAmap / refTdtLabels / tdtToken 同步到中文标注图层 */
function syncZhLayers() {
  if (!viewer) return;
  const amap = ensureAmapZhLayer();
  if (amap) amap.show = options.refZhAmap !== false;
  const wantTdt = !!options.refTdtLabels;
  if (!wantTdt && !state.zhLayers.tdt) return;
  const tdt = ensureTdtZhLayer();
  if (tdt) {
    tdt.show = wantTdt;
  } else if (wantTdt) {
    setStatus("⚠ 天地图注记需要 tk：请到 console.tianditu.gov.cn 免费申请后填入「天地图 tk」");
  }
}

/**
 * 雨量模式的核心换算：把「累计降雨量(mm)」换算成每个格子需要注入的 SPH 质量。
 *
 * 推导（体积守恒，直接对真实水深，不再借助任何标定值）：
 *   - 着色器里 waterDepth（占体积盒高度的归一化比例）= data.x * heightScale(0.25)，
 *     地形上水柱的几何高度 = waterDepth × 体积盒高程跨度 T，即 1 个质量单位 = 0.25·T 米。
 *   - 雨区内每格面积都相同，均匀降雨 P 毫米后均匀水深就是 P/1000 米（与雨区多大无关：
 *     雨区面积按比例分到对应比例的格子数，两边约掉）。
 *   - 因此每格目标质量 data.x = P米 / (0.25·T) = P毫米 / (250·T)。
 *   - 于是「水深 × 面积」= 降雨量 × 雨区面积，画面水量与真实降雨体积一致；
 *     5 档配色也按同一个 T 缩放，颜色与真实水深一一对应。
 *
 * 旧实现把 T 写死成 depthFullM=40，导致真实水深被放大 27 倍（T≈1093 m 时），
 * 1.46 km² 上 50 mm 降雨（7.3 万 m³）被画成大片 5 m 深的积水 —— 物理上不可能。
 *
 * @param {number} thicknessM 当前体积盒的高程跨度（米）
 * @returns {number} 每 1mm 累计降雨量对应的每格质量增量
 */
function rainMassPerMm(thicknessM) {
  const t = Math.max(1, Number(thicknessM) || 0);
  return 1 / (250 * t);
}

/** 雨量模式：累计雨量 / 降雨历时 → 等效雨强（mm/h），用于雨丝密度与读数 */
function rainAmountRateMmH() {
  const mm = Math.max(0, Number(options.rainAmountMm) || 0);
  const dur = Math.max(1, Number(options.rainDurationSec) || 1);
  return (mm / dur) * 3600;
}

/** 当前雨量强度 → 0~1.25 的雨丝密度（雨强越大雨丝越密） */
function rainFxAmount() {
  if (!options.rainEnabled) return 0;
  const active = regionEditor ? regionEditor.getActiveRegions().length : 0;
  if (!options.wholeAreaRain && active === 0) return 0;
  if (options.rainMode === "amount") {
    // 等效雨强 10mm/h≈0.35 → 3000mm/h 以上≈1.25，按对数插值
    const rate = Math.max(1, rainAmountRateMmH());
    const k = Math.max(
      0,
      Math.min(1, Math.log(rate / 10) / Math.log(3000 / 10)),
    );
    return 0.35 + k * 0.9;
  }
  const k = Number(options.rainIntensity) / 0.0004; // 默认雨强 = 1.0
  const base = Number.isFinite(k) ? 0.35 + k * 0.45 : 0.7;
  return Math.min(1.25, Math.max(0.35, base));
}

/**
 * 每帧同步雨滴效果开关：只有「降雨总开关 + 雨滴效果都开」且
 * 存在启用的雨区（或勾选全域降雨）时才显示雨丝。
 */
function updateRainEffect() {
  if (!state.rainFx) return;
  const active = regionEditor ? regionEditor.getActiveRegions().length : 0;
  const raining =
    !!options.rainEnabled &&
    !!options.rainFx &&
    (options.wholeAreaRain || active > 0);
  state.rainFx.setEnabled(raining);
}

async function initViewer() {
  const baseOpts = {
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
  };

  const token = String(CESIUM_ION_TOKEN ?? "").trim();
  const layerMessages = [];

  if (token) {
    // 配置了 Ion Token：使用 Cesium Ion 底图 + Cesium World Terrain
    Cesium.Ion.defaultAccessToken = token;
    viewer = new Cesium.Viewer("cesiumContainer", { ...baseOpts });
    layerMessages.push("Ion 底图");
    try {
      viewer.terrainProvider = await Cesium.CesiumTerrainProvider.fromIonAssetId(
        1,
        { requestVertexNormals: true },
      );
      layerMessages.push("Cesium World Terrain");
    } catch (err) {
      console.warn("Ion 地形加载失败，退回椭球面:", err);
    }
  } else {
    // 免 Token：ArcGIS 卫星影像 + ArcGIS 全球地形（离线自动降级）
    viewer = new Cesium.Viewer("cesiumContainer", {
      ...baseOpts,
      baseLayer: false,
    });

    try {
      const imagery = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
        BASEMAP_SOURCES.arcgisImagery,
      );
      viewer.imageryLayers.addImageryProvider(imagery);
      layerMessages.push("ArcGIS 卫星影像");
    } catch (err) {
      console.warn("ArcGIS 影像加载失败，尝试 OSM:", err);
      try {
        const osm = await Cesium.OpenStreetMapImageryProvider.fromUrl(
          BASEMAP_SOURCES.osm,
        );
        viewer.imageryLayers.addImageryProvider(osm);
        layerMessages.push("OSM 底图");
      } catch (err2) {
        console.warn("在线底图均不可用（离线也可继续使用）:", err2);
        layerMessages.push("无底图(离线)");
      }
    }

    try {
      viewer.terrainProvider =
        await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(
          BASEMAP_SOURCES.arcgisElevation,
        );
      layerMessages.push("ArcGIS 全球地形");
    } catch (err) {
      console.warn("ArcGIS 地形加载失败，使用椭球面（不影响模拟）:", err);
      layerMessages.push("无地形");
    }
  }

  // 公共参考图层（道路网 + 地名标注）叠在底图之上
  await addReferenceLayers(layerMessages);
  // 中文标注（高德透明叠加层；天地图需 tk，未填则不加）
  syncZhLayers();

  const baseLayerMessage = layerMessages.join(" + ");

  viewer.scene.msaaSamples = 4;
  viewer.scene.highDynamicRange = true;
  viewer.postProcessStages.fxaa.enabled = true;
  viewer.scene.globe.depthTestAgainstTerrain = true;

  // 雨滴视觉效果（屏幕空间雨丝；是否显示由每帧 updateRainEffect 决定）
  state.rainFx = createRainEffect(viewer, { amount: rainFxAmount });
  viewer.scene.postRender.addEventListener(updateRainEffect);

  // 降雨区域编辑器（划定模拟域之后才允许绘制雨区）
  regionEditor = new RainRegionEditor(viewer, {
    onChange: () => {
      applyRainRegions();
      rebuildRegionGui();
      refreshButtons();
    },
    onStatus: (t) => setStatus(`<strong>绘制模式</strong><br>${t}`),
    onDrawingEnd: () => {
      dom.btnDraw?.classList.remove("active");
      refreshRainSummary();
    },
  });

  // 模拟域编辑器（默认全球地形模式：直接在全球地形上划域；上传高程图后限定在该范围内）
  domainEditor = new DomainEditor(viewer, {
    onChange: (domain) => {
      if (!domain) return;
      state.domain = domain;
      // 提交模拟域 → 生成掩膜 → 启动模拟（全球模式会先采样真实地形高程）
      onDomainCommitted(domain);
    },
    onStatus: (t) => setStatus(`<strong>划定模拟域</strong><br>${t}`),
    onDrawingEnd: () => {
      dom.btnDomain?.classList.remove("active");
    },
  });

  // 左键：点源注水（原版交互；绘制模式下让位给编辑器）
  viewer.screenSpaceEventHandler.setInputAction((movement) => {
    if (regionEditor.drawing || domainEditor?.drawing || state.pendingPlaceDem || state.pendingDomainDem) return;
    if (!state.extent) return;
    const carto = pickCartographic(movement.position);
    if (!carto) return;
    const lonlat = cartoToDegrees(carto);
    const e = state.extent;
    if (
      lonlat.lon < e[0] ||
      lonlat.lon > e[2] ||
      lonlat.lat < e[1] ||
      lonlat.lat > e[3]
    ) {
      setStatus("⚠ 点击位置在模拟范围之外");
      return;
    }
    if (!fluid) return;
    const u = (lonlat.lon - e[0]) / (e[2] - e[0]);
    const vShader = 1 - (lonlat.lat - e[1]) / (e[3] - e[1]);
    fluid.setWaterSource(new Cesium.Cartesian2(u, vShader));
    setStatus(`💧 已设置点源位置 (${u.toFixed(2)}, ${vShader.toFixed(2)})，勾选 GUI「点源注水」后生效`);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // 放置模式点击（一次性）
  viewer.screenSpaceEventHandler.setInputAction(async (movement) => {
    if (!state.pendingPlaceDem) return;
    const carto = pickCartographic(movement.position);
    if (!carto) return;
    const ll = cartoToDegrees(carto);
    await placePendingDemAtDegrees(ll.lon, ll.lat);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  wireToolbar();
  buildGui();
  buildCasePanel();
  syncDepthColorUniforms();
  updateDepthLegend();

  setStatus(
    `✅ 场景就绪（${baseLayerMessage}）。当前为<strong>全球地形模式</strong>：直接在地形上划一个区域即可开始模拟；也可「📂 上传高程图」使用自有 DEM。`,
  );

  // 默认进入「全球地形直接划域」模式：无需上传数据，打开即可用
  startGlobalDomainDraw();
}

/** 在 (lon,lat) 处放置待定位的高程数据并启动模拟（手动放置流程） */
async function placePendingDemAtDegrees(lon, lat) {
  if (!state.pendingPlaceDem) return;
  const dem = state.pendingPlaceDem;
  state.pendingPlaceDem = null;
  setStatus(
    `📐 已选择中心 (${lon.toFixed(4)}, ${lat.toFixed(4)})，正在采样地形高程…`,
  );

  const widthMeters = options.placementWidthKm * 1000;
  const aspect = dem.contentAspect > 0 ? dem.contentAspect : 1;
  dem.extent = rectangleAroundCenter(lon, lat, widthMeters, widthMeters / aspect);

  // 无地理参考图片：采样真实地形高程，让模拟体积盒贴合地表而非埋入地下
  if (dem.kind === "image" && viewer.terrainProvider) {
    try {
      const cartos = [
        Cesium.Cartographic.fromDegrees(lon, lat),
        Cesium.Cartographic.fromDegrees(
          (dem.extent[0] + dem.extent[2]) / 2,
          (dem.extent[1] + dem.extent[3]) / 2,
        ),
      ];
      const corners = dem.extent;
      cartos.push(
        Cesium.Cartographic.fromDegrees(corners[0], corners[1]),
        Cesium.Cartographic.fromDegrees(corners[2], corners[3]),
      );
      const updated = await Cesium.sampleTerrainMostDetailed(
        viewer.terrainProvider,
        cartos,
      );
      const heights = updated
        .map((c) => c.height ?? 0)
        .filter((h) => Number.isFinite(h));
      const hMax = Math.max(...heights, 0);
      dem.minElevation = Math.max(0, hMax - options.reliefMeters * 0.1);
      dem.maxElevation = hMax + options.reliefMeters * 0.9;
    } catch (err) {
      console.warn("地形高程采样失败，使用默认 0~1000m:", err);
    }
  }

  await prepareDomain(dem);
}

function cartoToDegrees(carto) {
  return {
    lon: Cesium.Math.toDegrees(carto.longitude),
    lat: Cesium.Math.toDegrees(carto.latitude),
  };
}

function pickCartographic(windowPos) {
  const scene = viewer.scene;
  try {
    const p = scene.pickPosition(windowPos);
    if (p) return Cesium.Cartographic.fromCartesian(p);
  } catch (e) {
    /* ignore */
  }
  const ray = viewer.camera.getPickRay(windowPos);
  if (!ray) return null;
  const p = scene.globe.pick(ray, scene);
  return p ? Cesium.Cartographic.fromCartesian(p) : null;
}

/* ==================================================================== */
/* 数据上传 / 示例加载                                                    */
/* ==================================================================== */

async function handleUploadFile(file) {
  if (!file) return;
  setStatus(`⏳ 正在解析 ${file.name} …`);
  try {
    const dem = await loadElevationFile(file);
    if (dem.extent && extentIsValid(dem.extent)) {
      await prepareDomain(dem);
    } else {
      // 无地理参考：先进入手动放置流程，放置完成后再进入划域阶段
      state.pendingPlaceDem = dem;
      setStatus(
        `📋 <strong>${dem.sourceName}</strong><br>${dem.info}<br>` +
          `<strong>请在底图上单击一点作为高程图中心</strong>（可用 GUI 调整放置宽度 km）；` +
          `放置后划定模拟域。`,
      );
    }
  } catch (err) {
    console.error(err);
    setStatus(`❌ 解析失败：${err.message}`);
  }
}

/**
 * 全球地形模式：直接用当前加载的真实地形（ArcGIS/Cesium）作为数据源。
 * 无需上传高程图 —— 用户划域后，系统采样该多边形 bbox 内的真实高程构建 DEM。
 */
function startGlobalDomainDraw() {
  teardownSimulation(true);
  state.sourceMode = "globe";
  state.pendingDomainDem = null;
  state.demInfo = "全球真实地形（ArcGIS / Cesium）";

  // 全球模式不飞相机、不叠置 DEM，用户就在当前视野里画多边形
  domainEditor.startDrawing(null); // null → 自由绘制，提交时由 bbox 反推 extent
  dom.btnDomain?.classList.add("active");
  refreshButtons();

  const provider = viewer.terrainProvider;
  const pname = provider
    ? provider.constructor?.name || (provider.ready ? "地形服务" : "地形服务")
    : "椭球面";
  setStatus(
    `🌐 <strong>全球地形模式</strong><br>当前地形：<strong>${pname}</strong><br>` +
      `左键在地形上任意位置添加顶点，右键 / 双击 / 回车闭合（至少 3 点），Esc 取消。<br>` +
      `提交后自动采样该区域的真实高程并启动模拟（也可用「📂 上传高程图」改用自有数据）。`,
  );
}

/**
 * 高程数据就绪后：显示 DEM 叠置，等待用户划定模拟域，再启动模拟。
 * 模拟域为高程图覆盖范围内的任意多边形。
 */
async function prepareDomain(dem) {
  if (!extentIsValid(dem.extent)) {
    setStatus("❌ 覆盖范围无效，无法划定模拟域");
    return;
  }
  // 换数据时重建模拟环境（清空旧流体/雨区/域）
  teardownSimulation(true);
  state.sourceMode = "upload";
  state.extent = dem.extent;
  state.demInfo = `${dem.sourceName}: ${dem.info}`;
  state.pendingDomainDem = dem;

  const rect = Cesium.Rectangle.fromDegrees(...dem.extent);
  viewer.camera.flyTo({ destination: rect, duration: 1.2 });

  addDrapeLayer(dem, rect);
  addRangeOutline(rect, dem);

  // 自动进入模拟域绘制模式
  domainEditor.startDrawing(dem.extent);
  dom.btnDomain?.classList.add("active");
  refreshButtons();

  setStatus(
    `🗺 <strong>请划定模拟域</strong><br>数据：${dem.sourceName} · ${dem.info}<br>` +
      `覆盖范围：${extentAreaLabel(dem.extent)}<br>` +
      `左键在高程图覆盖范围内添加顶点，右键 / 双击 / 回车闭合（至少 3 点）；Esc 取消。`,
  );
}

/** 模拟域提交 → （全球模式先采样真实地形）→ 生成域掩膜 → 启动 SPH 模拟 */
async function onDomainCommitted(domain) {
  let dem = state.pendingDomainDem;
  state.pendingDomainDem = null;

  if (!dem) {
    // 全球地形模式：采样所画多边形 bbox 内的真实高程，构建 1024² DEM
    const extent = domain.extent;
    if (!extent || !extentIsValid(extent)) {
      setStatus("❌ 模拟域范围无效，无法采样地形");
      return;
    }
    setStatus("⏳ 正在采样模拟域内的真实地形高程，请稍候…");
    try {
      const sampled = await sampleTerrainDem(
        viewer.terrainProvider,
        extent,
        options.globeSampleGrid,
      );
      const rect = Cesium.Rectangle.fromDegrees(...extent);
      const cell = cellSizeMeters(extent, sampled.gridN);
      const simCell = cellSizeMeters(extent, 1024);
      state.lastSampleGrid = sampled.gridN;
      const fmtM = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
      dem = {
        kind: "globe",
        sourceName: "全球地形采样",
        canvas: sampled.canvas,
        minElevation: sampled.minElevation,
        maxElevation: sampled.maxElevation,
        extent: [...extent],
        contentAspect: (Math.cos(Cesium.Math.toRadians((extent[1] + extent[3]) / 2)) * (extent[2] - extent[0])) / (extent[3] - extent[1]),
        info: `全球真实地形 · ${sampled.valid}/${sampled.samples} 网格点（${sampled.gridN}×${sampled.gridN}，间距 ${fmtM(cell.x)}×${fmtM(cell.y)} m；模拟格 ${fmtM(simCell.x)}×${fmtM(simCell.y)} m）${sampled.flat ? " · 区域较平坦" : ""}`,
      };
      addRangeOutline(rect, dem);
      // 飞到所画区域（留出边距，带俯角，便于观察地表汇流）
      viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(
          extent[0] - (extent[2] - extent[0]) * 0.4,
          extent[1] - (extent[3] - extent[1]) * 0.4,
          extent[2] + (extent[2] - extent[0]) * 0.4,
          extent[3] + (extent[3] - extent[1]) * 0.4,
        ),
        orientation: {
          heading: 0,
          pitch: Cesium.Math.toRadians(-55),
          roll: 0,
        },
        duration: 1.5,
      });
    } catch (err) {
      console.error(err);
      setStatus(`❌ 地形采样失败：${err.message}`);
      return;
    }
  }

  // 域掩膜：约束物理边界、渲染裁剪、全域降雨范围
  const domainMaskCanvas = rasterizeDomainMask(domain.simPoly);
  // 雨区编辑器同步域多边形：之后绘制的雨区必须在域内
  regionEditor.setDomain(domain.simPoly);

  finishStart(dem, domainMaskCanvas);
}

async function loadSample() {
  const image = await Cesium.Resource.fetchImage({ url: SAMPLE_CONFIG.url });
  const S = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  canvas.getContext("2d").drawImage(image, 0, 0, S, S);
  const dem = {
    kind: "geotiff",
    sourceName: "示例 Tuolumne DEM",
    canvas,
    minElevation: SAMPLE_CONFIG.minElevation,
    maxElevation: SAMPLE_CONFIG.maxElevation,
    extent: [...SAMPLE_CONFIG.extent],
    contentAspect: 1,
    info: "内置示例 · 高程已归一化",
  };
  await prepareDomain(dem);
}

/* ==================================================================== */
/* 模拟生命周期                                                          */
/* ==================================================================== */

function teardownSimulation(alsoClearEntities) {
  if (waterSurface) {
    waterSurface.destroy();
    waterSurface = null;
  }
  if (fluid) {
    fluid.destroy();
    fluid = null;
  }
  regionEditor?.stopDrawing();
  if (alsoClearEntities) regionEditor?.clearAll();
  regionEditor?.setDomain(null);
  domainEditor?.stopDrawing();
  if (alsoClearEntities) domainEditor?.clearDomain(false);
  state.domain = null;
  state.pendingDomainDem = null;
  if (state.drapeLayer) {
    viewer.imageryLayers.remove(state.drapeLayer, true);
    state.drapeLayer = null;
  }
  for (const e of state.uiEntities ?? []) {
    viewer.entities.remove(e);
  }
  state.uiEntities = [];
  rainProgress.injected = "0.000";
  rainProgress.total = "0.0";
  state.extent = null;
  state.currentDem = null;
  state.domainMaskCanvas = null;
  refreshButtons();
}

/**
 * 创建/重建「贴地水体叠加层」。
 *
 * 水体不再由体积盒光线步进绘制：盒内是 1024² 平滑高度场，和真实地形差米级，
 * 而真实雨量下水深只有厘米级 —— 水面要么悬空（游动的贴花），要么被地形判掉。
 * 改用 Cesium 贴地多边形（GroundPrimitive）绘制，遮挡与起伏交给引擎，
 * 材质只按水面纹理取水深着色。
 */
function mountWaterSurface() {
  // 贴地多边形叠加层的方案已经验证不可行：GroundPrimitive / 贴地实体不提供
  // 可用的 materialInput.st（实测恒为常量），无法按水深取色；因此水体仍由
  // 体积阶段的湿膜渲染绘制，这里只确保它处于显示状态。
  if (waterSurface) {
    waterSurface.destroy();
    waterSurface = null;
  }
  const volumeStage = fluid?._stages?.[4];
  if (volumeStage) volumeStage.show = true;
}

/** 把 GUI/参数的改动同步到水体叠加层（分档、颜色、透明度、盒跨度）。 */
function syncWaterSurface() {
  if (!waterSurface) return;
  waterSurface.update({
    thicknessM: currentBoxThicknessM(),
    bands: currentDepthBands(),
    colors: [
      depthColorOptions.c0,
      depthColorOptions.c1,
      depthColorOptions.c2,
      depthColorOptions.c3,
      depthColorOptions.c4,
    ],
    waterAlpha: options.waterAlpha,
  });
}

async function finishStart(dem, domainMaskCanvas) {
  if (!extentIsValid(dem.extent)) {
    setStatus("❌ 覆盖范围无效，无法开始模拟");
    return;
  }
  state.extent = dem.extent;
  state.demInfo = `${dem.sourceName}: ${dem.info}`;
  // 记录当前模拟的输入，供「重置模拟」在不重新采样的前提下从 0 重跑
  state.currentDem = dem;
  state.domainMaskCanvas = domainMaskCanvas;

  const rect = Cesium.Rectangle.fromDegrees(...dem.extent);

  fluid = new TerrainFluidSimulation(viewer, dem, options);
  fluid.setDomainMask(domainMaskCanvas, !!state.domain);
  mountWaterSurface(); // 水体改为贴地多边形绘制（遮挡由地形决定）
  updateDepthLegend(); // 体积盒跨度建立后才能把 5 档分界换算成正确米数

  rebuildRegionGui();
  applyRainRegions(); // 应用已有雨区（清空后为无雨）
  refreshButtons();

  const activeRain = regionEditor.getActiveRegions();
  const nRain = activeRain.length;
  const rainArea = activeRain.reduce((s, r) => s + (r.areaKm2 || 0), 0);
  const domainLabel = state.domain
    ? `模拟域顶点 ${state.domain.simPoly.length} 个 · 面积 <strong>${areaLabel(
        state.domain.areaKm2,
      )}</strong>`
    : "无模拟域";
  const rainLabel = nRain
    ? `雨区数量：<strong>${nRain}</strong>（合计面积 ${areaLabel(rainArea)}）`
    : `雨区数量：<strong>0</strong>`;
  const rainModeLabel =
    options.rainMode === "amount"
      ? `降雨：雨量模式 · 累计 <strong>${options.rainAmountMm} mm</strong> / 历时 ${options.rainDurationSec}s（≈${rainAmountRateMmH().toFixed(0)} mm/h，注满自动停）`
      : `降雨：强度模式 · 雨强 ${options.rainIntensity}`;
  setStatus(
    `🌊 <strong>模拟进行中</strong><br>数据：${dem.sourceName} · ${dem.info}<br>` +
      `范围：${extentAreaLabel(dem.extent)}<br>${domainLabel} · ${rainLabel}<br>${rainModeLabel}<br>` +
      `提示：「🌧 绘制降雨区域」左键加点 / 右键结束（雨区须在橙色模拟域内）；GUI 中可开启全域降雨或切换降雨模式；「🧹 重置模拟」可清空水量从 0 重跑。`,
  );
}

/**
 * 清空模拟状态、从 0 重新开始模拟。
 *
 * 保留：已划定的模拟域、已画的降雨区域、相机视角、当前高程数据；
 * 重置：粒子质量/水量、累计注入量、帧计数（通过重建 TerrainFluidSimulation 实例）。
 * 相比「🌐 全球地形」需要重新采样地形、重新划域，这里可以一键反复试算同一场景。
 */
function restartSimulation() {
  if (!fluid) {
    setStatus("⚠ 当前没有进行中的模拟：请先划定模拟域");
    return;
  }
  const dem = state.currentDem;
  if (!dem || !extentIsValid(dem.extent)) {
    setStatus("❌ 缺少高程数据，无法重置模拟");
    return;
  }
  fluid.destroy();
  fluid = null;
  if (waterSurface) {
    waterSurface.destroy();
    waterSurface = null;
  }
  rainProgress.injected = "0.000";
  rainProgress.total = "0.0";
  rainProgress.mm = "0.0";

  fluid = new TerrainFluidSimulation(viewer, dem, options);
  fluid.setDomainMask(state.domainMaskCanvas, !!state.domain);
  mountWaterSurface();
  updateDepthLegend();
  applyRainRegions(); // 雨区与降雨开关保持不变，重新开始累计
  refreshButtons();

  const nRain = regionEditor.getActiveRegions().length;
  const domainLabel = state.domain
    ? `模拟域面积 <strong>${areaLabel(state.domain.areaKm2)}</strong>`
    : "无模拟域";
  setStatus(
    `🧹 <strong>已清空模拟状态，从 0 重新开始</strong><br>` +
      `数据：${dem.sourceName} · ${dem.info}<br>${domainLabel} · 雨区数量：${nRain}<br>` +
      `提示：降雨开关与雨区保持不变，水量已归零；再次「开始降雨」即可重新累计。`,
  );
}

/** 把 DEM 以影像形式叠置到其覆盖范围上（对应区域的范围可视化） */
async function addDrapeLayer(dem, rect) {
  const url = dem.canvas.toDataURL("image/png");
  let provider;
  try {
    provider = await Cesium.SingleTileImageryProvider.fromUrl(url, {
      rectangle: rect,
      credit: "DEM",
    });
  } catch (e) {
    provider = new Cesium.SingleTileImageryProvider({
      url,
      tileWidth: dem.canvas.width,
      tileHeight: dem.canvas.height,
      rectangle: rect,
      credit: "DEM",
    });
  }
  try {
    const layer = viewer.imageryLayers.addImageryProvider(provider);
    layer.alpha = 0.92;
    state.drapeLayer = layer;
    return layer;
  } catch (err) {
    console.warn("DEM 叠置失败（不影响模拟）:", err);
    return null;
  }
}

/** 模拟范围黄框 + 标签（随真实地形抬升/贴地） */
function addRangeOutline(rect, dem) {
  const center = Cesium.Rectangle.center(rect);
  state.uiEntities = [];
  state.uiEntities.push(
    viewer.entities.add({
      name: "模拟范围",
      rectangle: {
        coordinates: rect,
        fill: false,
        outline: true,
        outlineColor: Cesium.Color.YELLOW.withAlpha(0.9),
        height: 150,
        heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
      },
    }),
    viewer.entities.add({
      name: "模拟范围标签",
      position: Cesium.Cartesian3.fromRadians(
        center.longitude,
        center.latitude,
        0,
      ),
      label: {
        text: `模拟范围\n${extentAreaLabel(dem.extent)}\n高程 ${Math.round(
          dem.minElevation,
        )}~${Math.round(dem.maxElevation)} m`,
        font: "13px sans-serif",
        fillColor: Cesium.Color.YELLOW,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        // 上移多一些，避免与「模拟域 · 面积」标签（-20px）在重心位置重叠
        pixelOffset: new Cesium.Cartesian2(0, -64),
      },
    }),
  );
}

/* ==================================================================== */
/* 降雨区域 → 掩膜 → 流体                                                */
/* ==================================================================== */

function applyRainRegions() {
  if (!fluid || !regionEditor) return;
  const active = regionEditor.getActiveRegions();
  const whole = options.wholeAreaRain;
  const canvas =
    active.length > 0 || whole
      ? rasterizeRainMask(active, whole)
      : null;
  fluid.setRainMask(canvas);
  // 雨区/全域降雨变化后，雨量模式的「本场累计」从 0 重新开始（已注入的水量不撤销）
  if (options.rainMode === "amount") resetRainfallEvent();
}

function toggleWholeRain(on) {
  options.wholeAreaRain = !!on;
  dom.btnWholeRain.classList.toggle("danger-active", options.wholeAreaRain);
  applyRainRegions();
  setStatus(options.wholeAreaRain ? "☁️ 全域降雨已开启" : "☁️ 全域降雨已关闭");
}

/* ==================================================================== */
/* 工具栏 / GUI                                                          */
/* ==================================================================== */

function wireToolbar() {
  dom.btnUpload = $("btnUpload");
  dom.btnGlobe = $("btnGlobe");
  dom.btnCases = $("btnCases");
  dom.btnDomain = $("btnDomain");
  dom.btnDraw = $("btnDraw");
  dom.btnWholeRain = $("btnWholeRain");
  dom.btnClearRegions = $("btnClearRegions");
  dom.btnReset = $("btnReset");
  dom.fileInput = $("fileInput");
  dom.statusBar = $("statusBar");
  dom.depthLegend = $("depthLegend");

  dom.btnGlobe?.addEventListener("click", () => startGlobalDomainDraw());

  dom.btnUpload.addEventListener("click", () => dom.fileInput.click());
  dom.fileInput.addEventListener("change", () => {
    const f = dom.fileInput.files?.[0];
    dom.fileInput.value = "";
    handleUploadFile(f);
  });

  dom.btnDomain.addEventListener("click", () => {
    if (domainEditor?.drawing) return;
    // 互斥：进入划域前结束雨区绘制，避免两个编辑器同时抢 canvas 点击
    if (regionEditor?.drawing) {
      regionEditor.stopDrawing();
      dom.btnDraw?.classList.remove("active");
    }
    if (state.sourceMode === "globe" || !state.pendingDomainDem) {
      startGlobalDomainDraw();
    } else {
      domainEditor.startDrawing(state.pendingDomainDem.extent);
      dom.btnDomain.classList.add("active");
      setStatus("🗺 请在高程图覆盖范围内划定模拟域：左键加点 / 右键或回车闭合");
    }
  });

  dom.btnDraw.addEventListener("click", () => {
    if (!state.extent) return;
    if (regionEditor.drawing) {
      regionEditor.stopDrawing();
      dom.btnDraw.classList.remove("active");
      setStatus(`🌊 模拟进行中<br>${state.demInfo}`);
    } else {
      // 互斥：进入画雨区前必须结束模拟域绘制，否则模拟域编辑器仍在
      // canvas 上接收左键，雨区顶点会被同时记成新模拟域并覆盖旧域。
      if (domainEditor?.drawing) domainEditor.stopDrawing();
      regionEditor.startDrawing(state.extent);
      dom.btnDraw.classList.add("active");
    }
  });

  dom.btnWholeRain.addEventListener("click", () =>
    toggleWholeRain(!options.wholeAreaRain),
  );

  dom.btnClearRegions.addEventListener("click", () => {
    regionEditor.clearAll();
  });

  // 清空模拟状态：保留模拟域与雨区，水量/累计注入/帧计数全部归零
  dom.btnReset?.addEventListener("click", () => restartSimulation());

  refreshButtons();
}

function refreshButtons() {
  const hasSim = !!state.extent && !!fluid;
  // 全球模式或已上传数据时都允许划域（全球模式下 btnDomain 始终可用）
  const canDrawDomain = state.sourceMode === "globe" || !!state.pendingDomainDem;
  if (dom.btnDomain) dom.btnDomain.disabled = !canDrawDomain;
  if (!dom.btnDraw) return;
  dom.btnDraw.disabled = !hasSim;
  dom.btnWholeRain.disabled = !hasSim;
  dom.btnClearRegions.disabled = !(regionEditor && regionEditor.allRegions().length > 0);
  if (dom.btnReset) dom.btnReset.disabled = !hasSim;
}

/* ==================================================================== */
/* 山洪案例库                                                            */
/* ==================================================================== */

/** 当前选中的案例（面板）与正在复演的案例 */
let caseSelectedId = null;
let activeCaseId = null;
let caseBusy = false;
const caseDom = {};

function buildCasePanel() {
  caseDom.panel = $("casePanel");
  caseDom.list = $("caseList");
  caseDom.detail = $("caseDetail");
  caseDom.close = $("caseClose");
  caseDom.btn = dom.btnCases;
  if (!caseDom.panel || !caseDom.list || !caseDom.detail) return;

  renderCaseList();
  caseDom.btn?.addEventListener("click", () => {
    if (caseDom.panel.hidden) openCasePanel();
    else closeCasePanel();
  });
  caseDom.close?.addEventListener("click", closeCasePanel);
  caseDom.panel.addEventListener("click", (e) => {
    if (e.target === caseDom.panel) closeCasePanel();
  });
}

function openCasePanel() {
  if (!caseDom.panel) return;
  caseDom.panel.hidden = false;
  if (!caseSelectedId) selectCaseCard(CASES[0]?.id ?? null);
  else selectCaseCard(caseSelectedId);
}

function closeCasePanel() {
  if (caseDom.panel) caseDom.panel.hidden = true;
}

/** 左侧案例卡片列表 */
function renderCaseList() {
  caseDom.list.innerHTML = "";
  for (const c of CASES) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "case-card";
    card.dataset.caseId = c.id;
    const name = document.createElement("div");
    name.className = "cc-name";
    name.textContent = c.name;
    const meta = document.createElement("div");
    meta.className = "cc-meta";
    meta.innerHTML = `<span>${c.site}</span><span>${c.date}</span><span class="cc-badge">${c.scenario}</span>`;
    card.appendChild(name);
    card.appendChild(meta);
    card.addEventListener("click", () => selectCaseCard(c.id));
    caseDom.list.appendChild(card);
  }
}

/** 选中案例：高亮卡片 + 渲染右侧详情 */
function selectCaseCard(id) {
  const c = getCase(id);
  if (!c) return;
  caseSelectedId = id;
  for (const el of caseDom.list.querySelectorAll(".case-card")) {
    el.classList.toggle("selected", el.dataset.caseId === id);
  }
  renderCaseDetail(c);
}

function renderCaseDetail(c) {
  const el = caseDom.detail;
  el.innerHTML = "";
  const h = document.createElement("h2");
  h.textContent = c.name;
  const site = document.createElement("div");
  site.className = "cd-site";
  site.textContent = `${c.site} · ${c.date} · 情景：${c.scenario}`;
  el.appendChild(h);
  el.appendChild(site);

  const facts = document.createElement("div");
  facts.className = "cd-facts";
  for (const chip of [
    `等级：${c.severity}`,
    `伤亡：${c.loss}`,
    `雨量：${c.mm} mm / ${c.dur} s`,
    `复演范围：${((c.extent[2] - c.extent[0]) * 111 * Math.cos((c.extent[1] * Math.PI) / 180)).toFixed(1)} km × ${((c.extent[3] - c.extent[1]) * 111).toFixed(1)} km`,
  ]) {
    const s = document.createElement("span");
    s.className = "cd-chip" + (chip.startsWith("伤亡") ? " hot" : "");
    s.textContent = chip;
    facts.appendChild(s);
  }
  el.appendChild(facts);

  const addBlock = (title, text) => {
    const t = document.createElement("h3");
    t.textContent = title;
    const p = document.createElement("p");
    p.textContent = text;
    el.appendChild(t);
    el.appendChild(p);
  };
  addBlock("事件概况", c.summary);
  addBlock("模拟假设与预期", c.mechanism);

  const src = document.createElement("div");
  src.className = "cd-src";
  const st = document.createElement("h3");
  st.textContent = "资料来源";
  src.appendChild(st);
  for (const s of c.sources) {
    const a = document.createElement("a");
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = s.label;
    src.appendChild(a);
    src.appendChild(document.createTextNode("　"));
  }
  el.appendChild(src);

  const actions = document.createElement("div");
  actions.className = "cd-actions";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "case-run";
  btn.textContent = "▶ 一键复演";
  btn.disabled = caseBusy;
  btn.addEventListener("click", () => runCase(c.id));
  const hint = document.createElement("span");
  hint.className = "cd-hint";
  hint.textContent = "复演将重置当前模拟，按案例参数采样地形、划域、划雨区并开始降雨。";
  actions.appendChild(btn);
  actions.appendChild(hint);
  el.appendChild(actions);
  caseDom.runBtn = btn;
}

const caseSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 一键复演：teardown → 全球地形采样划域 → 划雨区 → 雨量模式 → 机位 → 开始降雨。
 * 全过程复用现有主流程（与手工操作完全一致），因此 UI、图例、统计都会正常刷新。
 */
async function runCase(id) {
  const c = getCase(id);
  if (!c || caseBusy) return { ok: false, reason: caseBusy ? "busy" : "unknown-case" };
  caseBusy = true;
  if (caseDom.runBtn) {
    caseDom.runBtn.disabled = true;
    caseDom.runBtn.textContent = "⏳ 复演中…";
  }
  closeCasePanel();
  try {
    teardownSimulation(true);
    setStatus(
      `📚 <strong>正在载入案例：${c.name}</strong><br>${c.site} · ${c.date} · 情景 ${c.scenario}<br>正在采样真实地形并划定模拟域…`,
    );

    // 1) 模拟域：在全球地形上按 uv 多边形提交，内部会用采样地形启动 SPH
    if (!domainEditor) return { ok: false, reason: "not-ready" };
    domainEditor.startDrawing(null);
    domainEditor._commit(
      c.domainUv.map(([u, v]) =>
        Cesium.Cartographic.fromDegrees(
          c.extent[0] + u * (c.extent[2] - c.extent[0]),
          c.extent[1] + (1 - v) * (c.extent[3] - c.extent[1]),
        ),
      ),
    );
    domainEditor.stopDrawing();

    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && !(fluid && !state.pendingDomainDem)) {
      await caseSleep(100);
    }
    if (!fluid) {
      setStatus(`❌ 案例复演失败：地形采样超时。请检查网络后重试（${c.name}）`);
      return { ok: false, reason: "terrain-timeout" };
    }

    // 2) 降雨区（案例保证多边形在域内）
    const e = state.extent;
    regionEditor.startDrawing(e);
    regionEditor._commitRegion(
      c.rainUv.map(([u, v]) =>
        Cesium.Cartographic.fromDegrees(
          e[0] + u * (e[2] - e[0]),
          e[1] + (1 - v) * (e[3] - e[1]),
        ),
      ),
    );
    regionEditor.stopDrawing();

    // 3) 雨量模式参数（与 GUI 手工设置等价）
    options.rainMode = "amount";
    options.rainAmountMm = Math.min(1000, Math.max(1, c.mm));
    options.rainDurationSec = Math.min(600, Math.max(10, c.dur));
    fluid.resetRainAmount();
    rainProgress.mm = "0.0";
    rainProgress.rate = rainAmountRateMmH().toFixed(0);
    rainGuiCtrls?.amount?.updateDisplay?.();
    rainGuiCtrls?.duration?.updateDisplay?.();
    rainGuiCtrls?.mode?.updateDisplay?.();
    syncRainModeGui();
    refreshRainSummary();

    // 4) 机位：案例经纬度 + 离地高度（AGL），朝上游看
    await setCaseCamera(c.camera);

    // 5) 开始降雨
    options.rainEnabled = true;
    rainGuiCtrls?.enabled?.updateDisplay?.();
    applyRainRegions();
    refreshButtons();

    activeCaseId = c.id;
    const rate = rainAmountRateMmH().toFixed(0);
    setStatus(
      `📚 <strong>案例复演中：${c.name}</strong><br>` +
        `${c.site} · ${c.date} · 伤亡 ${c.loss}<br>` +
        `模拟域 <strong>${areaLabel(state.domain?.areaKm2 ?? 0)}</strong> · 雨区 <strong>${areaLabel(
          regionEditor.getActiveRegions().reduce((s, r) => s + (r.areaKm2 || 0), 0),
        )}</strong><br>` +
        `降雨：雨量模式 · 累计 <strong>${c.mm} mm</strong> / 历时 ${c.dur}s（≈${rate} mm/h，注满自动停）<br>` +
        `提示：右侧 GUI 可实时看「已降雨量(mm)」；「🧹 重置模拟」可清空水量重跑本案例。`,
    );
    return { ok: true, caseId: c.id, mm: c.mm, dur: c.dur, domainKm2: state.domain?.areaKm2 ?? 0 };
  } catch (err) {
    console.error(err);
    setStatus(`❌ 案例复演失败：${err?.message ?? err}`);
    return { ok: false, reason: String(err?.message ?? err) };
  } finally {
    caseBusy = false;
    if (caseDom.runBtn) {
      caseDom.runBtn.disabled = false;
      caseDom.runBtn.textContent = "▶ 一键复演";
    }
  }
}

/** 案例机位：先采样地面高程，再按 AGL 放置相机 */
async function setCaseCamera(cam) {
  if (!cam || !viewer) return;
  const tp = viewer.terrainProvider;
  let ground = 0;
  try {
    const carto = (
      await Cesium.sampleTerrainMostDetailed(tp, [Cesium.Cartographic.fromDegrees(cam.lon, cam.lat)])
    )[0];
    ground = carto?.height ?? 0;
  } catch {
    ground = 0;
  }
  const camera = viewer.camera;
  camera.cancelFlight();
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, ground + (cam.agl ?? 2000)),
    orientation: {
      heading: Cesium.Math.toRadians(cam.heading ?? 180),
      pitch: Cesium.Math.toRadians(cam.pitch ?? -30),
      roll: 0,
    },
  });
}

let gui;
let regionGuiFolder;
let regionControllers = {}; // id -> {folder, ctrls}
/** 降雨模式相关的 GUI 控制器（用于按模式显示/隐藏雨强与雨量控件） */
let rainGuiCtrls = null;
/** 地形采样精度下拉框控制器（供测试钩子同步显示） */
let sampleGridCtrl = null;
const rainProgress = { injected: "0.000", total: "0.0", mm: "—", rate: "—" };

function buildGui() {
  gui = new dat.GUI({ width: 300 });
  gui.domElement.parentElement.style.zIndex = 9998;

  /* ---- 数据 ---- */
  const fData = gui.addFolder("高程数据");
  const dataActions = {
    "全球地形模式": () => startGlobalDomainDraw(),
    上传高程图: () => dom.fileInput.click(),
    加载示例数据: async () => {
      setStatus("⏳ 正在加载示例…");
      await loadSample();
    },
  };
  fData.add(dataActions, "全球地形模式");
  fData.add(dataActions, "上传高程图");
  fData.add(dataActions, "加载示例数据");
  fData
    .add(options, "placementWidthKm", 0.5, 100, 0.5)
    .name("放置宽度(km)")
    .onChange(() => {
      if (state.pendingPlaceDem) {
        setStatus("调整了放置宽度：重新点击底图设置中心点即可生效");
      }
    });
  fData
    .add(options, "reliefMeters", 50, 3000, 10)
    .name("地形起伏跨度(米)")
    .onChange(() => {
      if (state.pendingPlaceDem) {
        setStatus("调整了地形起伏跨度：重新点击底图设置中心点即可生效");
      }
    });
  const samplePresets = {
    "96²（9,216 点 · 快速）": 96,
    "192²（36,864 点 · 精细）": 192,
    "256²（65,536 点 · 高）": 256,
    "384²（147,456 点 · 很高）": 384,
    "512²（262,144 点 · 最高）": 512,
  };
  sampleGridCtrl = fData
    .add(options, "globeSampleGrid", samplePresets)
    .name("地形采样精度")
    .onChange(() => {
      if (state.sourceMode === "globe") {
        setStatus("调整了地形采样精度：重新划定模拟域即可生效");
      }
    });
  const precisionLabel = { 精度: "" };
  fData.add(precisionLabel, "精度").name("模拟精度").listen();
  Object.defineProperty(precisionLabel, "精度", {
    get: () => {
      const ext = state.currentDem?.extent;
      if (!ext || !extentIsValid(ext)) {
        return `未划定模拟域（默认 ${options.globeSampleGrid}² 采样 / 1024² 模拟 = 1,048,576 格）`;
      }
      return `${precisionSummary(ext, state.lastSampleGrid || options.globeSampleGrid, 1024)} · 共 1,048,576 格`;
    },
  });
  const demLabel = { 信息: "尚未加载" };
  fData.add(demLabel, "信息").listen();
  Object.defineProperty(demLabel, "信息", {
    get: () => state.demInfo,
  });
  fData.close();

  /* ---- 标注图层（公共资源）---- */
  const fRef = gui.addFolder("标注图层");
  fRef
    .add(options, "refRoads")
    .name("道路网(含路名)")
    .onChange(syncRefLayers);
  fRef
    .add(options, "refPlaces")
    .name("地名标注")
    .onChange(syncRefLayers);
  fRef
    .add(options, "refZhAmap")
    .name("中文路网/地名(高德)")
    .onChange(syncZhLayers);
  fRef
    .add(options, "refTdtLabels")
    .name("中文注记(天地图·需tk)")
    .onChange(syncZhLayers);
  fRef.add(options, "tdtToken").name("天地图tk").onChange(syncZhLayers);
  fRef.close();

  /* ---- 模拟参数（原版 + 点源开关）---- */
  const fSim = gui.addFolder("SPH流体参数");
  fSim
    .add(options, "waterAddRate", 0.001, 0.1)
    .name("点源注水速率");
  fSim.add(options, "pointSource").name("点源注水(点击生效)");
  fSim.add(options, "gravity", 1.0, 10.0).name("重力强度");
  fSim.add(options, "initialWaterLevel", 0, 1).name("初始水位");
  fSim.add(options, "depth", 50, 500).name("渲染质量");
  const cWaterAlpha = fSim
    .add(options, "waterAlpha", 0, 1.0)
    .name("水透明度(0=不透明 1=最透)")
    .onChange(() => syncWaterSurface());
  cWaterAlpha.domElement.parentElement.title = "0：完全不透明（alpha 1.0）；1：最透明（alpha 0.2）";

  /* ---- 5 档水深配色 ---- */
  const fDepth = fSim.addFolder("5档水深配色");
  fDepth
    .add(options, "depthColorEnabled")
    .name("启用5档着色")
    .onChange(() => updateDepthLegend());
  [
    ["c0", "① 浅蓝 (0-2m)"],
    ["c1", "② 深蓝 (2-5m)"],
    ["c2", "③ 黄 (5-10m)"],
    ["c3", "④ 深黄 (10-20m)"],
    ["c4", "⑤ 红 (>20m)"],
  ].forEach(([k, name]) => {
    fDepth
      .addColor(depthColorOptions, k)
      .name(name)
      .onChange(() => {
        syncDepthColorUniforms();
        updateDepthLegend();
      });
  });
  fDepth.close();
  fSim.close();

  /* ---- 降雨控制 ---- */
  const fRain = gui.addFolder("降雨控制");
  const cMode = fRain
    .add(options, "rainMode", { 强度模式: "intensity", 雨量模式: "amount" })
    .name("降雨模式")
    .onChange(() => {
      resetRainfallEvent();
      syncRainModeGui();
      refreshRainSummary();
    });
  const cIntensity = fRain
    .add(options, "rainIntensity", 0.0001, 0.003, 0.0001)
    .name("降雨强度(默认0.0004)")
    .onChange(refreshRainSummary);
  // 雨量→质量换算不需要标定值：每 mm 注入的质量由体积盒高程跨度直接推出
  // （massPerMm = 1/(250·T)），保证 1.46 km² × 50 mm 就是 7.3 万 m³ 水。
  const cAmount = fRain
    .add(options, "rainAmountMm", 1, 1000, 1)
    .name("累计雨量(mm)")
    .onChange(() => {
      resetRainfallEvent();
      syncRainModeGui();
      refreshRainSummary();
    });
  const cDuration = fRain
    .add(options, "rainDurationSec", 10, 600, 5)
    .name("降雨历时(秒)")
    .onChange(() => {
      resetRainfallEvent();
      refreshRainSummary();
    });
  // 雨量预设（依据 GB/T 28592 的 24h 降水量等级划分增强版，便于一键试算）
  const rainPresets = {
    "💧 1mm 微量": 1,
    "🌦 10mm 小雨": 10,
    "🌧 25mm 中雨": 25,
    "🌧 50mm 大雨": 50,
    "⛈ 100mm 暴雨": 100,
    "⛈ 250mm 大暴雨": 250,
    "🌊 500mm 特大暴雨": 500,
    "🌊 1000mm 极端": 1000,
  };
  const cPreset = fRain
    .add(options, "rainAmountMm", rainPresets)
    .name("雨量预设")
    .onChange((v) => {
      options.rainAmountMm = Number(v);
      if (cAmount) cAmount.updateDisplay();
      resetRainfallEvent();
      syncRainModeGui();
      refreshRainSummary();
    });
  const cEnabled = fRain
    .add(options, "rainEnabled")
    .name("开始降雨")
    .onChange(() => {
      if (options.rainEnabled && !options.wholeAreaRain) {
        const n = regionEditor.getActiveRegions().length;
        if (n === 0) {
          setStatus("⚠ 尚未划定降雨区域：先「🌧 绘制降雨区域」，或勾选「全域降雨」");
        }
      }
      // 雨量模式：重新开启降雨视为新一场雨，累计归零（水面水量保留）
      if (options.rainMode === "amount") resetRainfallEvent();
      refreshRainSummary();
    });
  fRain.add(options, "rainFx").name("雨滴下落效果");
  fRain.add(options, "wholeAreaRain").name("全域降雨").onChange((v) => {
    dom.btnWholeRain.classList.toggle("danger-active", v);
    applyRainRegions();
    refreshRainSummary();
  });
  const cRainTotal = fRain
    .add(rainProgress, "total")
    .name("累计降雨量(mm)")
    .listen();
  if (cRainTotal?.domElement?.parentElement) {
    cRainTotal.domElement.parentElement.title =
      "跨多场降雨累加，只有「🧹 重置模拟」才会归零";
  }
  const cRainMm = fRain
    .add(rainProgress, "mm")
    .name("已降雨量(mm)")
    .listen();
  const cRainRate = fRain
    .add(rainProgress, "rate")
    .name("等效雨强(mm/h)")
    .listen();
  const rainActions = {
    "🧹 清空模拟状态(水量归零)": () => restartSimulation(),
  };
  fRain.add(rainActions, "🧹 清空模拟状态(水量归零)");
  fRain.open();

  rainGuiCtrls = {
    mode: cMode,
    intensity: cIntensity,
    amount: cAmount,
    duration: cDuration,
    preset: cPreset,
    mm: cRainMm,
    rate: cRainRate,
    enabled: cEnabled,
  };
  syncRainModeGui();

  regionGuiFolder = fRain; // 区域子文件夹挂到降雨控制下
}

/** 按降雨模式显示/隐藏对应控件（强度模式隐藏雨量项，雨量模式隐藏雨强项） */
function syncRainModeGui() {
  if (!rainGuiCtrls) return;
  const isAmount = options.rainMode === "amount";
  const show = (c, visible) => {
    const el = c?.domElement;
    if (!el || !el.style) return;
    // dat.GUI 的 controller.domElement 是控件容器（div.c），真正占一行的是外层 li.cr：
    // 只隐藏 div.c 会把滑块藏掉但留下空行，所以必须沿 DOM 往上找 li.cr 整行隐藏。
    const row = (el.closest && el.closest("li.cr")) || el;
    row.style.display = visible ? "" : "none";
  };
  show(rainGuiCtrls.intensity, !isAmount);
  show(rainGuiCtrls.amount, isAmount);
  show(rainGuiCtrls.duration, isAmount);
  show(rainGuiCtrls.preset, isAmount);
  show(rainGuiCtrls.mm, isAmount);
  show(rainGuiCtrls.rate, isAmount);
  rainGuiCtrls.mm?.updateDisplay?.();
  rainGuiCtrls.rate?.updateDisplay?.();
}

/** 重置本场降雨量的累计（切换雨量/历时/模式、或重新开始降雨时调用） */
function resetRainfallEvent() {
  if (fluid) fluid.resetRainAmount();
  if (options.rainMode === "amount") {
    rainProgress.mm = "0.0";
    rainProgress.rate = rainAmountRateMmH().toFixed(0);
  } else {
    rainProgress.mm = "—";
    rainProgress.rate = "—";
  }
  rainGuiCtrls?.mm?.updateDisplay?.();
  rainGuiCtrls?.rate?.updateDisplay?.();
}

/** 同步左下角 5 档水深图例（颜色 / 分界 / 显隐） */
function updateDepthLegend() {
  const el = dom.depthLegend;
  if (!el) return;
  el.style.display = options.depthColorEnabled ? "block" : "none";
  const box = el.querySelector(".dl-items");
  if (!box) return;
  const colors = [
    depthColorOptions.c0,
    depthColorOptions.c1,
    depthColorOptions.c2,
    depthColorOptions.c3,
    depthColorOptions.c4,
  ];
  const bands = [0, ...currentDepthBands()];
  const fmt = (v) =>
    Math.abs(v - Math.round(v)) < 0.01
      ? String(Math.round(v))
      : String(+v.toFixed(v < 1 ? 2 : 1));
  box.innerHTML = colors
    .map((css, i) => {
      const text =
        i === 4
          ? `&gt; ${fmt(bands[4])} m`
          : `${fmt(bands[i])} – ${fmt(bands[i + 1])} m`;
      return (
        `<div class="dl-row"><span class="dl-swatch" style="background:${css}"></span>` +
        `<span class="dl-text">${text}</span></div>`
      );
    })
    .join("");
  syncWaterSurface(); // 分档米数/颜色随体积盒跨度与 GUI 变化
}

function refreshRainSummary() {
  const n = regionEditor ? regionEditor.getActiveRegions().length : 0;
  const parts = [];
  if (options.rainEnabled) parts.push("🌧 降雨中");
  if (options.wholeAreaRain) parts.push("全域");
  parts.push(`${n} 个雨区`);
  if (options.rainMode === "amount") {
    parts.push(
      `雨量 ${options.rainAmountMm}mm / ${options.rainDurationSec}s（≈${rainAmountRateMmH().toFixed(0)} mm/h）`,
    );
  } else {
    parts.push(`雨强 ${options.rainIntensity}`);
  }
  setStatus(`<strong>${parts.join(" · ")}</strong><br>${state.demInfo}`);
}

/* ---- 每个雨区的动态 GUI 子文件夹 ---- */

function rebuildRegionGui() {
  if (!regionGuiFolder) return;
  // 清空旧的子文件夹
  for (const id of Object.keys(regionControllers)) {
    regionGuiFolder.removeFolder(regionControllers[id].folder);
    delete regionControllers[id];
  }
  if (!regionEditor) return;
  for (const r of regionEditor.allRegions()) {
    const folder = regionGuiFolder.addFolder(r.label);
    const local = {
      enabled: r.enabled,
      intensity: r.intensity,
      删除: () => {
        regionEditor.removeRegion(r.id);
        refreshButtons();
      },
    };
    folder
      .add(local, "enabled")
      .name("启用")
      .onChange((v) => {
        regionEditor.setEnabled(r.id, v);
        refreshButtons();
      });
    folder
      .add(local, "intensity", 0, 2, 0.01)
      .name("强度倍数")
      .onChange((v) => {
        regionEditor.setIntensity(r.id, v);
      });
    folder.add(local, "删除").name("删除雨区");
    regionControllers[r.id] = { folder, local };
  }
}

/* ==================================================================== */
/* SPH 流体模拟管线（改造自原版 TerrainFluidSimulation）                  */
/* ==================================================================== */

class TerrainFluidSimulation {
  constructor(viewer_, heightMapSource, settings) {
    this._viewer = viewer_;
    this._settings = settings;
    this._textureSize = 1024;
    this._volumeCenterElevation =
      (heightMapSource.maxElevation - heightMapSource.minElevation) / 2 +
      heightMapSource.minElevation;
    this._volumeThickness =
      heightMapSource.maxElevation - heightMapSource.minElevation;
    this._heightMapImage = heightMapSource.canvas;
    this._waterSourcePosition = new Cesium.Cartesian2(1.0, 0.0);

    // —— 降雨掩膜 ——
    this._rainMaskLive = null;
    this._rainEmptyTexture = this._createBlackTexture();

    // —— 模拟域掩膜（白=域内，黑=域外；未启用时用全白纹理表示全域）——
    this._domainMaskLive = null;
    this._domainEnabled = false;
    this._domainWhiteTexture = this._createWhiteTexture();

    // 统计
    this._frame = 0;
    this._injectedSum = 0;
    // —— 雨量模式（累计降雨量）状态 ——
    // _rainPassInjection：本帧每个 Simulation pass 注入到掩膜格子的质量；
    //   intensity 模式 = settings.rainIntensity，amount 模式 = 剩余雨量 / 剩余历时分摊。
    // _rainAmountTotal：本场次目标总量（每格质量）；_rainAmountInjected：已注入（每格质量，
    //   含同一帧的两个 Simulation pass）；_rainAmountElapsed：已降雨时长（秒）。
    this._rainPassInjection = settings.rainIntensity;
    this._rainAmountTotal = 0;
    this._rainAmountInjected = 0;
    this._rainAmountElapsed = 0;
    this._rainAmountLastTick = 0;
    // 累计降雨量（mm）：跨多场降雨累加，只有重建模拟/重置模拟才归零；
    // 与 _rainAmountInjected（本场次）区分开，满足“模拟多段降雨”的统计需求。
    this._rainTotalMm = 0;
    this._postRenderCb = () => {
      this._frame += 1;
      this._updateRainInjection();
      rainProgress.injected = this._injectedSum.toFixed(3);
      if (settings.rainMode === "amount") {
        const massPerMm = rainMassPerMm(this._volumeThickness);
        rainProgress.mm = (this._rainAmountInjected / massPerMm).toFixed(1);
        rainProgress.rate = rainAmountRateMmH().toFixed(0);
        rainProgress.total = this._rainTotalMm.toFixed(1);
      } else {
        rainProgress.mm = "—";
        rainProgress.rate = "—";
        // 强度模式没有“累计毫米”的物理含义（质量换算标定只对雨量模式成立）
        rainProgress.total = "—";
      }
    };
    this._viewer.scene.postRender.addEventListener(this._postRenderCb);

    this._entities = [];
    this._buildPipeline(heightMapSource);
  }

  /**
   * 每帧（渲染完成后）计算下一帧要用的降雨注入量。
   *
   * 之所以放在 postRender 而不是渲染前：Cesium 先执行各 ComputeStage 的
   * DrawCommand（着色器里读 rainIntensity uniform），之后才触发 postRender。
   * 这里算出的值供「下一帧」使用，误差一帧可忽略。
   *
   * amount 模式按「剩余雨量 / 剩余历时」分摊到每个 pass（每帧有 2 个 Simulation
   * pass 会注入，见 _buildPipeline：simulation + history），用真实时间间隔 dt 计算，
   * 保证掉帧时总注入量仍然等于设定雨量。
   */
  _updateRainInjection() {
    const settings = this._settings;
    if (settings.rainMode !== "amount") {
      this._rainPassInjection = settings.rainEnabled
        ? settings.rainIntensity
        : 0;
      if (
        settings.rainEnabled &&
        settings.rainIntensity > 0 &&
        (this._rainMaskLive !== null || settings.wholeAreaRain === true)
      ) {
        this._injectedSum += settings.rainIntensity;
      }
      return;
    }

    const hasMask =
      this._rainMaskLive !== null || settings.wholeAreaRain === true;
    const raining = !!settings.rainEnabled && hasMask;
    const now = performance.now() / 1000;
    if (!raining) {
      // 关雨/无雨区时暂停计时，重新开启后从暂停处继续
      this._rainAmountLastTick = 0;
      this._rainPassInjection = 0;
      return;
    }

    const massPerMm = rainMassPerMm(this._volumeThickness);
    this._rainAmountTotal =
      Math.max(0, Number(settings.rainAmountMm) || 0) * massPerMm;
    const duration = Math.max(1, Number(settings.rainDurationSec) || 1);

    const dt =
      this._rainAmountLastTick > 0
        ? Math.min(Math.max(now - this._rainAmountLastTick, 0), 0.25)
        : 0;
    this._rainAmountLastTick = now;

    const remainingMass = Math.max(
      0,
      this._rainAmountTotal - this._rainAmountInjected,
    );
    const remainingTime = Math.max(1e-3, duration - this._rainAmountElapsed);
    if (remainingMass <= 0 || dt <= 0) {
      this._rainPassInjection = 0;
      return;
    }

    // 每帧目标 = 剩余量 × dt/剩余历时；每帧 2 个 pass，各注入一半
    const perPass = Math.min(remainingMass, (remainingMass / remainingTime) * dt) / 2;
    this._rainPassInjection = Math.max(0, perPass);
    this._rainAmountInjected += this._rainPassInjection * 2;
    this._rainTotalMm += (this._rainPassInjection * 2) / massPerMm;
    this._rainAmountElapsed += dt;
    this._injectedSum += this._rainPassInjection * 2;
  }

  /** 重置本场次降雨量累计（切换到新雨量/新雨区后从 0 开始累计，水面不解算） */
  resetRainAmount() {
    this._rainAmountInjected = 0;
    this._rainAmountElapsed = 0;
    this._rainAmountLastTick = 0;
    this._rainPassInjection = 0;
    this._rainAmountTotal = 0;
    rainProgress.mm = "0.0";
  }

  /** 雨量模式统计（测试/状态栏读数用） */
  getRainfallStats() {
    const settings = this._settings;
    const massPerMm = rainMassPerMm(this._volumeThickness);
    return {
      mode: settings.rainMode,
      targetMm: Math.max(0, Number(settings.rainAmountMm) || 0),
      durationSec: Math.max(1, Number(settings.rainDurationSec) || 1),
      rateMmH: rainAmountRateMmH(),
      massPerMm,
      boxThicknessM: this._volumeThickness,
      targetMass: this._rainAmountTotal,
      injectedMass: this._rainAmountInjected,
      injectedMm: massPerMm > 0 ? this._rainAmountInjected / massPerMm : 0,
      elapsedSec: this._rainAmountElapsed,
      passInjection: this._rainPassInjection,
      totalMm: this._rainTotalMm,
    };
  }

  setWaterSource(position) {
    this._waterSourcePosition = position;
  }

  setRainMask(canvasOrNull) {
    if (this._rainMaskLive) {
      this._rainMaskLive.destroy();
      this._rainMaskLive = null;
    }
    if (!canvasOrNull) return;
    this._rainMaskLive = new Cesium.Texture({
      context: this._viewer.scene.context,
      width: canvasOrNull.width,
      height: canvasOrNull.height,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      flipY: false,
      sampler: new Cesium.Sampler({
        minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
        magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
        wrapS: Cesium.TextureWrap.CLAMP_TO_EDGE,
        wrapT: Cesium.TextureWrap.CLAMP_TO_EDGE,
      }),
      source: canvasOrNull,
    });
  }

  /**
   * 设置模拟域掩膜。
   * @param {HTMLCanvasElement|null} canvasOrNull 域内白/域外黑；null 表示无域
   * @param {boolean} enabled 是否启用域约束（有域时应为 true）
   */
  setDomainMask(canvasOrNull, enabled) {
    if (this._domainMaskLive) {
      this._domainMaskLive.destroy();
      this._domainMaskLive = null;
    }
    this._domainEnabled = !!enabled && !!canvasOrNull;
    if (!canvasOrNull) return;
    this._domainMaskLive = new Cesium.Texture({
      context: this._viewer.scene.context,
      width: canvasOrNull.width,
      height: canvasOrNull.height,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      flipY: false,
      sampler: new Cesium.Sampler({
        minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
        magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
        wrapS: Cesium.TextureWrap.CLAMP_TO_EDGE,
        wrapT: Cesium.TextureWrap.CLAMP_TO_EDGE,
      }),
      source: canvasOrNull,
    });
  }

  _createWhiteTexture() {
    return new Cesium.Texture({
      context: this._viewer.scene.context,
      width: 1,
      height: 1,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      source: {
        arrayBufferView: new Uint8Array([255, 255, 255, 255]),
      },
    });
  }

  _createBlackTexture() {
    return new Cesium.Texture({
      context: this._viewer.scene.context,
      width: 1,
      height: 1,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      source: {
        arrayBufferView: new Uint8Array([0, 0, 0, 255]),
      },
    });
  }

  _buildPipeline(heightMapSource) {
    const context = this._viewer.scene.context;
    const settings = this._settings;
    const particleTexture = createSimulationTexture(
      context,
      this._textureSize,
      this._textureSize,
    );
    const simulationTexture = createSimulationTexture(
      context,
      this._textureSize,
      this._textureSize,
    );
    const surfaceTexture = createSimulationTexture(
      context,
      this._textureSize,
      this._textureSize,
    );
    const historyTexture = createSimulationTexture(
      context,
      this._textureSize,
      this._textureSize,
    );
    this._simTextures = [
      particleTexture,
      simulationTexture,
      surfaceTexture,
      historyTexture,
    ];

    const heightMapTexture = new Cesium.Texture({
      context,
      width: 1024.0,
      height: 1024.0,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      flipY: false,
      sampler: new Cesium.Sampler({
        minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
        magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
        wrapS: Cesium.TextureWrap.REPEAT,
        wrapT: Cesium.TextureWrap.REPEAT,
      }),
      source: this._heightMapImage,
    });
    this._heightMapTexture = heightMapTexture;

    // iFrame 使用实例帧计数（由 _postRenderCb 每帧递增）。
    // 关键：BufferA 用 if(iFrame<1) 做一次性初始化；若 iFrame 恒为 0，
    // 每帧都会把粒子质量重置为幽灵质量，降雨注入被逐帧清零 → 水不积累不流动。
    // 上游 shadertoy 由平台自动递增 iFrame，移植到 Cesium 时必须手动传递。
    const domainMaskUniform = () => this._domainMaskLive ?? this._domainWhiteTexture;
    const domainEnabledUniform = () => (this._domainEnabled ? 1.0 : 0.0);

    const particleIntegrationStage = new FluidComputeStage({
      uniformMap: {
        iFrame: () => this._frame,
        iChannel0: () => historyTexture,
        initialMass: () => settings.initialWaterLevel,
        domainMask: domainMaskUniform,
        domainEnabled: domainEnabledUniform,
      },
      fragmentShaderSource: new Cesium.ShaderSource({
        sources: [sphKernelSource, particleIntegrationSource],
      }),
      outputTexture: particleTexture,
    });

    const simulationUniforms = {
      iChannel0: () => particleTexture,
      heightMap: () => heightMapTexture,
      waterSource: () => this._waterSourcePosition,
      waterAddRate: () => (settings.pointSource ? settings.waterAddRate : 0.0),
      waterSourceRadius: () => settings.waterSourceRadius,
      gravity: () => settings.gravity,
      // 降雨注入量由 _updateRainInjection() 每帧计算：
      //   intensity 模式 = 固定雨强；amount 模式 = 按剩余雨量/剩余历时分摊。
      // 该 uniform 每帧被 2 个 Simulation pass 各读取一次（simulation + history）。
      rainIntensity: () =>
        settings.rainEnabled ? this._rainPassInjection : 0.0,
      rainMask: () => this._rainMaskLive ?? this._rainEmptyTexture,
      domainMask: domainMaskUniform,
      domainEnabled: domainEnabledUniform,
    };

    const particleSimulationStage = new FluidComputeStage({
      uniformMap: simulationUniforms,
      fragmentShaderSource: new Cesium.ShaderSource({
        sources: [sphKernelSource, particleSimulationSource],
      }),
      outputTexture: simulationTexture,
    });

    const surfaceSmoothingStage = new FluidComputeStage({
      uniformMap: {
        iChannel0: () => simulationTexture,
        heightMap: () => heightMapTexture,
        domainMask: domainMaskUniform,
        domainEnabled: domainEnabledUniform,
      },
      fragmentShaderSource: new Cesium.ShaderSource({
        sources: [sphKernelSource, surfaceSmoothingSource],
      }),
      outputTexture: surfaceTexture,
    });

    const simulationHistoryStage = new FluidComputeStage({
      uniformMap: {
        ...simulationUniforms,
        iChannel0: () => simulationTexture,
      },
      fragmentShaderSource: new Cesium.ShaderSource({
        sources: [sphKernelSource, particleSimulationSource],
      }),
      outputTexture: historyTexture,
    });

    // 与原版一致：使用固定缺省矩形推算模型矩阵的占位将改为由 index 控制层传入。
    // 这里从 state.extent 读取当前范围。
    const extentDeg = state.extent;
    const rectangle = Cesium.Rectangle.fromDegrees(...extentDeg);
    const west = rectangle.west;
    const south = rectangle.south;
    const east = rectangle.east;
    const north = rectangle.north;

    const verticalGeodesic = new Cesium.EllipsoidGeodesic(
      new Cesium.Cartographic((west + east) / 2, south),
      new Cesium.Cartographic((west + east) / 2, north),
    );
    const height = verticalGeodesic.surfaceDistance;

    const horizontalGeodesic = new Cesium.EllipsoidGeodesic(
      new Cesium.Cartographic(west, (south + north) / 2),
      new Cesium.Cartographic(east, (south + north) / 2),
    );
    const width = horizontalGeodesic.surfaceDistance;
    const center = Cesium.Rectangle.center(rectangle);

    const centerLongitude = Cesium.Math.toDegrees(center.longitude);
    const centerLatitude = Cesium.Math.toDegrees(center.latitude);
    const modelMatrix = generateModelMatrix(
      [centerLongitude, centerLatitude, this._volumeCenterElevation],
      [90, 0, 0],
      [width, this._volumeThickness, height],
    );

    const boundaryEntity = this._viewer.entities.add({
      name: "模拟体积盒",
      position: Cesium.Cartesian3.fromDegrees(
        centerLongitude,
        centerLatitude,
        this._volumeCenterElevation,
      ),
      box: {
        dimensions: new Cesium.Cartesian3(
          width,
          height,
          this._volumeThickness,
        ),
        fill: false,
        outline: true,
        outlineColor: Cesium.Color.YELLOW.withAlpha(0.35),
      },
    });
    this._entities.push(boundaryEntity);

    const boxGeometry = Cesium.BoxGeometry.fromDimensions({
      vertexFormat: Cesium.VertexFormat.POSITION_ONLY,
      dimensions: new Cesium.Cartesian3(1, 1, 1),
    });
    const geometry = Cesium.BoxGeometry.createGeometry(boxGeometry);

    const volumeRenderStage = new FluidVolumeStage({
      uniformMap: {
        iChannel0: () => surfaceTexture,
        depth: () => settings.depth,
        shallow: () => settings.shallow,
        deep: () => settings.deep,
        waterAlpha: () => settings.waterAlpha,
        // —— 5 档水深配色 ——
        // 颜色 uniform 是 sRGB 原值（着色器内 czm_gammaCorrect 转线性）。
        // 分档与米制换算都跟随体积盒高程跨度（DEPTH_BAND_FRACS × 跨度），
        // 与水面几何高度同一把尺子，避免“水很深、颜色却很浅”（§5.11）。
        depthColor0: () => depthColorUniforms.c0,
        depthColor1: () => depthColorUniforms.c1,
        depthColor2: () => depthColorUniforms.c2,
        depthColor3: () => depthColorUniforms.c3,
        depthColor4: () => depthColorUniforms.c4,
        depthBand0: () => currentDepthBands()[0],
        depthBand1: () => currentDepthBands()[1],
        depthBand2: () => currentDepthBands()[2],
        depthBand3: () => currentDepthBands()[3],
        // 水深米数 = 归一化水深 × 体积盒真实跨度，与水体几何高度同一尺度；
        // 这样“看到多深”和“图例标多少米”一致。
        depthRangeM: () => Math.max(1, currentBoxThicknessM()),
        depthColorEnabled: () => (settings.depthColorEnabled ? 1.0 : 0.0),
      },
      geometry,
      modelMatrix,
      vertexShaderSource: new Cesium.ShaderSource({
        sources: [
          `
          in vec3 position;

          out vec3 vo;
          out vec3 vd;

          void main() {
              vo = czm_encodedCameraPositionMCHigh + czm_encodedCameraPositionMCLow;
              vd = position - vo;
              gl_Position = czm_modelViewProjection * vec4(position, 1.0);
          }
          `,
        ],
      }),
      fragmentShaderSource: new Cesium.ShaderSource({
        sources: [sphKernelSource + "\n" + fluidVolumeFragmentSource],
      }),
    });

    this._stages = [
      particleIntegrationStage,
      particleSimulationStage,
      surfaceSmoothingStage,
      simulationHistoryStage,
      volumeRenderStage,
    ];
    for (const s of this._stages) {
      this._viewer.scene.primitives.add(s);
    }
  }

  destroy() {
    if (this._postRenderCb) {
      this._viewer.scene.postRender.removeEventListener(this._postRenderCb);
      this._postRenderCb = null;
    }
    if (this._stages) {
      for (const s of this._stages) this._viewer.scene.primitives.remove(s);
      this._stages = null;
    }
    for (const e of this._entities.splice(0)) {
      this._viewer.entities.remove(e);
    }
    for (const t of this._simTextures ?? []) t.destroy();
    this._simTextures = null;
    this._heightMapTexture?.destroy();
    this._heightMapTexture = null;
    if (this._rainMaskLive) {
      this._rainMaskLive.destroy();
      this._rainMaskLive = null;
    }
    this._rainEmptyTexture?.destroy();
    this._rainEmptyTexture = null;
    if (this._domainMaskLive) {
      this._domainMaskLive.destroy();
      this._domainMaskLive = null;
    }
    this._domainWhiteTexture?.destroy();
    this._domainWhiteTexture = null;
  }

  getInjectedAmount() {
    return this._injectedSum;
  }
}

/**
 * 生成矩阵（原版工具函数）
 */
const generateModelMatrix = (
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = [1, 1, 1],
) => {
  // 当前代码来自[少年啦1997]的开源代码，如果你是购买源码，请联系商家进行退款
  const rotationX = Cesium.Matrix4.fromRotationTranslation(
    Cesium.Matrix3.fromRotationX(Cesium.Math.toRadians(rotation[0])),
  );

  const rotationY = Cesium.Matrix4.fromRotationTranslation(
    Cesium.Matrix3.fromRotationY(Cesium.Math.toRadians(rotation[1])),
  );

  const rotationZ = Cesium.Matrix4.fromRotationTranslation(
    Cesium.Matrix3.fromRotationZ(Cesium.Math.toRadians(rotation[2])),
  );
  if (!(position instanceof Cesium.Cartesian3)) {
    position = Cesium.Cartesian3.fromDegrees(...position);
  }
  const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  Cesium.Matrix4.multiply(enuMatrix, rotationX, enuMatrix);
  Cesium.Matrix4.multiply(enuMatrix, rotationY, enuMatrix);
  Cesium.Matrix4.multiply(enuMatrix, rotationZ, enuMatrix);
  const scaleMatrix = Cesium.Matrix4.fromScale(new Cesium.Cartesian3(...scale));
  const modelMatrix = Cesium.Matrix4.multiply(
    enuMatrix,
    scaleMatrix,
    new Cesium.Matrix4(),
  );

  return modelMatrix;
};

/* ==================================================================== */

const main = async () => {
  try {
    await initViewer();
      window.__app.ready = true;
  } catch (err) {
    console.error(err);
    setStatus(`❌ 初始化失败：${err.message}`);
    window.__app.initError = String(err?.message ?? err);
  }
};

window.onload = main;

/* ------------------------------------------------------------------ */
/* 自动化测试 / 调试钩子（不影响正常运行）                                */
/* ------------------------------------------------------------------ */
window.__app = {
  ready: false,
  get viewer() {
    return viewer;
  },
  get fluid() {
    return fluid;
  },
  get extent() {
    return state.extent;
  },
  get options() {
    return options;
  },
  get editor() {
    return regionEditor;
  },
  get domainEditor() {
    return domainEditor;
  },
  get domain() {
    return state.domain;
  },
  /** 雨滴后处理句柄（测试/调试用） */
  get rainFx() {
    return state.rainFx;
  },
  /** 参考图层状态（测试用）：影像层数量 + 道路网/地名标注/中文标注显隐 */
  refLayers() {
    return {
      imageryCount: viewer?.imageryLayers?.length ?? 0,
      layers: state.refLayers.map((r) => ({
        label: r.label,
        key: r.key,
        show: !!r.layer.show,
      })),
      zh: {
        amap: !!state.zhLayers.amap?.show,
        amapCreated: !!state.zhLayers.amap,
        tdt: !!state.zhLayers.tdt?.show,
        tdtCreated: !!state.zhLayers.tdt,
        tdtTokenApplied: state.zhLayers.tdtTokenApplied,
      },
    };
  },
  /** 把 options 里的参考/中文图层勾选同步到实际显隐（GUI 勾选会自动调用；测试可直接改 options 后调本方法） */
  applyRefLayerVisibility() {
    syncRefLayers();
    syncZhLayers();
    return this.refLayers();
  },
  /** 雨滴视觉效果状态（测试用） */
  rainFxInfo() {
    return {
      exists: !!state.rainFx,
      stageEnabled: !!state.rainFx?.getEnabled?.(),
      optionRainFx: !!options.rainFx,
      amount: rainFxAmount(),
    };
  },
  /** 测试钩子：开关雨滴视觉效果（等价 GUI「雨滴下落效果」） */
  setRainFx(on = true) {
    options.rainFx = !!on;
    state.rainFx?.setEnabled?.(options.rainFx);
    return this.rainFxInfo();
  },
  /** 5 档水深配色状态（测试用）：bands/colors 按档位顺序返回数组（bands 随体积盒跨度自动缩放） */
  depthConfig() {
    const bands = currentDepthBands();
    return {
      enabled: !!options.depthColorEnabled,
      bands,
      bandFracs: [...DEPTH_BAND_FRACS],
      boxThicknessM: currentBoxThicknessM(),
      colors: [
        depthColorOptions.c0,
        depthColorOptions.c1,
        depthColorOptions.c2,
        depthColorOptions.c3,
        depthColorOptions.c4,
      ],
      legendVisible: dom.depthLegend
        ? dom.depthLegend.style.display !== "none"
        : false,
      legendRows: dom.depthLegend
        ? dom.depthLegend.querySelectorAll(".dl-row").length
        : 0,
    };
  },
  /** 测试钩子：外部直接改 options/颜色后，手动同步 uniform 与图例（等价 GUI onChange） */
  syncDepthColors() {
    syncDepthColorUniforms();
    updateDepthLegend();
    return this.depthConfig();
  },
  /** 精度信息（测试/展示用）：采样网格点数与格距、SPH 模拟网格规模 */
  precisionInfo() {
    const extent = state.currentDem?.extent ?? state.extent;
    const sampleGrid = state.lastSampleGrid || options.globeSampleGrid;
    const simGrid = 1024;
    return {
      sampleGrid,
      samples: sampleGrid * sampleGrid,
      sampleSpacing: extent ? cellSizeMeters(extent, sampleGrid) : { x: 0, y: 0 },
      simGrid,
      simCells: simGrid * simGrid,
      simSpacing: extent ? cellSizeMeters(extent, simGrid) : { x: 0, y: 0 },
      extent: extent ? [...extent] : null,
      text: extent ? precisionSummary(extent, sampleGrid, simGrid) : "未划定模拟域",
    };
  },
  /** 测试钩子：设置下一次全球地形采样的网格边长后重新划域生效 */
  setSampleGrid(n) {
    const v = Math.min(512, Math.max(32, Math.round(Number(n) || 96)));
    options.globeSampleGrid = v;
    sampleGridCtrl?.updateDisplay?.();
    return { requestedGrid: v, requestedSamples: v * v, current: this.precisionInfo() };
  },
  /** 降雨模式状态（测试用）：模式/设定雨量/历时/换算率；amount 模式下附带已注入雨量等统计 */
  rainfallConfig() {
    const thickness = fluid?._volumeThickness ?? currentBoxThicknessM();
    const cfg = {
      mode: options.rainMode,
      amountMm: options.rainAmountMm,
      durationSec: options.rainDurationSec,
      rateMmH: rainAmountRateMmH(),
      massPerMm: rainMassPerMm(thickness),
      boxThicknessM: thickness,
      intensity: options.rainIntensity,
      rainEnabled: !!options.rainEnabled,
      stats: fluid?.getRainfallStats?.() ?? null,
    };
    return cfg;
  },
  /** 测试钩子：设置降雨（模式/雨量/历时），并同步 GUI 与面板显示 */
  setRainfall(mm, durationSec, mode = "amount") {
    options.rainMode = mode === "intensity" ? "intensity" : "amount";
    if (mm !== undefined) options.rainAmountMm = Math.min(1000, Math.max(1, Number(mm) || 0));
    if (durationSec !== undefined) {
      options.rainDurationSec = Math.min(600, Math.max(10, Number(durationSec) || 0));
    }
    if (fluid) fluid.resetRainAmount();
    rainProgress.mm = "0.0";
    rainProgress.rate = rainAmountRateMmH().toFixed(0);
    // 同步 GUI 控件显示值（否则状态栏显示 150mm、滑块仍停在旧值，容易误解）
    rainGuiCtrls?.mode?.updateDisplay?.();
    rainGuiCtrls?.amount?.updateDisplay?.();
    rainGuiCtrls?.duration?.updateDisplay?.();
    rainGuiCtrls?.preset?.updateDisplay?.();
    syncRainModeGui();
    refreshRainSummary();
    return this.rainfallConfig();
  },
  /** 测试钩子：开/关降雨总开关（等价于勾选 GUI「开始降雨」） */
  setRainEnabled(on = true) {
    options.rainEnabled = !!on;
    rainGuiCtrls?.enabled?.updateDisplay?.();
    applyRainRegions();
    refreshRainSummary();
    return this.rainfallConfig();
  },
  /** 降雨模式 GUI 控件显隐状态（测试用）：雨量模式应隐藏雨强、显示雨量/历时/预设/读数 */
  rainGuiState() {
    if (!rainGuiCtrls) return null;
    // 用整行 li.cr 的计算样式判断（dat.GUI 的 domElement 只是控件容器，不能代表整行是否可见）
    const vis = (c) => {
      const el = c?.domElement;
      if (!el) return null;
      const row = (el.closest && el.closest("li.cr")) || el;
      const style = (row.ownerDocument || document).defaultView.getComputedStyle(row);
      return style.display !== "none";
    };
    return {
      intensity: vis(rainGuiCtrls.intensity),
      amount: vis(rainGuiCtrls.amount),
      duration: vis(rainGuiCtrls.duration),
      preset: vis(rainGuiCtrls.preset),
      mm: vis(rainGuiCtrls.mm),
      rate: vis(rainGuiCtrls.rate),
      folderRows: (() => {
        const folder = rainGuiCtrls.intensity?.domElement?.closest?.(".dg .folder");
        if (!folder) return null;
        return [...folder.querySelectorAll("li.cr")].length;
      })(),
      folderHeight: (() => {
        const folder = rainGuiCtrls.intensity?.domElement?.closest?.(".dg .folder");
        if (!folder) return null;
        return Math.round(folder.getBoundingClientRect().height);
      })(),
    };
  },
  /** 体积盒竖直跨度（米）：shader 里 waterDepth(0~1) × 该值 = 真实水深 */
  volumeThickness() {
    return fluid?._volumeThickness ?? 0;
  },
  /** 贴地水体叠加层的状态（测试用） */
  waterSurfaceInfo() {
    const u = waterSurface?.material?.uniforms ?? {};
    return {
      exists: !!waterSurface,
      visible: !!waterSurface?.entity?.show,
      hasTexture: !!u.waterTexture,
      thicknessM: u.thicknessM ?? 0,
      bands: [u.band0 ?? 0, u.band1 ?? 0, u.band2 ?? 0, u.band3 ?? 0],
      hazeAlpha: u.hazeAlpha ?? 0,
      enabled: u.enabled ?? 0,
      /** 体积渲染阶段是否已被隐藏（水体改由贴地多边形绘制） */
      volumeStageVisible: !!fluid?._stages?.[4]?.show,
    };
  },
  hasDomain() {
    return !!state.domain && state.domain.simPoly.length >= 3;
  },
  /** 区域面积（测试用）：模拟域 km² / 雨区 km² 列表 */
  areas() {
    return {
      domainKm2: state.domain?.areaKm2 ?? 0,
      rainKm2: regionEditor ? regionEditor.allRegions().map((r) => r.areaKm2 ?? 0) : [],
      rainTotalKm2: regionEditor
        ? regionEditor.getActiveRegions().reduce((s, r) => s + (r.areaKm2 || 0), 0)
        : 0,
    };
  },
  /** 领域实体标签文本（测试用）：模拟域 + 各雨区 */
  areaLabels() {
    const texts = [];
    for (const e of viewer?.entities?.values ?? []) {
      const t = e?.label?.text?.getValue?.(Cesium.JulianDate.now());
      if (typeof t === "string" && /面积/.test(t)) texts.push(t);
    }
    return texts;
  },
  /** 清空模拟状态，从 0 重新开始（测试钩子，与工具栏按钮同一条路径） */
  restartSimulation() {
    restartSimulation();
    return { hasFluid: !!fluid, injected: fluid ? fluid.getInjectedAmount() : -1 };
  },
  statusText() {
    return dom.statusBar?.innerText ?? "";
  },
  activeRegions() {
    return regionEditor ? regionEditor.getActiveRegions().length : -1;
  },
  /** 以 uv 比例直接提交一个矩形测试模拟域（供无头测试驱动） */
  commitTestDomain(insetU = 0.1, insetV = 0.1) {
    return this.commitDomainUV([
      [insetU, insetV],
      [1 - insetU, insetV],
      [1 - insetU, 1 - insetV],
      [insetU, 1 - insetV],
    ]);
  },
  /**
   * 全球地形模式测试钩子：在给定经纬度 bbox 内提交一个 uv 多边形模拟域。
   * 走真实地形采样（异步）→ 生成域掩膜 → 启动模拟的完整流程。
   * @param {[number,number,number,number]} extentDeg [minLon,minLat,maxLon,maxLat]
   * @param {Array<[number,number]>} uvList [u,v]，v=0 为北（着色器约定）
   */
  async commitGlobeDomain(
    extentDeg,
    uvList = [
      [0.08, 0.08],
      [0.92, 0.08],
      [0.92, 0.92],
      [0.08, 0.92],
    ],
  ) {
    if (!domainEditor || !Array.isArray(extentDeg) || extentDeg.length !== 4)
      return { ok: false, reason: "bad-extent" };
    if (startGlobalDomainDraw) startGlobalDomainDraw(); // 确保重置为全球模式
    domainEditor.startDrawing(null);
    domainEditor._commit(
      uvList.map(([u, v]) =>
        Cesium.Cartographic.fromDegrees(
          extentDeg[0] + u * (extentDeg[2] - extentDeg[0]),
          extentDeg[1] + (1 - v) * (extentDeg[3] - extentDeg[1]),
        ),
      ),
    );
    domainEditor.stopDrawing();
    // onDomainCommitted 是异步的（地形采样），等待流体创建完成
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (fluid && !state.pendingDomainDem) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return {
      ok: this.hasDomain() && !!fluid,
      vertices: state.domain?.simPoly.length ?? 0,
      hasMask: !!fluid?._domainMaskLive,
      domainEnabled: fluid?._domainEnabled ?? false,
      extent: state.extent ? [...state.extent] : null,
      sourceMode: state.sourceMode,
    };
  },
  /** 提交任意 uv 多边形作为模拟域：走 DomainEditor，触发生成掩膜 + 启动模拟 */
  commitDomainUV(uvList) {
    const dem = state.pendingDomainDem;
    if (!dem || !domainEditor) return { ok: false, reason: "no-pending-domain" };
    if (!Array.isArray(uvList) || uvList.length < 3)
      return { ok: false, reason: "need>=3" };
    const e = dem.extent;
    domainEditor.startDrawing(e);
    domainEditor._commit(
      uvList.map(([u, v]) =>
        Cesium.Cartographic.fromDegrees(
          e[0] + u * (e[2] - e[0]),
          e[1] + (1 - v) * (e[3] - e[1]),
        ),
      ),
    );
    domainEditor.stopDrawing();
    return {
      ok: this.hasDomain(),
      vertices: state.domain?.simPoly.length ?? 0,
      hasMask: !!fluid?._domainMaskLive,
      domainEnabled: fluid?._domainEnabled ?? false,
    };
  },
  /** 以着色器空间 uv 比例直接提交一个矩形测试雨区 */
  commitTestRegion(insetU = 0.3, insetVNorth = 0.3) {
    return this.commitRegionUV([
      [insetU, insetVNorth],
      [1 - insetU, insetVNorth],
      [1 - insetU, 1 - insetVNorth],
      [insetU, 1 - insetVNorth],
    ]);
  },
  /** 提交任意着色器空间 uv 多边形（[u, vNorthOrigin]，v=0 为南界对应的北…见 geoUtils 约定：v 为着色器空间） */
  commitRegionUV(uvList) {
    if (!state.extent || !regionEditor) return { ok: false, reason: "no-sim" };
    if (!Array.isArray(uvList) || uvList.length < 3)
      return { ok: false, reason: "need>=3" };
    const e = state.extent;
    regionEditor.startDrawing(e);
    regionEditor._commitRegion(
      uvList.map(([u, v]) =>
        Cesium.Cartographic.fromDegrees(
          e[0] + u * (e[2] - e[0]),
          e[1] + (1 - v) * (e[3] - e[1]),
        ),
      ),
    );
    regionEditor.stopDrawing();
    return { ok: true, active: this.activeRegions(), hasMask: !!fluid?._rainMaskLive };
  },
  injectedAmount() {
    return fluid ? fluid.getInjectedAmount() : NaN;
  },
  /** 测试：手动放置流程（等价于在 (lon,lat) 点击底图） */
  testPlaceAt(lon, lat) {
    return placePendingDemAtDegrees(lon, lat);
  },

  /* —— 山洪案例库 —— */
  /** 案例清单（精简字段，供测试与外部查询） */
  cases() {
    return CASES.map((c) => ({
      id: c.id,
      name: c.name,
      site: c.site,
      date: c.date,
      scenario: c.scenario,
      mm: c.mm,
      dur: c.dur,
    }));
  },
  /** 一键复演案例：走与 UI 按钮完全相同的流程 */
  runCase(id) {
    return runCase(id);
  },
  /** 当前正在复演的案例 id（未复演为 null） */
  activeCase() {
    return activeCaseId;
  },
  /** 打开/关闭案例库面板（测试用） */
  openCases() {
    openCasePanel();
    return !caseDom.panel?.hidden;
  },
  closeCases() {
    closeCasePanel();
    return !!caseDom.panel?.hidden;
  },
  /** 案例库 DOM 状态（测试用） */
  caseState() {
    return {
      open: !caseDom.panel?.hidden,
      cards: caseDom.list?.querySelectorAll(".case-card").length ?? 0,
      selected: caseSelectedId,
      active: activeCaseId,
      busy: caseBusy,
    };
  },
};
