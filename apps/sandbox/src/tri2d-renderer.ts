// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const MAGIC = "ETD1";
const VERSION = 1;
const HEADER_BYTES = 24;
const VERTEX_BYTES = 20;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_COMMANDS = 8_192;
const MAX_SURFACE_SIZE = 4_096;
const MAX_TEXTURE_SIZE = 4_096;
const MAX_TEXTURES = 256;
const MAX_TEXTURE_BYTES = 64 * 1024 * 1024;
const MAX_DRAWS = 4_096;
const MAX_VERTICES = 262_144;
const MAX_INDICES = 786_432;

const TEXTURE_CREATE = 1;
const TEXTURE_UPDATE = 2;
const TEXTURE_DESTROY = 3;
const DRAW = 4;
const PRESENT = 5;

interface TextureState {
  width: number;
  height: number;
  bytes: number;
}

interface TextureCreate {
  kind: "texture-create";
  handle: number;
  width: number;
  height: number;
  filter: number;
  pixels: Uint8Array;
}

interface TextureUpdate {
  kind: "texture-update";
  handle: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: Uint8Array;
}

interface TextureDestroy {
  kind: "texture-destroy";
  handle: number;
}

interface Draw {
  kind: "draw";
  handle: number;
  clipX: number;
  clipY: number;
  clipWidth: number;
  clipHeight: number;
  vertices: Uint8Array;
  indices: Uint32Array;
}

type Tri2dOperation = TextureCreate | TextureUpdate | TextureDestroy | Draw;

export interface ParsedTri2dFrame {
  width: number;
  height: number;
  clearRgba: number;
  drawCount: number;
  vertexCount: number;
  indexCount: number;
  operations: Tri2dOperation[];
  textures: Map<number, TextureState>;
  textureBytes: number;
}

class Reader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.#bytes.byteLength - this.#offset;
  }

  bytes(length: number): Uint8Array {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > this.remaining
    ) {
      throw new Error("truncated Tri2D stream");
    }
    const start = this.#offset;
    this.#offset += length;
    return this.#bytes.subarray(start, this.#offset);
  }

  u8(): number {
    return this.bytes(1)[0];
  }

  u16(): number {
    if (this.remaining < 2) {
      throw new Error("truncated Tri2D stream");
    }
    const value = this.#view.getUint16(this.#offset, true);
    this.#offset += 2;
    return value;
  }

  u32(): number {
    if (this.remaining < 4) {
      throw new Error("truncated Tri2D stream");
    }
    const value = this.#view.getUint32(this.#offset, true);
    this.#offset += 4;
    return value;
  }
}

function multiply(...values: number[]): number {
  let product = 1;
  for (const value of values) {
    product *= value;
    if (!Number.isSafeInteger(product)) {
      throw new Error("Tri2D byte length overflow");
    }
  }
  return product;
}

function nonzeroHandle(value: number): number {
  if (value === 0) {
    throw new Error("Tri2D texture handle must be nonzero");
  }
  return value;
}

function validExtent(offset: number, length: number, limit: number): boolean {
  return length > 0 && offset <= limit && length <= limit - offset;
}

