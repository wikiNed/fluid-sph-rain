/**
 * SPH 流体模拟着色器集合。
 *
 * 着色器代码移植自 https://www.shadertoy.com/view/7tSSDD 及 https://www.shadertoy.com/view/l33Sz8，
 * 由 [少年啦1997] 的开源项目 fluid-sph 移植到 Cesium。
 * 本文件将原本内联在 index.js 中的着色器字符串抽出，并新增“降雨掩膜注入”能力：
 *   - uniform sampler2D rainMask : R 通道 ∈[0,1]，按高程图同规格 north-up 位图编码
 *     各降雨区域的相对强度（全域降雨时可整幅填充）。
 *   - Simulation() 中每步按 rainIntensity * dt * mask 在粒子所在格累加质量。
 */

export const sphKernelSource = `
#define Bi(p) ivec2(mod(p, vec2(float(textureSize))))
#define texel(a, p) texelFetch(a, Bi(p), 0)
// 整数像素采样（无隐式导数 dFdx/dFdy，规避 ANGLE/D3D11 延迟编译对 texture() 的竞态）
#define texelC(a, p) texelFetch(a, clamp(ivec2(p), ivec2(0), ivec2(textureSize - 1)), 0)

#define range(i,a,b) for(int i = a; i <= b; i++)

const int textureSize = 1024;
#define dt 1.0
// 重力参数
uniform float gravity;
// 分布直径
#define dist 1.00
// 扩散
#define dif 0.3
#define difd 0.0
// 初始质量
uniform float initialMass;

// 水源控制（保留原版点击点源注水）
uniform vec2 waterSource;
uniform float waterSourceRadius;
uniform float waterAddRate;

// ===== 降雨控制 =====
// 降雨强度（每步向掩膜非零格累加的质量），由 GUI/全局开关驱动
uniform float rainIntensity;
// 降雨掩膜：R 通道 ∈[0,1]，north-up，与高程图同规格
uniform sampler2D rainMask;

// ===== 模拟域约束 =====
// 域掩膜：R=1 域内，R=0 域外，north-up，与高程图同 uv
uniform sampler2D domainMask;
// 是否启用模拟域约束（0=退回原始矩形盒边界，1=启用多边形域）
uniform float domainEnabled;

// 采样模拟域（域内≈1，域外≈0）——整数像素采样，规避 texture() 隐式导数。
// 注意 ANGLE/D3D11 兼容：含 texelFetch 的函数里绝不能放条件 early return，
// 也不要把 step(uniform) 乘进采样结果，否则 GLSL→HLSL 翻译会生成非法 HLSL，
// 表现为 "Fragment shader failed to compile" + 空编译日志（真机 GPU 才复现，
// SwiftShader 正常）。未启用域时绑定全白纹理，采样天然返回 1.0，无需额外判断。
float domainAt(vec2 worldPos) {
    return texelC(domainMask, worldPos).r;
}

// 模拟域边界法向（指向域内）。基于掩膜梯度，仅用于边界附近。
// 全白掩膜下四邻相等 → 梯度为 0，无需 domainEnabled 判断。
vec2 domainNormal(vec2 worldPos) {
    vec2 p = clamp(worldPos, vec2(0.0), vec2(float(textureSize - 1)));
    float l = texelC(domainMask, p - vec2(2.0, 0.0)).r;
    float r = texelC(domainMask, p + vec2(2.0, 0.0)).r;
    float d = texelC(domainMask, p - vec2(0.0, 2.0)).r;
    float u = texelC(domainMask, p + vec2(0.0, 2.0)).r;
    return vec2(r - l, u - d);
}

#define border_h 5.

uniform sampler2D heightMap;

// 从heightMap读取地形高度 (替代Perlin噪声)
float terrainHeight(vec2 pos) {
    vec2 uv = pos / float(textureSize);
    uv = clamp(uv, 0.0, 1.0);
    float h = texture(heightMap, uv).r;
    // 缩放到合适的范围
    return h * 4.0;
}

vec2 terrainGrad(vec2 pos) {
    const float eps = 1.0;
    vec2 n = vec2(
        terrainHeight(pos + vec2(eps, 0.0)) - terrainHeight(pos - vec2(eps, 0.0)),
        terrainHeight(pos + vec2(0.0, eps)) - terrainHeight(pos - vec2(0.0, eps))
    ) / (2.0 * eps);
    return n;
}

// 估算单元内分布大小
vec2 destimator(vec2 dx, float M) {
    return dist * clamp(1.0 - difd * abs(dx), 0.002, 1.0) + dif * dt;
}

float sdBox(in vec2 p, in vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float border(vec2 p) {
    vec2 R = vec2(float(textureSize));
    float bound = -sdBox(p - R * 0.5, R * vec2(0.5, 0.5));
    return bound;
}

const float BORDER_STEP = 1.0;
vec3 bN(vec2 p) {
    vec3 dx = vec3(-BORDER_STEP, 0.0, BORDER_STEP);
    vec4 idx = vec4(-1.0 / BORDER_STEP, 0.0, 1.0 / BORDER_STEP, 0.25);
    vec3 r = idx.zyw * border(p + dx.zy) + idx.xyw * border(p + dx.xy) + idx.yzw * border(p + dx.yz) + idx.yxw * border(p + dx.yx);
    return vec3(normalize(r.xy), r.z + 1e-4);
}

vec2 decode(float x) {
    uint X = floatBitsToUint(x);
    return unpackSnorm2x16(X);
}

float encode(vec2 x) {
    uint X = packSnorm2x16(clamp(x, vec2(-1.0), vec2(1.0)));
    return uintBitsToFloat(X);
}

struct particle {
    vec2 X;
    vec2 V;
    vec2 M;
};

particle getParticle(vec4 data, vec2 pos) {
    particle P;
    P.X = decode(data.x) + pos;
    P.V = decode(data.y);
    P.M = data.zw;
    return P;
}

vec4 saveParticle(particle P, vec2 pos) {
    P.X = clamp(P.X - pos, vec2(-0.5), vec2(0.5));
    return vec4(encode(P.X), encode(P.V), P.M);
}

vec3 hash32(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
}

float G(vec2 x) {
    return exp(-dot(x, x));
}

vec3 distribution(vec2 x, vec2 p, vec2 K) {
    vec4 aabb0 = vec4(p - 0.5, p + 0.5);
    vec4 aabb1 = vec4(x - K * 0.5, x + K * 0.5);
    vec4 aabbX = vec4(max(aabb0.xy, aabb1.xy), min(aabb0.zw, aabb1.zw));
    vec2 center = 0.5 * (aabbX.xy + aabbX.zw);
    vec2 size = max(aabbX.zw - aabbX.xy, 0.0);
    float m = size.x * size.y / (K.x * K.y);
    return vec3(center, m);
}

// 扩散和平流 - 粒子重积分
void Reintegration(sampler2D ch, inout particle P, vec2 pos) {
    range(i, -2, 2) range(j, -2, 2) {
        vec2 tpos = pos + vec2(i, j);
        vec4 data = texel(ch, tpos);

        particle P0 = getParticle(data, tpos);

        vec2 dx0 = P0.X - tpos;
        vec2 difR = destimator(dx0, P0.M.x);
        P0.X += P0.V * dt;

        vec3 D = distribution(P0.X, pos, difR);
        float m = P0.M.x * D.z;

        P.X += D.xy * m;
        P.V += P0.V * m;
        P.M.y += P0.M.y * m;
        P.M.x += m;
    }

    if(P.M.x != 0.0) {
        P.X /= P.M.x;
        P.V /= P.M.x;
        P.M.y /= P.M.x;
    }
}

// SPH力计算和积分
void Simulation(sampler2D ch, inout particle P, vec2 pos,
                sampler2D rainMask) {
    vec2 F = vec2(0.0);
    vec3 avgV = vec3(0.0);

    range(i, -2, 2) range(j, -2, 2) {
        vec2 tpos = pos + vec2(i, j);
        vec4 data = texel(ch, tpos);
        particle P0 = getParticle(data, tpos);
        vec2 dx = P0.X - P.X;
        float avgP = gravity * 0.1 * P0.M.x * (P.M.x + P0.M.x);
        F -= 0.5 * G(1.0 * dx) * avgP * dx;
        avgV += P0.M.x * G(1.0 * dx) * vec3(P0.V, 1.0);
    }

    // 地形梯度产生平坦水面
    F -= gravity * 0.232 * P.M.x * terrainGrad(pos);
    avgV.xy /= avgV.z;

    // 水源添加（点源）
    float srcDist = distance(pos / float(textureSize), waterSource);
    if(srcDist < waterSourceRadius) {
        P.M.x += waterAddRate * dt;
    }

    // 降雨注入：掩膜 R 通道编码降雨区域相对强度，持续累加质量进入实时模拟。
    // 乘域掩膜保证全域降雨也只落在模拟域内（域外不注水）。
    if(rainIntensity > 0.0) {
        vec2 sp = clamp(pos, vec2(0.0), vec2(float(textureSize - 1)));
        P.M.x += rainIntensity * dt * texelC(rainMask, sp).r * texelC(domainMask, sp).r;
    }

    // 积分
    F -= P.V * 0.0005; // 地面摩擦
    P.V += F * dt / P.M.x;

    // 边界处理（原始矩形盒，作为最外层安全边界）
    vec3 N = bN(P.X);
    float vdotN = step(N.z, border_h) * dot(-N.xy, P.V);
    P.V += 0.5 * (N.xy * vdotN + N.xy * abs(vdotN));

    if(N.z < 0.0)
        P.V = vec2(0.0);

    // ===== 模拟域边界约束（多边形域，水被限制在域内） =====
    if(domainEnabled > 0.5) {
        float dom = texelC(domainMask, P.X).r;
        if(dom < 0.5) {
            P.M.x *= mix(0.85, 0.0, step(dom, 0.1));
            vec2 dn = domainNormal(P.X);
            float dnLen = length(dn);
            if(dnLen > 0.001) {
                dn /= dnLen;
                float vn = dot(P.V, dn);
                if(vn < 0.0) P.V -= 1.5 * vn * dn;
            }
        }
    }

    // 速度限制
    float v = length(P.V);
    P.V /= (v > 1.0) ? v : 1.0;
}

// 渲染用的工具函数
vec2 hitBox(vec3 orig, vec3 dir) {
   const vec3 box_min = vec3(-0.5);
   const vec3 box_max = vec3(0.5);
   vec3 inv_dir = 1.0 / dir;
   vec3 tmin_tmp = (box_min - orig) * inv_dir;
   vec3 tmax_tmp = (box_max - orig) * inv_dir;
   vec3 tmin = min(tmin_tmp, tmax_tmp);
   vec3 tmax = max(tmin_tmp, tmax_tmp);
   float t0 = max(tmin.x, max(tmin.y, tmin.z));
   float t1 = min(tmax.x, min(tmax.y, tmax.z));
   return vec2(t0, t1);
}
`;

