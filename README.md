# fluid-sph-rain · Cesium流体模拟（高程驱动 + 降雨模拟增强版）

> 📖 **详细开发文档见 [DEVELOPMENT.md](DEVELOPMENT.md)** —— 架构设计、坐标约定、修复记录、测试体系、调参指南。

在 [少年啦1997] 的开源项目 fluid-sph 基础上增强：

- 着色器代码移植自 https://www.shadertoy.com/view/7tSSDD 及 https://www.shadertoy.com/view/l33Sz8
- 原始管线：固定 PNG 高程图 + 固定经纬度范围（`config.extent`）+ Cesium Primitive 自定义 DrawCommand 的 GPU SPH 流体模拟。

## 新增功能

### 1. 上传高程图，自动解析覆盖范围并划定模拟区域
- 顶部工具栏「📂 上传高程图」或 GUI「高程数据 → 上传高程图」，支持 `.tif / .tiff / .png / .jpg / .jpeg / .webp`。
- **GeoTIFF**：自动读取地理参考（ModelTiepoint / ModelPixelScale / GeoKeyDirectory），
  解析出经纬度覆盖范围，飞行定位并将高程图叠置显示在对应区域，绘制模拟范围边框与标注。
  - **地理坐标系**（EPSG:4326 系）：包围盒直接作为经纬度范围。
  - **投影坐标系**（UTM、CGCS2000 高斯克吕格、Lambert 等）：通过 GeoKey 解析 + proj4
    自动换算为经纬度后定位，无需手动放置。WGS84 UTM（EPSG:326xx/327xx）与
    中国 CGCS2000 系列（如 EPSG:4490 / 4547）均已覆盖；
    仅当缺少地理参考或换算失败时才降级为手动放置，并在状态栏说明原因。
  - 自动剔除 NoData 像元后再统计高程范围。
- **普通图片**：亮度即高程；自动检测并裁剪纯色/透明边框得到有效数据区，
  随后进入手动放置流程——在底图上单击一点作为模拟区域中心，
  通过 GUI「放置宽度(km)」控制真实世界尺度（按纬度做经度缩放）；
  放置时自动采样真实地形高程，模拟体积盒贴合地表
  （「地形起伏跨度(米)」控制盒子的竖直厚度）。
- 内置示例数据自动加载，打开页面即可看到效果；GUI 可随时重新加载。
- 基础地形数据：默认加载 ArcGIS 全球地形（WorldElevation3D，免 Token），
  地表拾取、雨区实体、模拟范围框均贴合真实地形；
  配置 `CESIUM_ION_TOKEN` 后自动改用 Cesium World Terrain（Ion 地形资产 1）。
- 底图：默认 ArcGIS World 卫星影像，失败依次回退 OpenStreetMap → 无底图；
  离线环境也可运行（仅影响底图显示，不影响模拟本身）。

### 2. 在模拟范围内交互划定一个或多个降雨区域
- 「🌧 绘制降雨区域」进入绘制模式：左键添加顶点，右键 / 双击 / 回车结束，Esc 取消。
- 支持任意数量多边形雨区；每个雨区在 GUI「降雨控制」下有独立子面板：
  启用/停用、强度倍数（0~2）、删除，实体颜色轮换便于区分。
- 雨区多边形实时栅格化为 1024² 降雨掩膜纹理（重叠区取最大强度）。

### 3. 降雨区域累加雨量并实时驱动流体模拟
- SPH 模拟步中新增 `rainMask` 采样注入：`质量 += 降雨强度 × dt × 掩膜值`，
  注入的质量持续参与平流、地形梯度受力与渲染——即降雨累积 → 汇流 → 动态水面。
- 雨水"先附着地表、再汇聚流动"：
  - 模拟网格全覆盖初始化微量幽灵质量作为附着载体（原版仅 60% 格子有粒子），
    降雨可落在任意地表位置并逐渐积蓄成薄水层；
  - 降雨强度建议 0.003~0.02（GUI 上限 0.1）：强度过大时 SPH 压力项与质量平方成正比，
    薄层会失稳成尖刺，无法呈现贴地汇流形态。
- 「开始降雨」总开关、「降雨强度」全局滑杆、「全域降雨」一键对整个模拟范围降雨；
  「累计注入量」实时显示当前降雨过程的累积注入。
- 保留原版点击点源注水交互（需勾选「点源注水(点击生效)」）。

## 运行

```bash
# 任一静态服务器指向本目录即可，例如
npx http-server -p 8080          # 或 python -m http.server
# 浏览器打开 http://127.0.0.1:8080
```

需要 WebGL2 支持（Chrome / Edge 现代版本）。

## 代码结构

```
index.html                     工具栏 / 状态栏 / GUI 宿主
index.js                       主控：数据流、放置流程、模拟生命周期、GUI
src/sim/shaders.js             SPH 着色器（含 rainMask 降雨注入）
src/sim/geoUtils.js            经纬度 ⇄ 纹理UV ⇄ 画布像素 的统一换算约定
src/sim/rainMask.js            雨区多边形 → 降雨掩膜画布（lighten 合成）
src/io/elevationLoader.js      GeoTIFF/普通图片解析与覆盖范围自动分析
src/io/projection.js           地理参考解析：GeoKey → proj4 → 经纬度覆盖范围
src/ui/rainRegionEditor.js     降雨区域交互绘制与管理
src/render/FluidPipelineStages.js   原版 Compute/Volume 渲染阶段
libs/geotiff.min.js            GeoTIFF 解析库（jsdelivr 构建）
libs/proj4.js                  投影坐标系转换库（jsdelivr 构建）
static/1722500831109.png       内置示例高程图
```

## 其他说明

代码分享本身就是学习技术思路，没有人会把自己赚钱的业务代码分享出来。但是有的人，拿着你分享去开源代码去闲鱼售卖，被发现之后狗急跳墙来一句“就你这开源效果，就TM卖也卖不出去啊”。然后来一句“这不是你代码啊哥们，这只是之前没图随便找了一张图”，然后开启嘲讽、辱骂。“就你这开源效果”到“这不是你代码”，这种前后矛盾的话以及被拆穿后狗急跳墙。

闲鱼售卖 http://bilibili.com/video/BV1sJHSefEhq/ 的人很多，大多数联系上就下架了，这种没素质的，某自称“高德员工”的人是独一份。当然这份代码也同样不支持售卖，几个原因：1.这个代码几乎承载不了任何的业务，它可用作了解Cesium Primitive的绘制机制，了解如何自定义DrawCommand以及如何移植Shadertoy中的多Buffer着色器。2.代码中大多数关键代码来自其他分享渠道，没有明确的开源声明，售卖代码是商业行为。

寻求技术支持可以关注

公众号：少年啦1997
B站：少年啦1997
