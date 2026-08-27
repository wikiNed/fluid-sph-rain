const Cesium = globalThis.Cesium;

export function createSimulationTexture(context, width, height) {
  // 当前代码来自[少年啦1997]的开源代码，如果你是购买源码，请联系商家进行退款
  return new Cesium.Texture({
    context,
    width,
    height,
    pixelFormat: Cesium.PixelFormat.RGBA,
    pixelDatatype: Cesium.PixelDatatype.FLOAT,
    source: {
      arrayBufferView: new Float32Array(width * height * 4),
    },
  });
}