// SPH BufferA: 粒子初始化和重积分
export const particleIntegrationSource = `
uniform sampler2D iChannel0;
uniform int iFrame;

void main() {
    vec2 pos = gl_FragCoord.xy;

    // 超出范围则丢弃
    if(max(pos.x, pos.y) > float(textureSize))
       discard;

    vec4 data = texel(iChannel0, pos);
    particle P;
    P.X = vec2(0.0);
    P.V = vec2(0.0);
    P.M = vec2(0.0);

    Reintegration(iChannel0, P, pos);

    // 初始条件
    if(iFrame < 1) {
        vec3 rand = hash32(pos + vec2(0.0, 1.0) + 0.28);
        // 全覆盖初始化：每个格子都带微量“幽灵质量”作为雨水附着载体，
        // 降雨注入后质量增长成为可见水体并沿地形汇流。
        // （原版仅 60% 格子有粒子、40% 为空格，降雨场景下会造成附着不全）
        P.X = pos + 0.3 * (rand.yz - 0.5);
        P.V = 0.65 * (rand.xy - 0.5);
        P.M = vec2(max(initialMass, 1e-6), 0.0);
    }

    out_FragColor = saveParticle(P, pos);
}
`;

// SPH BufferB: 物理模拟
export const particleSimulationSource = `
uniform sampler2D iChannel0;

void main() {
    vec2 pos = gl_FragCoord.xy;

    // 超出范围则丢弃
    if(max(pos.x, pos.y) > float(textureSize))
       discard;

    vec4 data = texel(iChannel0, pos);
    particle P = getParticle(data, pos);

    if(P.M.x != 0.0) { // 非真空
        Simulation(iChannel0, P, pos, rainMask);
    }

    out_FragColor = saveParticle(P, pos);
}
`;