export function parseTri2dStream(
  bytes: Uint8Array,
  currentTextures: ReadonlyMap<number, TextureState> = new Map(),
  currentTextureBytes = 0,
): ParsedTri2dFrame {
  if (bytes.byteLength < HEADER_BYTES || bytes.byteLength > MAX_STREAM_BYTES) {
    throw new Error("Tri2D stream has invalid byte length");
  }
  const reader = new Reader(bytes);
  if (new TextDecoder("ascii").decode(reader.bytes(4)) !== MAGIC) {
    throw new Error("Tri2D stream has invalid magic");
  }
  if (reader.u16() !== VERSION || reader.u16() !== HEADER_BYTES) {
    throw new Error("Tri2D stream has incompatible framing");
  }
  const width = reader.u32();
  const height = reader.u32();
  if (
    width === 0 ||
    height === 0 ||
    width > MAX_SURFACE_SIZE ||
    height > MAX_SURFACE_SIZE
  ) {
    throw new Error("Tri2D stream has invalid surface dimensions");
  }
  const commandCount = reader.u32();
  if (commandCount === 0 || commandCount > MAX_COMMANDS) {
    throw new Error("Tri2D stream has invalid command count");
  }
  const clearRgba = reader.u32();
  const textures = new Map(currentTextures);
  let textureBytes = currentTextureBytes;
  let drawCount = 0;
  let vertexCount = 0;
  let indexCount = 0;
  let presented = false;
  const operations: Tri2dOperation[] = [];

  for (let commandIndex = 0; commandIndex < commandCount; commandIndex++) {
    const opcode = reader.u8();
    if (reader.u8() !== 0 || reader.u16() !== 0) {
      throw new Error("Tri2D command has unsupported flags");
    }
    const payloadLength = reader.u32();
    const payload = new Reader(reader.bytes(payloadLength));
    if (presented) {
      throw new Error("Tri2D command follows present");
    }

    if (opcode === TEXTURE_CREATE) {
      const handle = nonzeroHandle(payload.u32());
      const textureWidth = payload.u32();
      const textureHeight = payload.u32();
      const filter = payload.u32();
      const byteLength = payload.u32();
      if (
        textureWidth === 0 ||
        textureHeight === 0 ||
        textureWidth > MAX_TEXTURE_SIZE ||
        textureHeight > MAX_TEXTURE_SIZE ||
        filter > 1
      ) {
        throw new Error("Tri2D texture create has invalid properties");
      }
      const expected = multiply(textureWidth, textureHeight, 4);
      if (byteLength !== expected || payload.remaining !== byteLength) {
        throw new Error("Tri2D texture create has invalid pixel length");
      }
      const pixels = payload.bytes(byteLength).slice();
      if (
        textures.has(handle) ||
        textures.size === MAX_TEXTURES ||
        textureBytes + byteLength > MAX_TEXTURE_BYTES
      ) {
        throw new Error("Tri2D texture limits exceeded");
      }
      textures.set(handle, {
        width: textureWidth,
        height: textureHeight,
        bytes: byteLength,
      });
      textureBytes += byteLength;
      operations.push({
        kind: "texture-create",
        handle,
        width: textureWidth,
        height: textureHeight,
        filter,
        pixels,
      });
    } else if (opcode === TEXTURE_UPDATE) {
      const handle = nonzeroHandle(payload.u32());
      const x = payload.u32();
      const y = payload.u32();
      const updateWidth = payload.u32();
      const updateHeight = payload.u32();
      const byteLength = payload.u32();
      const texture = textures.get(handle);
      if (texture === undefined) {
        throw new Error("Tri2D texture update uses an unknown handle");
      }
      if (
        !validExtent(x, updateWidth, texture.width) ||
        !validExtent(y, updateHeight, texture.height)
      ) {
        throw new Error("Tri2D texture update exceeds texture bounds");
      }
      const expected = multiply(updateWidth, updateHeight, 4);
      if (byteLength !== expected || payload.remaining !== byteLength) {
        throw new Error("Tri2D texture update has invalid pixel length");
      }
      operations.push({
        kind: "texture-update",
        handle,
        x,
        y,
        width: updateWidth,
        height: updateHeight,
        pixels: payload.bytes(byteLength).slice(),
      });
    } else if (opcode === TEXTURE_DESTROY) {
      const handle = nonzeroHandle(payload.u32());
      const texture = textures.get(handle);
      if (texture === undefined) {
        throw new Error("Tri2D texture destroy uses an unknown handle");
      }
      textures.delete(handle);
      textureBytes -= texture.bytes;
      operations.push({ kind: "texture-destroy", handle });
    } else if (opcode === DRAW) {
      const handle = nonzeroHandle(payload.u32());
      if (!textures.has(handle)) {
        throw new Error("Tri2D draw uses an unknown texture handle");
      }
      const clipX = payload.u32();
      const clipY = payload.u32();
      const clipWidth = payload.u32();
      const clipHeight = payload.u32();
      if (
        !validExtent(clipX, clipWidth, width) ||
        !validExtent(clipY, clipHeight, height)
      ) {
        throw new Error("Tri2D draw has an invalid clip rectangle");
      }
      const vertices = payload.u32();
      const indices = payload.u32();
      if (vertices === 0 || indices === 0 || indices % 3 !== 0) {
        throw new Error("Tri2D draw has invalid element counts");
      }
      drawCount++;
      vertexCount += vertices;
      indexCount += indices;
      if (
        drawCount > MAX_DRAWS ||
        vertexCount > MAX_VERTICES ||
        indexCount > MAX_INDICES
      ) {
        throw new Error("Tri2D draw limits exceeded");
      }
      const vertexBytes = multiply(vertices, VERTEX_BYTES);
      const indexBytes = multiply(indices, 4);
      if (payload.remaining !== vertexBytes + indexBytes) {
        throw new Error("Tri2D draw has invalid payload length");
      }
      const vertexData = payload.bytes(vertexBytes).slice();
      const indexData = new Uint32Array(indices);
      for (let index = 0; index < indices; index++) {
        const value = payload.u32();
        if (value >= vertices) {
          throw new Error("Tri2D draw index exceeds vertex count");
        }
        indexData[index] = value;
      }
      operations.push({
        kind: "draw",
        handle,
        clipX,
        clipY,
        clipWidth,
        clipHeight,
        vertices: vertexData,
        indices: indexData,
      });
    } else if (opcode === PRESENT) {
      if (payloadLength !== 0 || commandIndex + 1 !== commandCount) {
        throw new Error("Tri2D present must be the final empty command");
      }
      presented = true;
    } else {
      throw new Error(`Tri2D stream has unknown opcode ${String(opcode)}`);
    }
    if (payload.remaining !== 0) {
      throw new Error("Tri2D command has trailing payload bytes");
    }
  }

  if (!presented || reader.remaining !== 0) {
    throw new Error("Tri2D stream has invalid presentation boundary");
  }
  return {
    width,
    height,
    clearRgba,
    drawCount,
    vertexCount,
    indexCount,
    operations,
    textures,
    textureBytes,
  };
}

