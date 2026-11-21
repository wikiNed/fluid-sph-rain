// 地表水体叠加层：把 SPH 算出来的水深「贴」到真实地形表面。
//
// 为什么不再用体积盒光线步进画水：
// 体积盒里的地形是 1024² 的平滑高度场（DEM 采样 + 5×5 高斯平滑），
// 与 Cesium 渲染的真实地形存在米级差异；而真实雨量下水深常常只有
// 几厘米。要么水面在平滑地形上"悬空"（浮在山坡上、随视角游动，像贴花），
// 要么把片元深度写对后被真实地形整片判掉（水完全看不见）。
//
// 这里改用「贴地多边形 + 自定义材质」：多边形由 Cesium 自动 drape 到
// 真实地形（GroundPrimitive），遮挡关系、起伏贴合全部交给引擎，
// 材质只负责按水面纹理取"水深（米）"并着色，天然不会悬空。

const Cesium = globalThis.Cesium;

const MATERIAL_SOURCE = `
uniform sampler2D waterTexture;
uniform float thicknessM;
uniform float band0;
uniform float band1;
uniform float band2;
uniform float band3;
uniform vec3 color0;
uniform vec3 color1;
uniform vec3 color2;
uniform vec3 color3;
uniform vec3 color4;
uniform float hazeAlpha;
uniform float enabled;

czm_material czm_getMaterial(czm_materialInput materialInput) {
    czm_material m = czm_getDefaultMaterial(materialInput);
    m.diffuse = vec3(0.0);
    m.alpha = 0.0;
    if (enabled < 0.5) return m;

    vec2 st = materialInput.st;
    // 水面纹理的 v=0 在北方（与 rainMask/domainMask 约定一致），
    // 而贴地多边形的 st.y=0 在南边，所以这里翻转一次。
    vec4 data = texture2D(waterTexture, vec2(st.x, 1.0 - st.y));

    // surfaceSmoothing 输出里 data.x 是「水体占盒高的比例」，×0.25 得归一化高度，
    // 再乘以体积盒的真实高程跨度就是水深（米）。
    float meters = data.x * 0.25 * thicknessM;
    if (meters < 0.0002) return m;

    vec3 c = color0;
    c = mix(c, color1, smoothstep(band0, band0 + 0.05, meters));
    c = mix(c, color2, smoothstep(band1, band1 + 0.1, meters));
    c = mix(c, color3, smoothstep(band2, band2 + 0.2, meters));
    c = mix(c, color4, smoothstep(band3, band3 + 0.5, meters));

    // 极浅的水只给淡淡一层，避免整片坡面被蓝色糊住；到第一档开始明显。
    float vis = smoothstep(0.0, max(0.05, band0), meters);
    // 用 emission 而不是 diffuse：地面多边形默认参与光照，
    // diffuse 会被阴影/法线压暗，水色看起来像"黑斑"；emission 是自发光，
    // 颜色只由水深决定（与体积渲染时期的观感一致）。
    m.emission = c * hazeAlpha * mix(0.35, 0.92, vis);
    m.diffuse = vec3(0.0);
    m.alpha = hazeAlpha * mix(0.35, 0.92, vis);
    return m;
}
`;

function cssToCartesian3(css) {
  const c = Cesium.Color.fromCssColorString(css);
  return new Cesium.Cartesian3(c.red, c.green, c.blue);
}

/**
 * 创建地表水体叠加层。
 * @param {Cesium.Viewer} viewer
 * @param {number[]} extent [west, south, east, north]
 * @param {object} opts { texture, thicknessM, bands:[4], colors:[5], waterAlpha }
 */
export function createWaterSurface(viewer, extent, opts = {}) {
  const [west, south, east, north] = extent;
  const uniforms = {
    // Cesium 的 Material 通过「初始值的类型」推断 uniform 类型：
    // 直接放 Cesium.Texture 会被当成 vecN（它是带很多属性的 object），
    // 导致生成 `uniform undefined ...` 并在编译时抛 indexOf 错误。
    // 所以先用一个字符串（推断为 sampler2D），创建后再把真正的纹理塞进去。
    waterTexture: Cesium.Material.DefaultImageId,
    thicknessM: opts.thicknessM ?? 1000,
    band0: (opts.bands ?? [0.1, 0.4, 1, 3])[0],
    band1: (opts.bands ?? [0.1, 0.4, 1, 3])[1],
    band2: (opts.bands ?? [0.1, 0.4, 1, 3])[2],
    band3: (opts.bands ?? [0.1, 0.4, 1, 3])[3],
    color0: cssToCartesian3((opts.colors ?? ["#7fd8ff"])[0]),
    color1: cssToCartesian3((opts.colors ?? ["#2196f3"])[1]),
    color2: cssToCartesian3((opts.colors ?? ["#ffd54f"])[2]),
    color3: cssToCartesian3((opts.colors ?? ["#ff9800"])[3]),
    color4: cssToCartesian3((opts.colors ?? ["#f44336"])[4]),
    hazeAlpha: 0.85,
    enabled: 1.0,
  };

  const material = new Cesium.Material({
    fabric: {
      type: "RainWaterSurface",
      uniforms,
      source: MATERIAL_SOURCE,
    },
  });

  // 类型推断完成后再绑定真正的水面纹理（RGBA float，每帧由 SPH 计算写入）
  if (opts.texture) material.uniforms.waterTexture = opts.texture;

  const positions = Cesium.Cartesian3.fromDegreesArray([west, south, east, south, east, north, west, north]);
  const entity = viewer.entities.add({
    name: "水体表面",
    polygon: {
      hierarchy: new Cesium.PolygonHierarchy(positions),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      material,
      outline: false,
      show: true,
    },
  });

  return {
    entity,
    material,

    setVisible(visible) {
      uniforms.enabled = visible ? 1.0 : 0.0;
      entity.show = !!visible;
    },

    setTexture(texture) {
      material.uniforms.waterTexture = texture;
    },

    /** 更新盒跨度、分档、颜色与透明度（GUI 改动后调用）。 */
    update({ thicknessM, bands, colors, waterAlpha } = {}) {
      if (typeof thicknessM === "number" && thicknessM > 0) uniforms.thicknessM = thicknessM;
      if (Array.isArray(bands) && bands.length >= 4) {
        uniforms.band0 = bands[0];
        uniforms.band1 = bands[1];
        uniforms.band2 = bands[2];
        uniforms.band3 = bands[3];
      }
      if (Array.isArray(colors) && colors.length >= 5) {
        uniforms.color0 = cssToCartesian3(colors[0]);
        uniforms.color1 = cssToCartesian3(colors[1]);
        uniforms.color2 = cssToCartesian3(colors[2]);
        uniforms.color3 = cssToCartesian3(colors[3]);
        uniforms.color4 = cssToCartesian3(colors[4]);
      }
      if (typeof waterAlpha === "number") {
        // 与着色器一致：0 = 完全不透明，1 = 最透（alpha 0.2）
        uniforms.hazeAlpha = 1.0 - 0.8 * Math.min(1, Math.max(0, waterAlpha));
      }
    },

    destroy() {
      viewer.entities.remove(entity);
      material.destroy?.();
    },
  };
}