// SPH BufferC: 平滑高度场（用于渲染）
export const surfaceSmoothingSource = `
uniform sampler2D iChannel0;

void main() {
    vec2 pos = gl_FragCoord.xy;

    // 超出范围则丢弃
    if(max(pos.x, pos.y) > float(textureSize))
       discard;

    float rho = 0.;
    float hei = 0.;
    float weight = 0.0;

    // 平滑高度场
    range(i, -2, 2) range(j, -2, 2) {
        vec2 pos0 = pos + vec2(float(i), float(j));
        vec4 data = texel(iChannel0, pos0);
        particle P0 = getParticle(data, pos0);
        vec2 dx = pos - pos0;
        float w = G(0.75 * dx);
        weight += w;
        rho += getParticle(texel(iChannel0, pos0), pos0).M.x * w;
        hei += terrainHeight(pos0) * w;
    }

    // 输出: x=水密度(高度), y=地形高度, w=总高度(水+地形)
    // 水密度乘域掩膜：域外 rho=0 → 渲染层绝对无水；地形高度不受影响（保留地形上下文）
    float waterRho = (rho / weight) * domainAt(pos);
    float terrainH = hei / weight;
    out_FragColor = vec4(waterRho, terrainH, 0.0, waterRho + terrainH);
}
`;

