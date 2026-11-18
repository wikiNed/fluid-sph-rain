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
import { rasterizeRainMask } from "./src/sim/rainMask.js";
import { rasterizeDomainMask } from "./src/sim/domainMask.js";
import {
  rectangleAroundCenter,
  extentIsValid,
  extentAreaLabel,
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
};

const colorOptions = {
  shallowColor: "#48cae4",
  deepColor: "#023e8a",
};
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
  wholeAreaRain: false, // 是否全域降雨（不勾选则仅在雨区内）
  pointSource: false, // 点击点源注水（原版交互）
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

  const baseLayerMessage = layerMessages.join(" + ");

  viewer.scene.msaaSamples = 4;
  viewer.scene.highDynamicRange = true;
  viewer.postProcessStages.fxaa.enabled = true;
  viewer.scene.globe.depthTestAgainstTerrain = true;

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
  refreshButtons();
}

async function finishStart(dem, domainMaskCanvas) {
  if (!extentIsValid(dem.extent)) {
    setStatus("❌ 覆盖范围无效，无法开始模拟");
    return;
  }
  state.extent = dem.extent;
  state.demInfo = `${dem.sourceName}: ${dem.info}`;

  const rect = Cesium.Rectangle.fromDegrees(...dem.extent);

  fluid = new TerrainFluidSimulation(viewer, dem, options);
  fluid.setDomainMask(domainMaskCanvas, !!state.domain);

  rebuildRegionGui();
  applyRainRegions(); // 应用已有雨区（清空后为无雨）
  refreshButtons();

  const nRain = regionEditor.getActiveRegions().length;
  const domainLabel = state.domain ? `模拟域顶点 ${state.domain.simPoly.length} 个` : "无模拟域";
  setStatus(
    `🌊 <strong>模拟进行中</strong><br>数据：${dem.sourceName} · ${dem.info}<br>` +
      `范围：${extentAreaLabel(dem.extent)} · ${domainLabel} · 雨区数量：<strong>${nRain}</strong><br>` +
      `提示：「🌧 绘制降雨区域」左键加点 / 右键结束（雨区须在橙色模拟域内）；GUI 中可开启全域降雨或调整强度。`,
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
        pixelOffset: new Cesium.Cartesian2(0, -18),
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
  dom.fileInput = $("fileInput");
  dom.statusBar = $("statusBar");

  dom.btnGlobe?.addEventListener("click", () => startGlobalDomainDraw());

  dom.btnUpload.addEventListener("click", () => dom.fileInput.click());
  dom.fileInput.addEventListener("change", () => {
    const f = dom.fileInput.files?.[0];
    dom.fileInput.value = "";
    handleUploadFile(f);
  });

  dom.btnDomain.addEventListener("click", () => {
    if (domainEditor?.drawing) return;
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
}

let gui;
let regionGuiFolder;
let regionControllers = {}; // id -> {folder, ctrls}
const rainProgress = { injected: "0.000" };

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
  fSim.close();

  /* ---- 降雨控制 ---- */
  const fRain = gui.addFolder("降雨控制");
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
      refreshRainSummary();
    });
  fRain
    .add(options, "rainIntensity", 0.0001, 0.003, 0.0001)
    .name("降雨强度(0.0004≈60秒灌满)")
    .onChange(refreshRainSummary);
  fRain.add(options, "wholeAreaRain").name("全域降雨").onChange((v) => {
    dom.btnWholeRain.classList.toggle("danger-active", v);
    applyRainRegions();
    refreshRainSummary();
  });
  fRain
    .add(rainProgress, "injected")
    .name("累计注入量")
    .listen();
  fRain.open();

  regionGuiFolder = fRain; // 区域子文件夹挂到降雨控制下
}

function refreshRainSummary() {
  const n = regionEditor ? regionEditor.getActiveRegions().length : 0;
  const parts = [];
  if (options.rainEnabled) parts.push("🌧 降雨中");
  if (options.wholeAreaRain) parts.push("全域");
  parts.push(`${n} 个雨区`);
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
    this._postRenderCb = () => {
      this._frame += 1;
      if (
        settings.rainEnabled &&
        settings.rainIntensity > 0 &&
        (this._rainMaskLive !== null || settings.wholeAreaRain === true)
      ) {
        this._injectedSum += settings.rainIntensity;
      }
      rainProgress.injected = this._injectedSum.toFixed(3);
    };
    this._viewer.scene.postRender.addEventListener(this._postRenderCb);

    this._entities = [];
    this._buildPipeline(heightMapSource);
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
      rainIntensity: () =>
        settings.rainEnabled ? settings.rainIntensity : 0.0,
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
  hasDomain() {
    return !!state.domain && state.domain.simPoly.length >= 3;
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