interface GpuTexture extends TextureState {
  texture: WebGLTexture;
}

function shader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const value = gl.createShader(type);
  if (value === null) {
    throw new Error("WebGL could not allocate a Tri2D shader");
  }
  gl.shaderSource(value, source);
  gl.compileShader(value);
  if (gl.getShaderParameter(value, gl.COMPILE_STATUS) !== true) {
    const message = gl.getShaderInfoLog(value) ?? "unknown shader error";
    gl.deleteShader(value);
    throw new Error(`Tri2D shader compilation failed: ${message}`);
  }
  return value;
}

function program(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = shader(
    gl,
    gl.VERTEX_SHADER,
    `#version 300 es
      precision highp float;
      precision highp int;
      layout(location = 0) in ivec2 positionFixed;
      layout(location = 1) in ivec2 uvFixed;
      layout(location = 2) in vec4 color;
      uniform vec2 surface;
      out vec2 textureUv;
      out vec4 vertexColor;
      void main() {
        vec2 position = vec2(positionFixed) / 65536.0;
        vec2 clip = position / surface * vec2(2.0, -2.0) + vec2(-1.0, 1.0);
        gl_Position = vec4(clip, 0.0, 1.0);
        textureUv = vec2(uvFixed) / 65536.0;
        vertexColor = color;
      }
    `,
  );
  const fragment = shader(
    gl,
    gl.FRAGMENT_SHADER,
    `#version 300 es
      precision mediump float;
      uniform sampler2D image;
      in vec2 textureUv;
      in vec4 vertexColor;
      out vec4 outputColor;
      void main() {
        outputColor = texture(image, textureUv) * vertexColor;
      }
    `,
  );
  const value = gl.createProgram();
  gl.attachShader(value, vertex);
  gl.attachShader(value, fragment);
  gl.linkProgram(value);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (gl.getProgramParameter(value, gl.LINK_STATUS) !== true) {
    const message = gl.getProgramInfoLog(value) ?? "unknown link error";
    gl.deleteProgram(value);
    throw new Error(`Tri2D shader link failed: ${message}`);
  }
  return value;
}

