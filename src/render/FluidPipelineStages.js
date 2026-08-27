const Cesium = globalThis.Cesium;

// 当前代码来自[少年啦1997]的开源代码，如果你是购买源码，请联系商家进行退款
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
      renderState: Cesium.RenderState.fromCache(volumeRenderState),
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
