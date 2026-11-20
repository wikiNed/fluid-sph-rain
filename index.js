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
import { rasterizeRainMask } from "./src/sim/rainMask.js";
import { rasterizeDomainMask } from "./src/sim/domainMask.js";
import {
  rectangleAroundCenter,
  extentIsValid,
  extentAreaLabel,
  areaLabel,
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

/** 5 档水深的分界值（米），必须严格递增，GUI 修改时会自动修正顺序 */
const depthBands = { b0: 2, b1: 5, b2: 10, b3: 20 };

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
  waterAlpha: 0.85,

  // —— 新增：数据放置 ——
  placementWidthKm: 10.0, // 无地理参考图片的手动放置宽度
  reliefMeters: 600, // 无地理参考图片的地形起伏跨度(米)，盒子将贴合真实地表
  globeSampleGrid: 96, // 全球地形模式的采样网格边长（越大越精细但越慢，32~160）

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
  // 满档水深（米）：着色器里的水深是“占体积盒高度的归一化比例”，
  // 该比例 × depthFullM 才得到图例上的“米”。因为 SPH 的归一化质量单位
  // 与真实降雨量并非 1:1（实际水深可达数百米），必须用一个可调标定值
  // 把默认雨强下 1~2 分钟降雨过程的深度变化铺满 0~20m 五档。
  depthFullM: 40,

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
/** @type {RainRegionEditor} */
let regionEditor = null;
/** @type {DomainEditor} */
let domainEditor = null;

const state = {
  /** @type {[number,number,number,number]|null} 当前模拟范围 [minLon,minLat,maxLon,maxLat] */
  extent: null,
  demInfo: "尚未加载数据",
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
 * 推导（体积守恒，以 5 档图例的「米」为准）：
 *   - 着色器里 waterDepth（占体积盒高度的归一化比例）= data.x * heightScale(0.25)，
 *     图例米数 = waterDepth × depthFullM，即 1 个质量单位 ≈ 0.25×depthFullM 米。
 *   - 若想让图例米数等于真实的等效降雨深度（1mm → 0.001m），则每格目标质量
 *     data.x = P米 / (0.25 × depthFullM) = P毫米 / (250 × depthFullM)。
 *   - 于是「图例水深 × 面积」= 降雨量 × 雨区面积，即画面上的水量与真实降雨体积一致；
 *     而地形上水柱的几何高度仍是放大显示（放大倍数 = 体积盒高程跨度 / depthFullM，
 *     默认约 50×），这是为了让人眼在高差上千米的地形上看清米级积水（见 §5.13）。
 *
 * @returns {number} 每 1mm 累计降雨量对应的每格质量增量
 */
function rainMassPerMm() {
  const fullM = Math.max(1, Number(options.depthFullM) || 40);
  return 1 / (250 * fullM);
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
      dem = {
        kind: "globe",
        sourceName: "全球地形采样",
        canvas: sampled.canvas,
        minElevation: sampled.minElevation,
        maxElevation: sampled.maxElevation,
        extent: [...extent],
        contentAspect: (Math.cos(Cesium.Math.toRadians((extent[1] + extent[3]) / 2)) * (extent[2] - extent[0])) / (extent[3] - extent[1]),
        info: `全球真实地形 · ${sampled.valid}/${sampled.samples} 网格点${sampled.flat ? " · 区域较平坦" : ""}`,
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
  state.extent = null;
  state.currentDem = null;
  state.domainMaskCanvas = null;
  refreshButtons();
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
  rainProgress.injected = "0.000";

  fluid = new TerrainFluidSimulation(viewer, dem, options);
  fluid.setDomainMask(state.domainMaskCanvas, !!state.domain);
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

let gui;
let regionGuiFolder;
let regionControllers = {}; // id -> {folder, ctrls}
/** 降雨模式相关的 GUI 控制器（用于按模式显示/隐藏雨强与雨量控件） */
let rainGuiCtrls = null;
const rainProgress = { injected: "0.000", mm: "—", rate: "—" };

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
  fData
    .add(options, "globeSampleGrid", 32, 160, 8)
    .name("地形采样精度")
    .onChange(() => {
      if (state.sourceMode === "globe") {
        setStatus("调整了地形采样精度：重新划定模拟域即可生效");
      }
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
  fSim.add(options, "waterAlpha", 0.1, 1.0).name("水透明度");
  fSim
    .addColor(colorOptions, "shallowColor")
    .name("浅水颜色")
    .onChange((v) => (options.shallow = Cesium.Color.fromCssColorString(v)));
  fSim
    .addColor(colorOptions, "deepColor")
    .name("深水颜色")
    .onChange((v) => (options.deep = Cesium.Color.fromCssColorString(v)));

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
  [
    ["b0", 0.5, 50, 0.5, "①/② 分界(米)"],
    ["b1", 1, 100, 0.5, "②/③ 分界(米)"],
    ["b2", 1, 200, 0.5, "③/④ 分界(米)"],
    ["b3", 1, 500, 0.5, "④/⑤ 分界(米)"],
  ].forEach(([k, min, max, step, name]) => {
    fDepth
      .add(depthBands, k, min, max, step)
      .name(name)
      .onChange(() => {
        normalizeDepthBands();
        updateDepthLegend();
      });
  });
  fDepth
    .add(options, "depthFullM", 5, 200, 1)
    .name("满档水深(米)")
    .onChange(() => updateDepthLegend());
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
  fRain
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
  fRain
    .add(rainProgress, "injected")
    .name("累计注入量")
    .listen();
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

/** 保证 5 档分界值严格递增（GUI 拖动越界时自动排序修正） */
function normalizeDepthBands() {
  const vals = [depthBands.b0, depthBands.b1, depthBands.b2, depthBands.b3]
    .map((v) => Math.max(0.5, Number(v) || 0.5))
    .sort((a, b) => a - b);
  depthBands.b0 = vals[0];
  depthBands.b1 = vals[1];
  depthBands.b2 = vals[2];
  depthBands.b3 = vals[3];
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
  const bands = [0, depthBands.b0, depthBands.b1, depthBands.b2, depthBands.b3];
  const fmt = (v) =>
    Math.abs(v - Math.round(v)) < 0.01
      ? String(Math.round(v))
      : String(+v.toFixed(1));
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
    this._postRenderCb = () => {
      this._frame += 1;
      this._updateRainInjection();
      rainProgress.injected = this._injectedSum.toFixed(3);
      if (settings.rainMode === "amount") {
        const massPerMm = rainMassPerMm();
        rainProgress.mm = (this._rainAmountInjected / massPerMm).toFixed(1);
        rainProgress.rate = rainAmountRateMmH().toFixed(0);
      } else {
        rainProgress.mm = "—";
        rainProgress.rate = "—";
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

    const massPerMm = rainMassPerMm();
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
    const massPerMm = rainMassPerMm();
    return {
      mode: settings.rainMode,
      targetMm: Math.max(0, Number(settings.rainAmountMm) || 0),
      durationSec: Math.max(1, Number(settings.rainDurationSec) || 1),
      rateMmH: rainAmountRateMmH(),
      massPerMm,
      targetMass: this._rainAmountTotal,
      injectedMass: this._rainAmountInjected,
      injectedMm: massPerMm > 0 ? this._rainAmountInjected / massPerMm : 0,
      elapsedSec: this._rainAmountElapsed,
      passInjection: this._rainPassInjection,
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
        // 颜色 uniform 是 sRGB 原值（着色器内 czm_gammaCorrect 转线性）；
        // depthRangeM 是「满档水深（米）」标定值：waterDepth(0~1) × 它 = 图例米数。
        // 不能用体积盒真实跨度（=高程差，常见上千公里级），否则默认雨强下
        // 几秒内就全部落进 >20m 红色档，五档配色完全失去区分度（见 §5.10）。
        depthColor0: () => depthColorUniforms.c0,
        depthColor1: () => depthColorUniforms.c1,
        depthColor2: () => depthColorUniforms.c2,
        depthColor3: () => depthColorUniforms.c3,
        depthColor4: () => depthColorUniforms.c4,
        depthBand0: () => depthBands.b0,
        depthBand1: () => depthBands.b1,
        depthBand2: () => depthBands.b2,
        depthBand3: () => depthBands.b3,
        depthRangeM: () => Math.max(1, settings.depthFullM),
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
  /** 5 档水深配色状态（测试用）：bands/colors 按档位顺序返回数组 */
  depthConfig() {
    return {
      enabled: !!options.depthColorEnabled,
      bands: [depthBands.b0, depthBands.b1, depthBands.b2, depthBands.b3],
      colors: [
        depthColorOptions.c0,
        depthColorOptions.c1,
        depthColorOptions.c2,
        depthColorOptions.c3,
        depthColorOptions.c4,
      ],
      fullM: options.depthFullM,
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
    normalizeDepthBands();
    syncDepthColorUniforms();
    updateDepthLegend();
    return this.depthConfig();
  },
  /** 降雨模式状态（测试用）：模式/设定雨量/历时/换算率；amount 模式下附带已注入雨量等统计 */
  rainfallConfig() {
    const cfg = {
      mode: options.rainMode,
      amountMm: options.rainAmountMm,
      durationSec: options.rainDurationSec,
      rateMmH: rainAmountRateMmH(),
      massPerMm: rainMassPerMm(),
      depthFullM: options.depthFullM,
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
    syncRainModeGui();
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
};
