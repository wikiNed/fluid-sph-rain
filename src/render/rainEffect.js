/**
 * 雨滴下落视觉效果（屏幕空间后处理）。
 *
 * 需求：「降雨区域模拟下雨效果（雨滴落下的效果）」
 * —— 只要正在降雨（有启用的雨区，或勾选「全域降雨」），就在画面上叠加
 *    动态雨丝；雨强越大，雨丝越密越亮。该效果纯视觉，不参与 SPH 计算。
 *
 * 实现要点：
 *  1. 用 `Cesium.PostProcessStage` 做屏幕空间叠加，不占用流体管线资源；
 *  2. 3 层不同密度/速度的雨丝 hash 叠加，`uv.y` 随时间偏移 → 屏幕向下移动；
 *  3. `uv.x` 按视口宽高比修正，避免宽屏下雨滴被拉宽；
 *  4. **不用 uniform 分支 / step(uniform) / texelFetch + 提前 return**：
 *     ANGLE(D3D11) 曾把这类写法编译成非法 HLSL（见开发记录 §6.6），
 *     这里全部用纯算术 + smoothstep，避免再次踩坑；
 *  5. 是否启用由外部通过 `stage.enabled` 控制（不下雨时整段不执行）。
 */

/** 屏幕空间雨丝 fragment shader（PostProcessStage 约定：输入 colorTexture） */
const RAIN_EFFECT_FRAGMENT = `
uniform sampler2D colorTexture;
uniform float u_time;
uniform float u_amount;

in vec2 v_textureCoordinates;

// 2D → 1D 稳定 hash（无表、无分支）
float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

// 单层雨丝：按列切分，每列随机相位/速度/位置，竖直方向随时间下移。
// columns   屏幕横向列数（越大雨越密）
// speed     下落速度（越大越快）
// tailLen   雨丝长度（0~1，占一个 hash 段的长度）
// thickness 雨丝粗细（屏幕 UV 单位）
float rainLayer(vec2 uv, float columns, float speed, float tailLen, float thickness) {
    // 列号与列内横向位置
    float x = uv.x * columns;
    float col = floor(x);
    float cell = fract(x);
    float seed = hash21(vec2(col, 11.17));

    // 竖直方向：uv.y 向下偏移（GL 纹理坐标 y 向上，故 + 时间 => 视觉上往下落）
    float y = uv.y * 3.4 + u_time * speed + hash21(vec2(col, 27.53)) * 12.0;
    float seg = floor(y);
    float fy = fract(y);

    // 并不是每个“段”都有雨滴 —— 让画面保持稀疏、更自然
    float alive = smoothstep(0.45, 0.62, hash21(vec2(col, seg * 0.173)));

    // 横向位置（每列内随机，避免雨丝排成整齐竖线）
    float centerX = 0.2 + 0.6 * hash21(vec2(col, seg + 5.1));
    float dx = abs(cell - centerX);
    float thin = smoothstep(thickness, thickness * 0.25, dx);

    // 雨丝形状：头亮尾淡（fy 从 0 往上到 tailLen）
    float tail = smoothstep(0.0, 0.05, fy) * smoothstep(tailLen, 0.05, fy);

    return alive * thin * tail;
}

void main() {
    vec4 scene = texture(colorTexture, v_textureCoordinates);

    vec2 uv = v_textureCoordinates;
    // 宽高比修正：非正方形视口下雨滴不应被拉宽
    float aspect = czm_viewport.z / max(czm_viewport.w, 1.0);
    uv.x *= aspect;
    // 轻微风斜：越靠下越偏右下，雨丝整体约 3° 倾斜，比纯竖直更自然
    uv.x += uv.y * 0.06;

    // 3 层雨丝叠加：密度/速度/亮度不同，形成近景细密 + 远景稀疏的层次
    float drops = 0.0;
    drops += rainLayer(uv,          56.0, 1.25, 0.55, 0.042) * 0.50;
    drops += rainLayer(uv + 0.37,   96.0, 1.85, 0.45, 0.027) * 0.70;
    drops += rainLayer(uv + 0.71,  148.0, 2.55, 0.35, 0.016) * 0.90;
    drops = clamp(drops, 0.0, 1.0) * clamp(u_amount, 0.0, 1.0);

    // 雨丝略偏冷色，并按强度轻微压暗整体画面（阴雨氛围）
    vec3 rainTint = vec3(0.84, 0.90, 1.0);
    vec3 col = mix(scene.rgb, rainTint, drops * 0.58);
    col *= mix(1.0, 0.87, clamp(u_amount, 0.0, 1.0));

    out_FragColor = vec4(col, scene.a);
}
`;

/**
 * 创建雨滴后处理阶段。
 *
 * @param {Cesium.Viewer} viewer
 * @param {object} [opts]
 * @param {() => number} [opts.amount] 返回 0~1 的雨量强度（默认 0.8）。
 *        由 index.js 按「雨区数量 / 全域降雨 / 降雨强度」实时计算，
 *        因此拖动 GUI 雨强滑杆时雨丝密度立即变化。
 * @param {boolean} [opts.enabled] 初始是否启用（默认 false）
 * @returns {{stage: Cesium.PostProcessStage, dispose: () => void, setEnabled: (b:boolean)=>void, getEnabled: () => boolean}}
 */
export function createRainEffect(viewer, opts = {}) {
  const amountFn = typeof opts.amount === "function" ? opts.amount : () => 0.8;

  const stage = new Cesium.PostProcessStage({
    name: "rain-effect",
    fragmentShader: RAIN_EFFECT_FRAGMENT,
    uniforms: {
      u_time: () => performance.now() * 0.001,
      u_amount: () => {
        const v = Number(amountFn());
        return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1.5) : 0.8;
      },
    },
  });
  stage.enabled = !!opts.enabled;

  viewer.scene.postProcessStages.add(stage);

  return {
    stage,
    setEnabled(on) {
      stage.enabled = !!on;
    },
    getEnabled() {
      return stage.enabled;
    },
    dispose() {
      viewer.scene.postProcessStages.remove(stage);
    },
  };
}