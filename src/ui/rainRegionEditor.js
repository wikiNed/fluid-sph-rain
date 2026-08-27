const Cesium = globalThis.Cesium;

/** 区域边界配色轮换 */
const PALETTE = [
  "#38bdf8",
  "#f472b6",
  "#a3e635",
  "#fb923c",
  "#c084fc",
  "#2dd4bf",
  "#facc15",
  "#f87171",
];

let nextRegionId = 1;

/**
 * 降雨区域交互绘制与管理。
 *
 * 用法：
 *   const editor = new RainRegionEditor(viewer, { onChange, onStatus });
 *   editor.startDrawing();          // 进入绘制模式（左键加点 / 右键或双击结束）
 *   editor.stopDrawing();
 *   editor.getRegions();            // -> [{id,label,simPoly,intensity,enabled}]
 *
 * 坐标约定见 src/sim/geoUtils.js（simPoly 存着色器空间 uv，v=0 对应北界）。
 */
export class RainRegionEditor {
  /**
   * @param {Cesium.Viewer} viewer
   * @param {{onChange?: Function, onStatus?: Function, onDrawingEnd?: Function}} hooks
   */
  constructor(viewer, hooks = {}) {
    this._viewer = viewer;
    this._hooks = hooks;
    /** @type {[number,number,number,number]|null} */
    this._extent = null;
    this.drawing = false;
    /** @type {Map<number, object>} */
    this.regions = new Map();
    /** @type {Cesium.Cartographic[]} */
    this._pendingCartos = [];
    this._previewEntities = [];
    this._handler = null;
    this._keyHandler = null;
  }

  /* ------------------------------ 绘制控制 ------------------------------ */

  startDrawing(extent) {
    if (!extent) return;
    this._extent = extent;
    this.drawing = true;
    this._ensureHandler();
    this._status("🌧 绘制降雨区域：左键添加顶点，右键 / 双击 / 回车结束，Esc 取消");
  }

  stopDrawing() {
    this.drawing = false;
    if (this._handler) {
      this._handler.destroy();
      this._handler = null;
    }
    this._clearPending();
    if (this._keyHandler) {
      window.removeEventListener("keydown", this._keyHandler);
      this._keyHandler = null;
    }
    this._hooks.onDrawingEnd?.();
  }

  destroy() {
    this.stopDrawing();
    this.clearAll();
  }

  _ensureHandler() {
    if (this._handler) return;
    const h = new Cesium.ScreenSpaceEventHandler(this._viewer.canvas);
    h.setInputAction((movement) => {
      const carto = this._pickCarto(movement.position);
      if (!carto) {
        this._status("⚠ 未拾取到地表位置，请点击模拟范围内");
        return;
      }
      this._pendingCartos.push(carto);
      this._updatePreview();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    h.setInputAction(() => {
      this._finishPending();
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

    h.setInputAction(() => {
      this._finishPending();
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    this._keyHandler = (e) => {
      if (e.key === "Enter") this._finishPending();
      else if (e.key === "Escape") {
        this._clearPending();
        this._status("已取消当前多边形");
      }
    };
    window.addEventListener("keydown", this._keyHandler);

    this._handler = h;
  }

  _finishPending() {
    if (this._pendingCartos.length < 3) {
      this._status("⚠ 多边形至少需要 3 个顶点");
      return;
    }
    this._commitRegion([...this._pendingCartos]);
    this._clearPending();
  }

  _clearPending() {
    this._pendingCartos = [];
    for (const e of this._previewEntities.splice(0)) {
      this._viewer.entities.remove(e);
    }
  }

  /* ------------------------------ 拾取与预览 ---------------------------- */

  _pickCarto(windowPos) {
    const scene = this._viewer.scene;
    let carto = null;
    try {
      const p = scene.pickPosition(windowPos);
      if (p) carto = Cesium.Cartographic.fromCartesian(p);
    } catch (e) {
      /* ignore */
    }
    if (!carto) {
      const ray = this._viewer.camera.getPickRay(windowPos);
      if (ray) {
        const p = scene.globe.pick(ray, scene);
        if (p) carto = Cesium.Cartographic.fromCartesian(p);
      }
    }
    return carto;
  }

  _updatePreview() {
    for (const e of this._previewEntities) this._viewer.entities.remove(e);
    this._previewEntities = [];

    const pts = this._pendingCartos.map((c) =>
      Cesium.Cartesian3.fromRadians(c.longitude, c.latitude),
    );
    if (pts.length > 0) {
      this._previewEntities.push(
        this._viewer.entities.add({
          polyline: {
            positions: pts,
            width: 2,
            clampToGround: true,
            material: new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.WHITE.withAlpha(0.9),
            }),
          },
        }),
      );
    }
    for (const c of this._pendingCartos) {
      this._previewEntities.push(
        this._viewer.entities.add({
          position: Cesium.Cartesian3.fromRadians(c.longitude, c.latitude),
          point: {
            pixelSize: 7,
            color: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.fromCssColorString("#0284c7"),
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
        }),
      );
    }
  }

  /* ------------------------------ 区域提交与维护 ------------------------ */

  _commitRegion(cartos) {
    const extent = this._extent;
    if (!extent || !this._withinExtent(cartos[0], extent)) {
      this._status("⚠ 请在模拟范围内部署降雨区域");
      return;
    }
    const id = nextRegionId++;
    const paletteIdx = (id - 1) % PALETTE.length;
    const colorCss = PALETTE[paletteIdx];
    const color = Cesium.Color.fromCssColorString(colorCss);

    // 着色器空间多边形（uv），以及实体需要的笛卡尔点
    const simPoly = cartos.map((c) => {
      const lon = Cesium.Math.toDegrees(c.longitude);
      const lat = Cesium.Math.toDegrees(c.latitude);
      const [minLon, minLat, maxLon, maxLat] = extent;
      const u = clamp01((lon - minLon) / (maxLon - minLon));
      const v = clamp01(1 - (lat - minLat) / (maxLat - minLat));
      return { u, v };
    });

    const label = `雨区#${id}`;
    const fillEntity = this._viewer.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(
          cartos.map((c) =>
            Cesium.Cartesian3.fromRadians(c.longitude, c.latitude),
          ),
        ),
        material: color.withAlpha(0.1),
        // 不指定 height 时 Cesium 自动以 GroundPrimitive 贴合真实地形。
        // 填充只作轻微指示，避免遮掩盒内真实水体
      },
    });
    const lineEntity = this._viewer.entities.add({
      polyline: {
        positions: [
          ...cartos.map((c) =>
            Cesium.Cartesian3.fromRadians(c.longitude, c.latitude),
          ),
          Cesium.Cartesian3.fromRadians(
            cartos[0].longitude,
            cartos[0].latitude,
          ),
        ],
        width: 2.5,
        clampToGround: true,
        material: color.withAlpha(0.95),
      },
    });
    const labelPos = _centroid(cartsToDegree(cartos));
    const labelEntity = this._viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(labelPos.lon, labelPos.lat),
      label: {
        text: `${label}\n强度 ×1.0`,
        font: "13px sans-serif",
        fillColor: color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.45),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        pixelOffset: new Cesium.Cartesian2(0, -14),
      },
    });