// SPH渲染着色器 - 带Fresnel效果和水下颜色衰减
export const fluidVolumeFragmentSource = `
uniform sampler2D iChannel0;
uniform int depth;
uniform vec3 shallow;
uniform vec3 deep;
uniform float waterAlpha;
// —— 5 档水深配色（0/2/5/10/20 米）——
uniform vec3 depthColor0;
uniform vec3 depthColor1;
uniform vec3 depthColor2;
uniform vec3 depthColor3;
uniform vec3 depthColor4;
uniform float depthBand0;
uniform float depthBand1;
uniform float depthBand2;
uniform float depthBand3;
uniform float depthRangeM;
uniform float depthColorEnabled;
in vec3 vo;
in vec3 vd;

const vec3 lightDir = normalize(vec3(1.0, 1.0, 1.0));
// 高度缩放因子：terrainHeight = DEM归一化高程 × 4.0，
// 4.0 × heightScale 必须等于 1，盒内地形才能与体积盒的绝对高程区间
// [minElevation, maxElevation] 精确对齐（否则水面会沉入真实地形之下）
const float heightScale = 0.25;

// 从SPH BufferC获取高度数据
// 返回: x=地形高度, y=水面高度(地形+水)
vec2 getHeight(in vec3 p) {
    vec2 uv = p.xz + 0.5;
    uv = clamp(uv, 0.0, 1.0);
    vec4 data = texture(iChannel0, uv);
    // data.x = 水密度(水高度), data.y = 地形高度, data.w = 总高度
    // 水面高度截断在体积盒内（data 与 data.y 同量纲，4.0 = 整盒高），
    // 否则水灌满后水面会跑到盒顶之外，光线在盒入口即命中，退化成一整块平面色。
    float terrainH = data.y * heightScale;
    float waterH = min(data.y + data.x, 4.0) * heightScale;
    return vec2(terrainH - 0.5, waterH - 0.5);
}

// 获取水深（归一化：0~1 表示占满整个体积盒）
float getWaterDepth(in vec3 p) {
    vec2 uv = p.xz + 0.5;
    uv = clamp(uv, 0.0, 1.0);
    vec4 data = texture(iChannel0, uv);
    return data.x * heightScale;
}

// 5 档水深配色：把实际水深（米）映射到 5 段颜色。
// 入参为米，uniform 均为 sRGB，这里统一走 czm_gammaCorrect 转到线性空间。
// 使用 smoothstep 过渡（±0.25m 羽化）而不是 if/step(uniform)，避免
// ANGLE/D3D11 把 uniform 分支编译成非法 HLSL（见开发记录 §6.6）。
vec3 depthRamp(float depthM) {
    vec3 c = czm_gammaCorrect(depthColor0);
    c = mix(c, czm_gammaCorrect(depthColor1), smoothstep(depthBand0 - 0.25, depthBand0 + 0.25, depthM));
    c = mix(c, czm_gammaCorrect(depthColor2), smoothstep(depthBand1 - 0.25, depthBand1 + 0.25, depthM));
    c = mix(c, czm_gammaCorrect(depthColor3), smoothstep(depthBand2 - 0.25, depthBand2 + 0.25, depthM));
    c = mix(c, czm_gammaCorrect(depthColor4), smoothstep(depthBand3 - 0.25, depthBand3 + 0.25, depthM));
    return c;
}

// 计算法线
vec3 getNormal(in vec3 p, int comp) {
   float d = 2.0 / float(textureSize);
    float hMid = (comp == 0) ? getHeight(p).x : getHeight(p).y;
    float hRight = (comp == 0) ? getHeight(p + vec3(d, 0, 0)).x : getHeight(p + vec3(d, 0, 0)).y;
    float hTop = (comp == 0) ? getHeight(p + vec3(0, 0, d)).x : getHeight(p + vec3(0, 0, d)).y;
   return normalize(cross(vec3(0, hTop - hMid, d), vec3(d, hRight - hMid, 0)));
}

// Fresnel效果
float fresnel(vec3 viewDir, vec3 normal) {
    float cosTheta = max(dot(-viewDir, normal), 0.0);
    // Schlick近似
    float F0 = 0.02; // 水的Fresnel系数
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}

vec4 Render(in vec3 ro, in vec3 rd) {
   vec3 rayDir = normalize(rd);
   vec2 ret = hitBox(ro, rayDir);
   if (ret.x > ret.y) discard;

   ret.x = max(ret.x, 0.0);

    // 光线步进找地形
       float tt = ret.x;
       for (int i = 0; i < depth; i++) {
          vec3 p = ro + rd * tt;
          float h = p.y - getHeight(p).x;
          if (h < 0.0002 || tt > ret.y)
          break;
          tt += h * 0.4;
        }

    // 光线步进找水面
       float wt = ret.x;
           for (int i = 0; i < depth; i++) {
               vec3 p = ro + rd * wt;
               float h = p.y - getHeight(p).y;
               if (h < 0.0002 || wt > min(tt, ret.y))
               break;
               wt += h * 0.4;
           }

    vec3 tc = vec3(0.0);
    float alpha = 0.0;

    // 相机进入体积盒内部时渲染阶段会关闭深度测试（盒内所有面被背面剔除，
    // 详见 FluidPipelineStages.js volumeInsideRenderState），遮挡完全由这里判断：
    // 水面必须在「地形命中点」之前才算可见，否则丢弃，避免把山后的水画到山前。
    if (wt < min(tt, ret.y)) {
        vec3 waterPos = ro + rd * wt;
        float waterDepth = getWaterDepth(waterPos);

        if (waterDepth > 0.001) {
            vec3 waterNormal = getNormal(waterPos, 1);

            // Fresnel反射
            float F = fresnel(rayDir, waterNormal);

            // 反射方向
            vec3 reflectDir = reflect(rayDir, waterNormal);

            // GUI 和常量颜色均为 sRGB；Cesium HDR 光照需要在线性空间中计算
            vec3 skyColor = mix(
                czm_gammaCorrect(vec3(0.5, 0.7, 1.0)),
                czm_gammaCorrect(vec3(0.2, 0.4, 0.8)),
                reflectDir.y * 0.5 + 0.5
            );

            // 水下颜色衰减
            float underwaterDist = min(tt - wt, 0.3);
            vec3 underwaterColor = exp(-0.18 * vec3(1.0, 0.467, 0.180) * max(underwaterDist * 100.0, 0.0));

            // 基础水颜色（将 GUI 的 sRGB 颜色转为线性颜色后再按深度混合）
            vec3 waterColor = mix(
                czm_gammaCorrect(shallow),
                czm_gammaCorrect(deep),
                smoothstep(0.0, 0.1, waterDepth)
            );

            // 5 档水深配色：waterDepth 是“占体积盒高度的归一化比例”，
            // 乘以「满档水深」标定值 depthRangeM（米，默认 40，可调）得到图例米数。
            // 注意不能用体积盒真实跨度（高程差常见上千公里级），否则几秒内
            // 全部落进 >20m 红色档，五档配色失去区分度（见开发记录 §5.10）。
            // 用 clamp 出的 0/1 系数做 mix，避免 uniform 分支被 ANGLE 编译成非法 HLSL。
            float depthColorMix = clamp(depthColorEnabled, 0.0, 1.0);
            waterColor = mix(
                waterColor,
                depthRamp(waterDepth * depthRangeM),
                depthColorMix
            );

            // 高光
            float spec = pow(max(dot(lightDir, reflectDir), 0.0), 64.0);

            // 混合基础水色和天空反射
            tc = mix(waterColor * underwaterColor, skyColor, F * 0.5);
            tc += spec * vec3(1.0) * 0.8;

            // 透明度：完全由 GUI「水透明度」控制（0 = 完全不可见）。
            // 不能用 mix(0.3, waterAlpha, ...)：那样滑块拉到 0 仍有 0.3 的底噪，
            // 看起来“透明但还在”。Fresnel/高光也按 waterAlpha 缩放，否则 0 透明度下
            // 高光仍会在水面上画出一层亮膜。
            alpha = waterAlpha * smoothstep(0.0, 0.05, waterDepth);
            alpha = clamp(alpha + waterAlpha * (F * 0.3 + spec * 0.5), 0.0, 1.0);
        }
    }

    // 如果没有水但有地形
    if (alpha < 0.01 && tt < ret.y) {
        discard;
    }

       return vec4(tc, alpha);
}

void main() {
   vec3 rayDir = normalize(vd);
   vec4 col = Render(vo, rayDir);
    if (col.a < 0.01) {
       discard;
   }
   out_FragColor = col;
}
`;
