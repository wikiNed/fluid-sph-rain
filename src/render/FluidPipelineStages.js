const Cesium = globalThis.Cesium;

// 当前代码来自[少年啦1997]的开源代码，如果你是购买源码，请联系商家进行退款
// 相机在体积盒「外面」时：只画朝向相机的面（BACK 剔除 = 保留正面），
// 并用深度测试让地形正确遮挡水体——这是原版行为。
const volumeRenderState = {
  cull: {
    enabled: true,
    face: Cesium.CullFace.BACK,
  },
  blending: {
    enabled: true,
    equationRgb: Cesium.BlendEquation.ADD,
    equationAlpha: Cesium.BlendEquation.ADD,
    functionSourceRgb: Cesium.BlendFunction.SOURCE_ALPHA,
    functionSourceAlpha: Cesium.BlendFunction.ONE,
    functionDestinationRgb: Cesium.BlendFunction.ONE_MINUS_SOURCE_ALPHA,
    functionDestinationAlpha: Cesium.BlendFunction.ONE_MINUS_SOURCE_ALPHA,
  },
  depthTest: {
    enabled: true,
  },
};

// 相机在体积盒「里面」时（缩放到地面附近、机位落在盒子内部）：
// 盒子的所有面都背对相机，BACK 剔除会把整个盒子剔光 → 水体彻底消失。
// 因此改成：不剔除、关闭深度测试，由片元着色器自己用「水面 < 地形」判断遮挡
// （着色器里水面步进会被地形命中距离 tt 截断）。深度测试若保留，盒子远侧面的
// 片元深度必然大于地形，会把「其实在水面之后、地形之前」的水体判掉。
const volumeInsideRenderState = {
  cull: {
    enabled: false,
  },
  blending: {
    enabled: true,
    equationRgb: Cesium.BlendEquation.ADD,
    equationAlpha: Cesium.BlendEquation.ADD,
    functionSourceRgb: Cesium.BlendFunction.SOURCE_ALPHA,
    functionSourceAlpha: Cesium.BlendFunction.ONE,
    functionDestinationRgb: Cesium.BlendFunction.ONE_MINUS_SOURCE_ALPHA,
    functionDestinationAlpha: Cesium.BlendFunction.ONE_MINUS_SOURCE_ALPHA,
  },
  depthTest: {
    enabled: false,
  },
  depthMask: false,
};

export class FluidComputeStage {
  constructor({ fragmentShaderSource, uniformMap, outputTexture }) {
    this.show = true;
    this._fragmentShaderSource = fragmentShaderSource;
    this._uniformMap = uniformMap;
    this._outputTexture = outputTexture;
    this._command = undefined;
  }

  update(frameState) {
    if (!this.show) {
      return;
    }

    if (!Cesium.defined(this._command)) {
      this._command = new Cesium.ComputeCommand({
        owner: this,
        fragmentShaderSource: this._fragmentShaderSource,
        uniformMap: this._uniformMap,
        outputTexture: this._outputTexture,
        persists: true,
      });
    }

    frameState.commandList.push(this._command);
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    this._command = undefined;
    return Cesium.destroyObject(this);
  }
}

export class FluidVolumeStage {
  constructor({
    geometry,
    modelMatrix,
    uniformMap,
    vertexShaderSource,
    fragmentShaderSource,
  }) {
    // 当前代码来自[少年啦1997]的开源代码，如果你是购买源码，请联系商家进行退款
    this.show = true;
    this._geometry = geometry;
    this._modelMatrix = modelMatrix;
    this._uniformMap = uniformMap;
    this._vertexShaderSource = vertexShaderSource;
    this._fragmentShaderSource = fragmentShaderSource;
    this._command = undefined;
    // 模型矩阵固定不变，预存逆矩阵用于每帧判断相机是否已进入体积盒内部
    this._inverseModelMatrix = modelMatrix
      ? Cesium.Matrix4.inverse(modelMatrix, new Cesium.Matrix4())
      : undefined;
    this._outsideRenderState = Cesium.RenderState.fromCache(volumeRenderState);
    this._insideRenderState = Cesium.RenderState.fromCache(volumeInsideRenderState);
    this._scratchLocal = new Cesium.Cartesian3();
    this._insideBox = false;
  }

  /** 相机是否落在体积盒内部（单位盒坐标范围 [-0.5,0.5]³，留 0.02 余量防边界抖动） */
  _isCameraInsideBox(frameState) {
    if (!this._inverseModelMatrix) {
      return false;
    }
    const local = Cesium.Matrix4.multiplyByPoint(
      this._inverseModelMatrix,
      frameState.camera.positionWC,
      this._scratchLocal,
    );
    return (
      Math.abs(local.x) < 0.52 &&
      Math.abs(local.y) < 0.52 &&
      Math.abs(local.z) < 0.52
    );
  }

  _createCommand(context) {
    const attributeLocations = Cesium.GeometryPipeline.createAttributeLocations(
      this._geometry,
    );
    const vertexArray = Cesium.VertexArray.fromGeometry({
      context,
      geometry: this._geometry,
      attributeLocations,
      bufferUsage: Cesium.BufferUsage.STATIC_DRAW,
    });
    const shaderProgram = Cesium.ShaderProgram.fromCache({
      context,
      attributeLocations,
      vertexShaderSource: this._vertexShaderSource,
      fragmentShaderSource: this._fragmentShaderSource,
    });

    return new Cesium.DrawCommand({
      owner: this,
      vertexArray,
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      uniformMap: this._uniformMap,
      modelMatrix: this._modelMatrix,
      shaderProgram,
      renderState: this._outsideRenderState,
      pass: Cesium.Pass.OPAQUE,
    });
  }

  update(frameState) {
    if (!this.show) {
      return;
    }

    if (!Cesium.defined(this._command)) {
      this._command = this._createCommand(frameState.context);
    }

    // 相机进入体积盒后必须换渲染状态，否则所有面被背面剔除、水体完全消失
    const inside = this._isCameraInsideBox(frameState);
    if (inside !== this._insideBox || !this._command.renderState) {
      this._insideBox = inside;
      this._command.renderState = inside
        ? this._insideRenderState
        : this._outsideRenderState;
    }

    frameState.commandList.push(this._command);
  }

  isDestroyed() {
    return false;
  }

  destroy() {
    if (Cesium.defined(this._command)) {
      this._command.vertexArray =
        this._command.vertexArray && this._command.vertexArray.destroy();
      this._command.shaderProgram =
        this._command.shaderProgram && this._command.shaderProgram.destroy();
    }
    return Cesium.destroyObject(this);
  }
}