    const region = {
      id,
      label,
      colorCss,
      simPoly,
      intensity: 1.0,
      enabled: true,
      _entities: [fillEntity, lineEntity, labelEntity],
    };
    this.regions.set(id, region);
    this._refreshLabelText(region);
    this._notifyChanged();
    this._status(`✅ ${label} 已加入（顶点 ${simPoly.length}）`);
  }

  _withinExtent(carto, extent) {
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    return (
      lon >= extent[0] &&
      lon <= extent[2] &&
      lat >= extent[1] &&
      lat <= extent[3]
    );
  }

  getRegion(id) {
    return this.regions.get(id);
  }

  setIntensity(id, value) {
    const r = this.regions.get(id);
    if (!r) return;
    r.intensity = value;
    this._refreshLabelText(r);
    this._notifyChanged();
  }

  setEnabled(id, value) {
    const r = this.regions.get(id);
    if (!r) return;
    r.enabled = value;
    for (const e of r._entities) e.show = value;
    this._notifyChanged();
  }

  removeRegion(id) {
    const r = this.regions.get(id);
    if (!r) return;
    for (const e of r._entities) this._viewer.entities.remove(e);
    this.regions.delete(id);
    this._notifyChanged();
  }

  clearAll() {
    for (const [, r] of this.regions) {
      for (const e of r._entities) this._viewer.entities.remove(e);
    }
    this.regions.clear();
    this._notifyChanged();
  }

  /** 导出参与掩膜栅格化的区域列表 */
  getActiveRegions() {
    const out = [];
    for (const [, r] of this.regions) {
      if (r.enabled && r.simPoly.length >= 3) out.push(r);
    }
    return out;
  }

  allRegions() {
    return [...this.regions.values()];
  }

  _refreshLabelText(region) {
    const labelEntity = region._entities[2];
    if (labelEntity?.label) {
      labelEntity.label.text = `${region.label}\n强度 ×${region.intensity.toFixed(1)}${
        region.enabled ? "" : "（停用）"
      }`;
    }
  }

  _notifyChanged() {
    this._hooks.onChange?.(this.getActiveRegions());
  }

  _status(text) {
    this._hooks.onStatus?.(text);
  }
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

function cartsToDegree(cartos) {
  return cartos.map((c) => ({
    lon: Cesium.Math.toDegrees(c.longitude),
    lat: Cesium.Math.toDegrees(c.latitude),
  }));
}

function _centroid(ptsDeg) {
  let lon = 0;
  let lat = 0;
  for (const p of ptsDeg) {
    lon += p.lon;
    lat += p.lat;
  }
  return { lon: lon / ptsDeg.length, lat: lat / ptsDeg.length };
}