export class Tri2dRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #gl: WebGL2RenderingContext;
  readonly #program: WebGLProgram;
  readonly #surface: WebGLUniformLocation;
  readonly #vertexBuffer: WebGLBuffer;
  readonly #indexBuffer: WebGLBuffer;
  readonly #vao: WebGLVertexArrayObject;
  #textures = new Map<number, GpuTexture>();
  #textureBytes = 0;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (gl === null) {
      throw new Error("WebGL2 is required for Tri2D");
    }
    const renderProgram = program(gl);
    const surface = gl.getUniformLocation(renderProgram, "surface");
    const vertexBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();
    const vao = gl.createVertexArray();
    if (surface === null) {
      throw new Error("WebGL could not locate the Tri2D surface uniform");
    }
    this.#canvas = canvas;
    this.#gl = gl;
    this.#program = renderProgram;
    this.#surface = surface;
    this.#vertexBuffer = vertexBuffer;
    this.#indexBuffer = indexBuffer;
    this.#vao = vao;

    gl.useProgram(renderProgram);
    gl.uniform1i(gl.getUniformLocation(renderProgram, "image"), 0);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribIPointer(0, 2, gl.INT, VERTEX_BYTES, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 2, gl.INT, VERTEX_BYTES, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, VERTEX_BYTES, 16);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.SCISSOR_TEST);
    gl.activeTexture(gl.TEXTURE0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  render(bytes: Uint8Array): ParsedTri2dFrame {
    const state = new Map<number, TextureState>();
    for (const [handle, texture] of this.#textures) {
      state.set(handle, {
        width: texture.width,
        height: texture.height,
        bytes: texture.bytes,
      });
    }
    const frame = parseTri2dStream(bytes, state, this.#textureBytes);
    const gl = this.#gl;
    if (gl.isContextLost()) {
      throw new Error("Tri2D WebGL context was lost");
    }
    if (this.#canvas.width !== frame.width) {
      this.#canvas.width = frame.width;
    }
    if (this.#canvas.height !== frame.height) {
      this.#canvas.height = frame.height;
    }
    gl.viewport(0, 0, frame.width, frame.height);
    gl.useProgram(this.#program);
    gl.uniform2f(this.#surface, frame.width, frame.height);
    gl.bindVertexArray(this.#vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#vertexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.#indexBuffer);
    const clear = frame.clearRgba;
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(
      (clear & 0xff) / 255,
      ((clear >>> 8) & 0xff) / 255,
      ((clear >>> 16) & 0xff) / 255,
      ((clear >>> 24) & 0xff) / 255,
    );
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);

    for (const operation of frame.operations) {
      if (operation.kind === "texture-create") {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const filter = operation.filter === 0 ? gl.NEAREST : gl.LINEAR;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          operation.width,
          operation.height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          operation.pixels,
        );
        this.#textures.set(operation.handle, {
          texture,
          width: operation.width,
          height: operation.height,
          bytes: operation.pixels.byteLength,
        });
        this.#textureBytes += operation.pixels.byteLength;
      } else if (operation.kind === "texture-update") {
        const texture = this.#textures.get(operation.handle);
        if (texture === undefined) {
          throw new Error("Tri2D texture state diverged");
        }
        gl.bindTexture(gl.TEXTURE_2D, texture.texture);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          operation.x,
          operation.y,
          operation.width,
          operation.height,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          operation.pixels,
        );
      } else if (operation.kind === "texture-destroy") {
        const texture = this.#textures.get(operation.handle);
        if (texture === undefined) {
          throw new Error("Tri2D texture state diverged");
        }
        gl.deleteTexture(texture.texture);
        this.#textures.delete(operation.handle);
        this.#textureBytes -= texture.bytes;
      } else {
        const texture = this.#textures.get(operation.handle);
        if (texture === undefined) {
          throw new Error("Tri2D texture state diverged");
        }
        gl.bindTexture(gl.TEXTURE_2D, texture.texture);
        gl.scissor(
          operation.clipX,
          frame.height - operation.clipY - operation.clipHeight,
          operation.clipWidth,
          operation.clipHeight,
        );
        gl.bufferData(gl.ARRAY_BUFFER, operation.vertices, gl.DYNAMIC_DRAW);
        gl.bufferData(
          gl.ELEMENT_ARRAY_BUFFER,
          operation.indices,
          gl.DYNAMIC_DRAW,
        );
        gl.drawElements(
          gl.TRIANGLES,
          operation.indices.length,
          gl.UNSIGNED_INT,
          0,
        );
      }
    }
    gl.flush();
    const error = gl.getError();
    if (error !== gl.NO_ERROR) {
      throw new Error(`Tri2D WebGL operation failed (${String(error)})`);
    }
    this.#textureBytes = frame.textureBytes;
    return frame;
  }

  dispose(): void {
    const gl = this.#gl;
    for (const texture of this.#textures.values()) {
      gl.deleteTexture(texture.texture);
    }
    this.#textures.clear();
    gl.deleteBuffer(this.#vertexBuffer);
    gl.deleteBuffer(this.#indexBuffer);
    gl.deleteVertexArray(this.#vao);
    gl.deleteProgram(this.#program);
  }
}
