const Cesium = globalThis.Cesium;

/**
 * 模拟域编辑器：在高程图覆盖范围内绘制唯一的模拟域多边形。
 *
 * 流程：
 *   editor.startDrawing(extent)  // 进入绘制
 *   左键加点 → 右键/双击/回车闭合（≥3 顶点）
 *   editor.onChange → 通知主控生成域掩膜并启动模拟
 *
 * 坐标约定见 src/sim/geoUtils.js（simPoly 存着色器空间 uv，v=0 对应北界）。
 */
export class DomainEditor {
  constructor(viewer, hooks = {}) {
    this._viewer = viewer;
    this._hooks = hooks;
    /** @type {[number,number,number,number]|null} 高程图覆盖范围（域必须画在其中） */
    this._extent = null;
    /** @type {{simPoly:{u:number,v:number}[], cartos:Object[], label:string}|null} */
    this.domain = null;
    this.drawing = false;
    this._pendingCartos = [];
    this._previewEntities = [];
    this._domainEntities = [];
    this._handler = null;
    this._keyHandler = null;
  }

  /* ------------------------------ 绘制控制 ------------------------------ */

  /**
   * 进入绘制模式。
   * @param {Array|null} extent 顶点必须落在该经纬度范围内；传 null 表示「全球自由绘制」
   *                           （用户在全球地形上任意画，提交时由多边形 bbox 反推范围）
   */
  startDrawing(extent) {
    this._freeMode = !Array.isArray(extent) || extent.length !== 4;
    this._extent = this._freeMode ? null : extent;
    this.drawing = true;
    this.clearDomain(false); // 清除旧域实体，但保留数据直到新域提交
    this._ensureHandler();
    this._status(
      this._freeMode
        ? "🗺 划定模拟域（全球地形）：左键在任意地表添加顶点，右键 / 双击 / 回车闭合，Esc 取消"
        : "🗺 划定模拟域：左键添加顶点（须落在高程图覆盖范围内），右键 / 双击 / 回车闭合，Esc 取消",
    );
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
    this.clearDomain();
  }

  _ensureHandler() {
    if (this._handler) return;
    const h = new Cesium.ScreenSpaceEventHandler(this._viewer.canvas);
    h.setInputAction((movement) => {
      const carto = this._pickCarto(movement.position);
      if (!carto) {
        this._status("⚠ 未拾取到地表位置，请在高程图覆盖范围内点击");
        return;
      }
      if (!this._withinExtent(carto)) {
        this._status(
          this._freeMode
            ? "⚠ 未拾取到地表位置，请在地形上点击"
            : "⚠ 该点在高程图覆盖范围之外，请在范围内点击",
        );
        return;
      }
      this._pendingCartos.push(carto);
      this._updatePreview();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    h.setInputAction(() => this._finishPending(), Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    h.setInputAction(() => this._finishPending(), Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    this._keyHandler = (e) => {
      if (e.key === "Enter") this._finishPending();
      else if (e.key === "Escape") {
        this._clearPending();
        this._status("已取消当前模拟域绘制");
      }
    };
    window.addEventListener("keydown", this._keyHandler);
    this._handler = h;
  }

  _finishPending() {
    if (this._pendingCartos.length < 3) {
      this._status("⚠ 模拟域至少需要 3 个顶点");
      return;
    }
    this._commit([...this._pendingCartos]);
    this._clearPending();
  }

  _clearPending() {
    this._pendingCartos = [];
    for (const e of this._previewEntities.splice(0)) this._viewer.entities.remove(e);
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
            outlineColor: Cesium.Color.fromCssColorString("#ea580c"),
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
        }),
      );
    }
  }

  /* ------------------------------ 提交与维护 ---------------------------- */

  /** 提交模拟域（cartos 经纬度数组，弧度） */
  _commit(cartos) {
    if (!cartos || cartos.length < 3) {
      this._status("⚠ 模拟域至少需要 3 个顶点");
      return false;
    }
    // 全球自由绘制模式：顶点可为任意地表位置，提交时由多边形 bbox 反推覆盖范围
    if (this._freeMode) {
      const lons = cartos.map((c) => Cesium.Math.toDegrees(c.longitude));
      const lats = cartos.map((c) => Cesium.Math.toDegrees(c.latitude));
      this._extent = [
        Math.min(...lons),
        Math.min(...lats),
        Math.max(...lons),
        Math.max(...lats),
      ];
    } else if (cartos.some((c) => !this._withinExtent(c))) {
      this._status("⚠ 模拟域顶点必须在高程图覆盖范围内");
      return false;
    }
    const extent = this._extent;

    const [minLon, minLat, maxLon, maxLat] = extent;
    const simPoly = cartos.map((c) => {
      const lon = Cesium.Math.toDegrees(c.longitude);
      const lat = Cesium.Math.toDegrees(c.latitude);
      return {
        u: clamp01((lon - minLon) / (maxLon - minLon)),
        v: clamp01(1 - (lat - minLat) / (maxLat - minLat)),
      };
    });

    this.domain = {
      simPoly,
      cartos: [...cartos],
      label: "模拟域",
      extent: [...extent], // 供主控采样真实地形（全球模式由 bbox 反推）
    };
    this._renderDomain(cartos);
    // 先播报提交成功，再通知主控（主控会设置更完整的"模拟进行中"状态覆盖它）
    this._status(`✅ 模拟域已划定（顶点 ${simPoly.length}）`);
    this._notifyChanged();
    return true;
  }

  _withinExtent(carto) {
    if (this._freeMode) return true; // 全球模式：任意地表位置都可
    const e = this._extent;
    if (!e) return false;
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    return lon >= e[0] && lon <= e[2] && lat >= e[1] && lat <= e[3];
  }

  _renderDomain(cartos) {
    // 只清理旧实体，绝不在此清空 this.domain（否则 _commit 的 onChange 会拿到 null）
    for (const e of this._domainEntities.splice(0)) this._viewer.entities.remove(e);
    const color = Cesium.Color.fromCssColorString("#f59e0b");

    this._domainEntities.push(
      this._viewer.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            cartos.map((c) => Cesium.Cartesian3.fromRadians(c.longitude, c.latitude)),
          ),
          material: color.withAlpha(0.08),
        },
      }),
      this._viewer.entities.add({
        polyline: {
          positions: [
            ...cartos.map((c) =>
              Cesium.Cartesian3.fromRadians(c.longitude, c.latitude),
            ),
            Cesium.Cartesian3.fromRadians(cartos[0].longitude, cartos[0].latitude),
          ],
          width: 3,
          clampToGround: true,
          material: color.withAlpha(0.95),
        },
      }),
    );
  }

  getDomain() {
    return this.domain;
  }

  hasDomain() {
    return !!this.domain && this.domain.simPoly.length >= 3;
  }

  clearDomain(notify = true) {
    for (const e of this._domainEntities.splice(0)) this._viewer.entities.remove(e);
    this.domain = null;
    if (notify) this._notifyChanged();
  }

  _notifyChanged() {
    this._hooks.onChange?.(this.domain);
  }

  _status(text) {
    this._hooks.onStatus?.(text);
  }
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}
