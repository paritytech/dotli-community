/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* global GPUBufferUsage, GPUMapMode, GPUTextureUsage */

"use strict";

const WIRE_VERSION = 1;
const BATCH_HEADER_BYTES = 24;
const COMMAND_HEADER_BYTES = 8;
const EVENT_HEADER_BYTES = 24;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_COMMANDS = 16_384;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const HANDLE_SLOT_MASK = (1 << 20) - 1;
const HANDLE_LIVE_BIT = 1 << 12;
const MAX_COMPILATIONS_PER_BATCH = 32;
const MAX_PENDING_BATCHES = 4;
// Adapter discovery can be briefly unavailable while a browser rebuilds its
// graphics process after resize, backgrounding, or memory pressure.
const MAX_DEVICE_RESTORE_ATTEMPTS = 3;
const DEVICE_RESTORE_RETRY_DELAY_MS = 250;
const BATCH_ERROR_STALE_SURFACE = 4;
const MAX_RENDER_PASSES_PER_BATCH = 16;
const MAX_DRAWS_PER_BATCH = 8_192;
const MAX_COMPUTE_PASSES_PER_BATCH = 64;
const MAX_DISPATCHES_PER_BATCH = 8_192;
const MAX_OCCLUSION_QUERIES_PER_BATCH = 4_096;
const GPU_SHADER_STAGE_VERTEX = 1;
const MAX_TOTAL_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_TEXTURE_BYTES = 256 * 1024 * 1024;
const MAX_TEXTURE_DIMENSION_3D = 256;
const MAX_TEXTURE_ARRAY_LAYERS = 256;
const RASTER_FEATURE_LAYERED_TEXTURES = 1;
const RASTER_FEATURE_STENCIL_DEPTH_BIAS = 2;
const RASTER_FEATURE_BLEND_CONSTANT = 4;
const RASTER_FEATURE_OCCLUSION_QUERIES = 8;
const RENDER_PASS_DEPTH_LOAD = 4;
const RENDER_PASS_DEPTH_STORE = 8;
const RENDER_PASS_STENCIL_LOAD = 16;
const RENDER_PASS_STENCIL_STORE = 32;
const RENDER_PASS_HAS_STENCIL_CLEAR = 64;
const RENDER_PASS_HAS_OCCLUSION_QUERIES = 128;
const RENDER_PASS_FLAGS = 255;
const PIPELINE_DEPTH_WRITE = 1;
const PIPELINE_STENCIL_DEPTH_BIAS = 2;
const PIPELINE_FLAGS = 3;
const MAX_STENCIL_VALUE = 255;
const resourceLimits = new Map([
  ["buffer", 4_096],
  ["texture", 512],
  ["textureView", 1_024],
  ["sampler", 128],
  ["shader", 128],
  ["bindGroupLayout", 128],
  ["pipelineLayout", 64],
  ["bindGroup", 512],
  ["renderPipeline", 256],
  ["computePipeline", 256],
]);
const bindGroupResourceKinds = new Map([
  [1, "buffer"],
  [4, "buffer"],
  [5, "buffer"],
  [2, "sampler"],
  [3, "textureView"],
]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const formats = new Map([
  [1, "rgba8unorm"],
  [2, "rgba8unorm-srgb"],
  [3, "bgra8unorm"],
  [4, "bgra8unorm-srgb"],
  [5, "depth24plus"],
  [6, "depth32float"],
  [7, "r8unorm"],
  [8, "depth24plus-stencil8"],
]);
const formatIds = new Map([...formats].map(([id, format]) => [format, id]));
const vertexFormats = new Map([
  [1, "float32"],
  [2, "float32x2"],
  [3, "float32x3"],
  [4, "float32x4"],
  [5, "uint32"],
  [6, "uint32x2"],
  [7, "uint32x4"],
  [8, "unorm8x2"],
  [9, "unorm8x4"],
  [10, "snorm8x2"],
  [11, "snorm8x4"],
]);
const indexFormats = new Map([
  [1, "uint16"],
  [2, "uint32"],
]);
const addressModes = new Map([
  [1, "clamp-to-edge"],
  [2, "repeat"],
  [3, "mirror-repeat"],
]);
const filterModes = new Map([
  [1, "nearest"],
  [2, "linear"],
]);
const compareFunctions = new Map([
  [1, "never"],
  [2, "less"],
  [3, "equal"],
  [4, "less-equal"],
  [5, "greater"],
  [6, "not-equal"],
  [7, "greater-equal"],
  [8, "always"],
]);
const stencilOperations = new Map([
  [1, "keep"],
  [2, "zero"],
  [3, "replace"],
  [4, "invert"],
  [5, "increment-clamp"],
  [6, "decrement-clamp"],
  [7, "increment-wrap"],
  [8, "decrement-wrap"],
]);
const blendOperations = new Map([
  [1, "add"],
  [2, "subtract"],
  [3, "reverse-subtract"],
  [4, "min"],
  [5, "max"],
]);
const blendFactors = new Map([
  [1, "zero"],
  [2, "one"],
  [3, "src"],
  [4, "one-minus-src"],
  [5, "src-alpha"],
  [6, "one-minus-src-alpha"],
  [7, "dst"],
  [8, "one-minus-dst"],
  [9, "dst-alpha"],
  [10, "one-minus-dst-alpha"],
  [11, "src-alpha-saturated"],
  [12, "constant"],
  [13, "one-minus-constant"],
]);
const topologies = new Map([
  [1, "point-list"],
  [2, "line-list"],
  [3, "line-strip"],
  [4, "triangle-list"],
  [5, "triangle-strip"],
]);
const frontFaces = new Map([
  [1, "ccw"],
  [2, "cw"],
]);
const cullModes = new Map([
  [0, "none"],
  [1, "front"],
  [2, "back"],
]);
const samplerBindingTypes = new Map([
  [1, "filtering"],
  [2, "non-filtering"],
  [3, "comparison"],
]);
const textureSampleTypes = new Map([
  [1, "float"],
  [2, "unfilterable-float"],
  [3, "depth"],
  [4, "sint"],
  [5, "uint"],
]);
const textureDimensions = new Map([
  [1, "2d"],
  [2, "3d"],
]);
const textureViewDimensions = new Map([
  [1, "2d"],
  [2, "2d-array"],
  [3, "cube"],
  [4, "cube-array"],
  [5, "3d"],
]);
const vertexStepModes = new Map([
  [1, "vertex"],
  [2, "instance"],
]);
const textureAspects = new Map([
  [1, "all"],
  [2, "depth-only"],
]);

class ProtocolError extends Error {
  constructor(message, commandIndex = 0xffffffff, errorCode = 1) {
    super(message);
    this.commandIndex = commandIndex;
    this.errorCode = errorCode;
  }
}

class Reader {
  constructor(bytes) {
    if (!(bytes instanceof Uint8Array)) {
      throw new ProtocolError("GPU payload is not bytes");
    }
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }

  take(length) {
    const end = this.offset + length;
    if (!Number.isSafeInteger(end) || end > this.bytes.byteLength) {
      throw new ProtocolError("GPU payload is truncated");
    }
    const value = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return value;
  }

  u8() {
    return this.take(1)[0];
  }

  u16() {
    const offset = this.offset;
    this.take(2);
    return this.view.getUint16(offset, true);
  }

  u32() {
    const offset = this.offset;
    this.take(4);
    return this.view.getUint32(offset, true);
  }

  i32() {
    const offset = this.offset;
    this.take(4);
    return this.view.getInt32(offset, true);
  }

  u64() {
    const offset = this.offset;
    this.take(8);
    const value = this.view.getBigUint64(offset, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ProtocolError("GPU integer exceeds the safe range");
    }
    return Number(value);
  }

  f32() {
    const offset = this.offset;
    this.take(4);
    const value = this.view.getFloat32(offset, true);
    if (!Number.isFinite(value)) {
      throw new ProtocolError("GPU descriptor contains non-finite float");
    }
    return value;
  }

  text(length) {
    return textDecoder.decode(this.take(length));
  }

  zero(length) {
    if (this.take(length).some(byte => byte !== 0)) {
      throw new ProtocolError("GPU descriptor has nonzero reserved bytes");
    }
  }

  finish() {
    if (this.offset !== this.bytes.byteLength) {
      throw new ProtocolError("GPU descriptor has trailing bytes");
    }
  }
}

function mapped(table, value, label) {
  const result = table.get(value);
  if (result === undefined) {
    throw new ProtocolError(`unsupported GPU ${label} ${value}`);
  }
  return result;
}

function validHandle(id) {
  return id !== 0 && (id & HANDLE_SLOT_MASK) !== 0 && id >>> 20 !== 0;
}

function resource(catalog, id, kind, commandIndex) {
  const entry = catalog.get(id);
  if (!entry || (kind && entry.kind !== kind) || entry.failed) {
    throw new ProtocolError(
      `invalid ${kind || "resource"} handle ${id}`,
      commandIndex
    );
  }
  return entry;
}

function createResource(catalog, slots, id, kind, descriptor, commandIndex) {
  if (!validHandle(id) || catalog.has(id)) {
    throw new ProtocolError(`invalid new ${kind} handle ${id}`, commandIndex);
  }
  const slot = id & HANDLE_SLOT_MASK;
  const generation = id >>> 20;
  const prior = slots.get(slot);
  if (
    (prior === undefined && generation !== 1) ||
    (prior !== undefined &&
      ((prior & HANDLE_LIVE_BIT) !== 0 ||
        generation !== (prior & ~HANDLE_LIVE_BIT) + 1))
  ) {
    throw new ProtocolError(`stale new ${kind} handle ${id}`, commandIndex);
  }
  const entry = { kind, descriptor, value: null, failed: false };
  catalog.set(id, entry);
  slots.set(slot, generation | HANDLE_LIVE_BIT);
  return entry;
}

function depthFormat(format) {
  return (
    format === "depth24plus" ||
    format === "depth32float" ||
    format === "depth24plus-stencil8"
  );
}

function stencilFormat(format) {
  return format === "depth24plus-stencil8";
}

function defaultStencilFace(face) {
  return (
    face.compare === "always" &&
    face.failOp === "keep" &&
    face.depthFailOp === "keep" &&
    face.passOp === "keep"
  );
}

function textureMipSize(texture, level) {
  const divisor = 2 ** level;
  return {
    width: Math.max(1, Math.floor(texture.width / divisor)),
    height: Math.max(1, Math.floor(texture.height / divisor)),
    depthOrArrayLayers:
      texture.dimension === "3d"
        ? Math.max(1, Math.floor(texture.depthOrArrayLayers / divisor))
        : texture.depthOrArrayLayers,
  };
}

function validateTexture(command, limits) {
  const volume = command.dimension === "3d";
  const dimensionLimit = volume ? limits[22] : limits[0];
  const depthLimit = volume ? limits[22] : limits[23];
  const maxMipLevels = 1 + Math.floor(Math.log2(Math.max(
    command.width,
    command.height,
    volume ? command.depthOrArrayLayers : 1
  )));
  if (
    !command.width ||
    !command.height ||
    !command.depthOrArrayLayers ||
    command.width > dimensionLimit ||
    command.height > dimensionLimit ||
    command.depthOrArrayLayers > depthLimit ||
    !command.mipLevelCount ||
    command.mipLevelCount > maxMipLevels ||
    command.sampleCount !== 1 ||
    !command.usage ||
    (command.usage & ~0x17) ||
    (volume && (depthFormat(command.format) || (command.usage & 0x10)))
  ) {
    throw new ProtocolError("invalid texture descriptor", command.index);
  }
}

function validateTextureUpload(command, texture) {
  const { width, height, depthOrArrayLayers } = command.size;
  const bytesPerTexel = texture.format === "r8unorm" ? 1 : 4;
  if (
    !(texture.usage & 2) ||
    depthFormat(texture.format) ||
    command.mipLevel >= texture.mipLevelCount ||
    !width ||
    !height ||
    !depthOrArrayLayers
  ) {
    throw new ProtocolError("invalid texture upload", command.index);
  }
  const mip = textureMipSize(texture, command.mipLevel);
  if (
    command.origin.x + width > mip.width ||
    command.origin.y + height > mip.height ||
    command.origin.z + depthOrArrayLayers > mip.depthOrArrayLayers ||
    command.bytesPerRow < width * bytesPerTexel ||
    command.bytesPerRow % bytesPerTexel ||
    command.rowsPerImage < height
  ) {
    throw new ProtocolError("invalid texture upload range or layout", command.index);
  }
  const imageStride = command.bytesPerRow * command.rowsPerImage;
  const precedingImages = imageStride * (depthOrArrayLayers - 1);
  const requiredBytes = precedingImages +
    command.bytesPerRow * (height - 1) + width * bytesPerTexel;
  if (
    !Number.isSafeInteger(imageStride) ||
    !Number.isSafeInteger(precedingImages) ||
    !Number.isSafeInteger(requiredBytes) ||
    requiredBytes > command.data.byteLength
  ) {
    throw new ProtocolError("texture upload data is too short", command.index);
  }
}

function validateTextureView(command, texture) {
  const volume = command.dimension === "3d";
  const cube = command.dimension === "cube" || command.dimension === "cube-array";
  if (
    command.format !== texture.format ||
    (command.aspect === "depth-only" && !depthFormat(texture.format)) ||
    volume !== (texture.dimension === "3d") ||
    !command.mipLevelCount ||
    command.baseMipLevel + command.mipLevelCount > texture.mipLevelCount ||
    (volume
      ? command.baseArrayLayer !== 0 || command.arrayLayerCount !== 0
      : !command.arrayLayerCount ||
        command.baseArrayLayer + command.arrayLayerCount > texture.depthOrArrayLayers) ||
    (command.dimension === "2d" && command.arrayLayerCount !== 1) ||
    (command.dimension === "cube" && command.arrayLayerCount !== 6) ||
    (command.dimension === "cube-array" && command.arrayLayerCount % 6)
  ) {
    throw new ProtocolError("invalid texture view descriptor", command.index);
  }
  if (cube && texture.width !== texture.height) {
    throw new ProtocolError("cube texture view requires square texture", command.index);
  }
}

function validateTextureBindings(command, catalog) {
  const layout = resource(catalog, command.layout, "bindGroupLayout", command.index)
    .descriptor;
  const seen = new Set();
  if (layout.entries.length !== command.entries.length) {
    throw new ProtocolError("bind group does not match layout", command.index);
  }
  for (const entry of command.entries) {
    const binding = layout.entries.find(item => item.binding === entry.binding);
    if (!binding || seen.has(entry.binding)) {
      throw new ProtocolError("invalid bind group binding", command.index);
    }
    seen.add(entry.binding);
    if (!binding.texture && entry.kind !== 3) {
      continue;
    }
    if (!binding.texture || entry.kind !== 3 || entry.offset || entry.size) {
      throw new ProtocolError("invalid texture binding", command.index);
    }
    const view = resource(catalog, entry.resourceId, "textureView", command.index)
      .descriptor;
    const texture = resource(catalog, view.texture, "texture", command.index)
      .descriptor;
    const sampleType = binding.texture.sampleType;
    if (
      !(texture.usage & 4) ||
      view.dimension !== binding.texture.viewDimension ||
      (stencilFormat(view.format) && view.aspect !== "depth-only") ||
      (depthFormat(view.format)
        ? sampleType !== "depth" && sampleType !== "unfilterable-float"
        : sampleType !== "float" && sampleType !== "unfilterable-float")
    ) {
      throw new ProtocolError("incompatible texture binding", command.index);
    }
  }
}

function validateTextureAttachment(catalog, id, depth, commandIndex) {
  const view = resource(catalog, id, "textureView", commandIndex).descriptor;
  const texture = resource(catalog, view.texture, "texture", commandIndex).descriptor;
  if (
    !(texture.usage & 0x10) ||
    view.dimension !== "2d" ||
    view.mipLevelCount !== 1 ||
    depthFormat(view.format) !== depth ||
    (stencilFormat(view.format) && view.aspect !== "all")
  ) {
    throw new ProtocolError("invalid texture render attachment", commandIndex);
  }
}

// Stencil flags describe a stencil attachment only; a pass either loads the
// stencil aspect or clears it to one byte.
function validateStencilPass(command, catalog, commandIndex) {
  const stencilFlags =
    RENDER_PASS_STENCIL_LOAD | RENDER_PASS_STENCIL_STORE | RENDER_PASS_HAS_STENCIL_CLEAR;
  const hasStencil =
    command.depthView !== 0 &&
    stencilFormat(resource(catalog, command.depthView, "textureView", commandIndex)
      .descriptor.format);
  if (
    (command.flags & stencilFlags && !hasStencil) ||
    (command.flags & RENDER_PASS_STENCIL_LOAD &&
      command.flags & RENDER_PASS_HAS_STENCIL_CLEAR) ||
    command.clearStencil > MAX_STENCIL_VALUE
  ) {
    throw new ProtocolError("invalid stencil pass operations", commandIndex);
  }
}

// Mirrors WebGPU's depth-stencil rules so they fail before any GPU mutation.
function validatePipelineDepthStencil(command, commandIndex) {
  if (!(command.flags & PIPELINE_STENCIL_DEPTH_BIAS)) {
    return;
  }
  const format = command.depthFormatId
    ? mapped(formats, command.depthFormatId, "depth format")
    : null;
  const lineOrPoint = command.topology !== "triangle-list" &&
    command.topology !== "triangle-strip";
  if (
    !format ||
    !depthFormat(format) ||
    (!stencilFormat(format) &&
      !(defaultStencilFace(command.stencilFront) &&
        defaultStencilFace(command.stencilBack))) ||
    (lineOrPoint &&
      (command.depthBias !== 0 ||
        command.depthBiasSlopeScale !== 0 ||
        command.depthBiasClamp !== 0))
  ) {
    throw new ProtocolError("invalid pipeline stencil or depth bias state", commandIndex);
  }
}

function textureByteLength(descriptor) {
  let width = descriptor.width;
  let height = descriptor.height;
  let depth = descriptor.depthOrArrayLayers;
  let total = 0;
  for (let level = 0; level < descriptor.mipLevelCount; level++) {
    const bytes = width * height * depth * 4;
    if (
      !Number.isSafeInteger(bytes) ||
      total > MAX_TOTAL_TEXTURE_BYTES - bytes
    ) {
      return MAX_TOTAL_TEXTURE_BYTES + 1;
    }
    total += bytes;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
    if (descriptor.dimension === "3d") {
      depth = Math.max(1, Math.floor(depth / 2));
    }
  }
  return total;
}

function adjustResourceStats(stats, entry, delta, commandIndex = 0xffffffff) {
  const count = (stats.counts.get(entry.kind) || 0) + delta;
  const limit = resourceLimits.get(entry.kind);
  if (count < 0 || limit === undefined || count > limit) {
    throw new ProtocolError(
      `GPU ${entry.kind} resource quota exceeded`,
      commandIndex
    );
  }
  stats.counts.set(entry.kind, count);
  if (entry.kind === "buffer") {
    stats.bufferBytes += delta * entry.descriptor.size;
    if (stats.bufferBytes < 0 || stats.bufferBytes > MAX_TOTAL_BUFFER_BYTES) {
      throw new ProtocolError("GPU buffer memory quota exceeded", commandIndex);
    }
  } else if (entry.kind === "texture") {
    stats.textureBytes += delta * textureByteLength(entry.descriptor);
    if (
      stats.textureBytes < 0 ||
      stats.textureBytes > MAX_TOTAL_TEXTURE_BYTES
    ) {
      throw new ProtocolError(
        "GPU texture memory quota exceeded",
        commandIndex
      );
    }
  }
}

function resourceStats(catalog) {
  const stats = { counts: new Map(), bufferBytes: 0, textureBytes: 0 };
  for (const entry of catalog.values()) {
    adjustResourceStats(stats, entry, 1);
  }
  return stats;
}

function createBoundedResource(
  catalog,
  slots,
  stats,
  creations,
  id,
  kind,
  descriptor,
  commandIndex
) {
  const entry = createResource(
    catalog,
    slots,
    id,
    kind,
    descriptor,
    commandIndex
  );
  const creationCount = (creations.counts.get(kind) || 0) + 1;
  if (creationCount > resourceLimits.get(kind)) {
    throw new ProtocolError(
      `too many GPU ${kind} creations in one batch`,
      commandIndex
    );
  }
  creations.counts.set(kind, creationCount);
  if (kind === "buffer") {
    creations.bufferBytes += descriptor.size;
    if (creations.bufferBytes > MAX_TOTAL_BUFFER_BYTES) {
      throw new ProtocolError(
        "GPU buffer allocation budget exceeded",
        commandIndex
      );
    }
  } else if (kind === "texture") {
    creations.textureBytes += textureByteLength(descriptor);
    if (creations.textureBytes > MAX_TOTAL_TEXTURE_BYTES) {
      throw new ProtocolError(
        "GPU texture allocation budget exceeded",
        commandIndex
      );
    }
  } else if (
    kind === "shader" ||
    kind === "renderPipeline" ||
    kind === "computePipeline"
  ) {
    creations.compilations++;
    if (creations.compilations > MAX_COMPILATIONS_PER_BATCH) {
      throw new ProtocolError(
        "too many GPU compilations in one batch",
        commandIndex
      );
    }
  }
  adjustResourceStats(stats, entry, 1, commandIndex);
  return entry;
}

function parseCommands(bytes) {
  if (
    bytes.byteLength < BATCH_HEADER_BYTES ||
    bytes.byteLength > MAX_BATCH_BYTES
  ) {
    throw new ProtocolError("GPU batch length is invalid");
  }
  const reader = new Reader(bytes);
  if (
    textDecoder.decode(reader.take(4)) !== "EPG1" ||
    reader.u16() !== WIRE_VERSION
  ) {
    throw new ProtocolError("GPU batch header is invalid");
  }
  reader.zero(2);
  if (reader.u32() !== bytes.byteLength) {
    throw new ProtocolError("GPU batch length does not match its header");
  }
  const commandCount = reader.u32();
  const sequence = reader.u64();
  if (!sequence || commandCount > MAX_COMMANDS) {
    throw new ProtocolError("GPU batch sequence or command count is invalid");
  }
  const commands = [];
  for (let index = 0; index < commandCount; index++) {
    const opcode = reader.u16();
    reader.zero(2);
    const commandBytes = reader.u32();
    if (commandBytes < COMMAND_HEADER_BYTES || commandBytes % 4) {
      throw new ProtocolError("GPU command length is invalid", index);
    }
    const payload = reader.take(commandBytes - COMMAND_HEADER_BYTES);
    commands.push({ opcode, payload, index });
  }
  reader.finish();
  return { sequence, commands };
}

// Parsing stays centralized so every opcode's exact wire shape is auditable.
// eslint-disable-next-line complexity
function parseCommand(command) {
  const reader = new Reader(command.payload);
  const result = { opcode: command.opcode, index: command.index };
  switch (command.opcode) {
    case 1:
      Object.assign(result, {
        id: reader.u32(),
        usage: reader.u32(),
        size: reader.u64(),
      });
      break;
    case 2: {
      result.id = reader.u32();
      reader.zero(4);
      result.offset = reader.u64();
      const length = reader.u32();
      reader.zero(4);
      result.data = reader.take(length).slice();
      reader.zero(reader.bytes.byteLength - reader.offset);
      break;
    }
    case 3: {
      Object.assign(result, {
        id: reader.u32(),
        width: reader.u32(),
        height: reader.u32(),
        mipLevelCount: reader.u16(),
        sampleCount: reader.u16(),
        format: mapped(formats, reader.u16(), "texture format"),
      });
      result.dimension = mapped(
        textureDimensions,
        reader.u8(),
        "texture dimension"
      );
      const flags = reader.u8();
      if ((flags & ~1) || (result.dimension === "3d" && !(flags & 1))) {
        throw new ProtocolError("invalid texture flags", command.index);
      }
      result.usage = reader.u32();
      result.depthOrArrayLayers = flags & 1 ? reader.u32() : 1;
      break;
    }
    case 4: {
      Object.assign(result, {
        id: reader.u32(),
        mipLevel: reader.u32(),
        origin: { x: reader.u32(), y: reader.u32(), z: reader.u32() },
        size: {
          width: reader.u32(),
          height: reader.u32(),
          depthOrArrayLayers: reader.u32(),
        },
        bytesPerRow: reader.u32(),
        rowsPerImage: reader.u32(),
      });
      const length = reader.u32();
      result.data = reader.take(length).slice();
      reader.zero(reader.bytes.byteLength - reader.offset);
      break;
    }
    case 5:
      Object.assign(result, {
        id: reader.u32(),
        addressModeU: mapped(addressModes, reader.u8(), "address mode"),
        addressModeV: mapped(addressModes, reader.u8(), "address mode"),
        addressModeW: mapped(addressModes, reader.u8(), "address mode"),
        magFilter: mapped(filterModes, reader.u8(), "filter mode"),
        minFilter: mapped(filterModes, reader.u8(), "filter mode"),
        mipmapFilter: mapped(filterModes, reader.u8(), "filter mode"),
      });
      {
        const compare = reader.u8();
        result.compare = compare
          ? mapped(compareFunctions, compare, "compare function")
          : undefined;
      }
      result.maxAnisotropy = reader.u8();
      result.lodMinClamp = reader.f32();
      result.lodMaxClamp = reader.f32();
      reader.zero(4);
      break;
    case 6: {
      result.id = reader.u32();
      const length = reader.u32();
      result.source = reader.text(length);
      reader.zero(reader.bytes.byteLength - reader.offset);
      break;
    }
    case 7: {
      result.id = reader.u32();
      const count = reader.u32();
      result.entries = [];
      for (let i = 0; i < count; i++) {
        const binding = reader.u32();
        const visibility = reader.u32();
        const kind = reader.u16();
        const flags = reader.u16();
        reader.zero(4);
        const minBindingSize = reader.u64();
        const parameter0 = reader.u32();
        const parameter1 = reader.u32();
        let entry;
        if (kind === 1 || kind === 4 || kind === 5) {
          if (
            parameter0 ||
            parameter1 ||
            flags & ~1 ||
            (kind === 5 && visibility & GPU_SHADER_STAGE_VERTEX)
          ) {
            throw new ProtocolError(
              "invalid buffer binding layout",
              command.index
            );
          }
          let type = "storage";
          if (kind === 1) {
            type = "uniform";
          } else if (kind === 4) {
            type = "read-only-storage";
          }
          entry = {
            binding,
            visibility,
            buffer: {
              type,
              hasDynamicOffset: Boolean(flags & 1),
              minBindingSize,
            },
          };
        } else if (kind === 2) {
          if (flags || minBindingSize || parameter1) {
            throw new ProtocolError(
              "invalid sampler binding layout",
              command.index
            );
          }
          entry = {
            binding,
            visibility,
            sampler: {
              type: mapped(
                samplerBindingTypes,
                parameter0,
                "sampler binding type"
              ),
            },
          };
        } else if (kind === 3) {
          if (flags || minBindingSize) {
            throw new ProtocolError(
              "invalid texture binding layout",
              command.index
            );
          }
          entry = {
            binding,
            visibility,
            texture: {
              sampleType: mapped(
                textureSampleTypes,
                parameter0,
                "texture sample type"
              ),
              viewDimension: mapped(
                textureViewDimensions,
                parameter1,
                "texture view dimension"
              ),
              multisampled: false,
            },
          };
        } else {
          throw new ProtocolError(
            "unsupported bind group layout entry",
            command.index
          );
        }
        result.entries.push(entry);
      }
      break;
    }
    case 8: {
      result.id = reader.u32();
      const count = reader.u32();
      result.layouts = Array.from({ length: count }, () => reader.u32());
      break;
    }
    case 9: {
      result.id = reader.u32();
      result.layout = reader.u32();
      const count = reader.u32();
      result.entries = [];
      for (let i = 0; i < count; i++) {
        const binding = reader.u32();
        const resourceId = reader.u32();
        const kind = reader.u16();
        if (kind !== 1 && kind !== 2 && kind !== 3 && kind !== 4 && kind !== 5) {
          throw new ProtocolError(
            "unsupported bind group entry kind",
            command.index
          );
        }
        reader.zero(2);
        reader.zero(4);
        const offset = reader.u64();
        const size = reader.u64();
        result.entries.push({ binding, resourceId, kind, offset, size });
      }
      break;
    }
    case 10: {
      Object.assign(result, {
        id: reader.u32(),
        layout: reader.u32(),
        shader: reader.u32(),
      });
      const layoutCount = reader.u16();
      const attributeCount = reader.u16();
      const targetCount = reader.u16();
      result.flags = reader.u16();
      if (result.flags & ~PIPELINE_FLAGS) {
        throw new ProtocolError("reserved render pipeline flags", command.index);
      }
      result.depthFormatId = reader.u16();
      result.sampleCount = reader.u16();
      result.topology = mapped(topologies, reader.u8(), "primitive topology");
      result.frontFace = mapped(frontFaces, reader.u8(), "front face");
      result.cullMode = mapped(cullModes, reader.u8(), "cull mode");
      const stripIndex = reader.u8();
      result.stripIndexFormat = stripIndex
        ? mapped(indexFormats, stripIndex, "strip index format")
        : undefined;
      const depthCompare = reader.u8();
      result.depthCompare = depthCompare
        ? mapped(compareFunctions, depthCompare, "depth compare")
        : undefined;
      reader.zero(11);
      result.layouts = [];
      for (let i = 0; i < layoutCount; i++) {
        result.layouts.push({
          arrayStride: reader.u64(),
          stepMode: mapped(vertexStepModes, reader.u8(), "vertex step mode"),
          firstAttribute: (reader.zero(3), reader.u16()),
          attributeCount: reader.u16(),
        });
      }
      result.attributes = [];
      for (let i = 0; i < attributeCount; i++) {
        result.attributes.push({
          format: mapped(vertexFormats, reader.u16(), "vertex format"),
          shaderLocation: reader.u16(),
          offset: reader.u64(),
        });
        reader.zero(4);
      }
      result.targets = [];
      for (let i = 0; i < targetCount; i++) {
        const format = mapped(formats, reader.u16(), "color target format");
        const writeMask = reader.u16();
        const color = {
          operation: mapped(blendOperations, reader.u8(), "blend operation"),
          srcFactor: mapped(blendFactors, reader.u8(), "blend factor"),
          dstFactor: mapped(blendFactors, reader.u8(), "blend factor"),
        };
        const alpha = {
          operation: mapped(blendOperations, reader.u8(), "blend operation"),
          srcFactor: mapped(blendFactors, reader.u8(), "blend factor"),
          dstFactor: mapped(blendFactors, reader.u8(), "blend factor"),
        };
        reader.zero(6);
        result.targets.push({ format, writeMask, blend: { color, alpha } });
      }
      if (result.flags & PIPELINE_STENCIL_DEPTH_BIAS) {
        const face = () => ({
          compare: mapped(compareFunctions, reader.u8(), "stencil compare"),
          failOp: mapped(stencilOperations, reader.u8(), "stencil operation"),
          depthFailOp: mapped(stencilOperations, reader.u8(), "stencil operation"),
          passOp: mapped(stencilOperations, reader.u8(), "stencil operation"),
        });
        result.stencilFront = face();
        result.stencilBack = face();
        result.stencilReadMask = reader.u8();
        result.stencilWriteMask = reader.u8();
        reader.zero(2);
        result.depthBias = reader.i32();
        result.depthBiasSlopeScale = reader.f32();
        result.depthBiasClamp = reader.f32();
      }
      break;
    }
    case 11:
    case 13:
      result.id = reader.u32();
      break;
    case 12:
      Object.assign(result, {
        colorView: reader.u32(),
        depthView: reader.u32(),
        surfaceGeneration: reader.u32(),
        flags: reader.u32(),
        clearColor: {
          r: reader.f32(),
          g: reader.f32(),
          b: reader.f32(),
          a: reader.f32(),
        },
        clearDepth: reader.f32(),
      });
      if (result.flags & ~RENDER_PASS_FLAGS) {
        throw new ProtocolError("reserved render pass flags", command.index);
      }
      result.clearStencil =
        result.flags & RENDER_PASS_HAS_STENCIL_CLEAR ? reader.u32() : 0;
      if (result.flags & RENDER_PASS_HAS_OCCLUSION_QUERIES) {
        result.queryCount = reader.u32();
        result.queryToken = reader.u32();
      }
      break;
    case 14:
      Object.assign(result, {
        slot: reader.u32(),
        buffer: reader.u32(),
        offset: reader.u64(),
        size: reader.u64(),
      });
      break;
    case 15:
      Object.assign(result, {
        buffer: reader.u32(),
        format: mapped(indexFormats, reader.u32(), "index format"),
        offset: reader.u64(),
        size: reader.u64(),
      });
      break;
    case 16: {
      result.bindIndex = reader.u32();
      result.bindGroup = reader.u32();
      const count = reader.u32();
      result.dynamicOffsets = Array.from({ length: count }, () => reader.u32());
      break;
    }
    case 17:
      result.values = Array.from({ length: 6 }, () => reader.f32());
      break;
    case 18:
    case 19:
      result.values = Array.from({ length: 4 }, () => reader.u32());
      break;
    case 20:
      result.values = [
        reader.u32(),
        reader.u32(),
        reader.u32(),
        reader.i32(),
        reader.u32(),
      ];
      break;
    case 21:
      break;
    case 22:
      Object.assign(result, {
        source: reader.u32(),
        destination: reader.u32(),
        sourceOffset: reader.u64(),
        destinationOffset: reader.u64(),
        size: reader.u64(),
      });
      break;
    case 23:
      Object.assign(result, {
        id: reader.u32(),
        texture: reader.u32(),
        format: mapped(formats, reader.u16(), "texture view format"),
      });
      result.dimension = mapped(
        textureViewDimensions,
        reader.u8(),
        "texture view dimension"
      );
      result.aspect = mapped(textureAspects, reader.u8(), "texture aspect");
      result.baseMipLevel = reader.u16();
      result.mipLevelCount = reader.u16();
      result.baseArrayLayer = reader.u16();
      result.arrayLayerCount = reader.u16();
      break;
    case 24:
      Object.assign(result, {
        id: reader.u32(),
        layout: reader.u32(),
        shader: reader.u32(),
      });
      reader.zero(4);
      break;
    case 25:
      break;
    case 26:
      result.id = reader.u32();
      break;
    case 27: {
      result.bindIndex = reader.u32();
      result.bindGroup = reader.u32();
      const count = reader.u32();
      result.dynamicOffsets = Array.from({ length: count }, () => reader.u32());
      break;
    }
    case 28:
      result.values = [reader.u32(), reader.u32(), reader.u32()];
      break;
    case 29:
      break;
    case 30:
      result.reference = reader.u32();
      break;
    case 31:
      result.color = {
        r: reader.f32(),
        g: reader.f32(),
        b: reader.f32(),
        a: reader.f32(),
      };
      break;
    case 32:
      result.query = reader.u32();
      break;
    case 33:
      break;
    default:
      throw new ProtocolError(
        `unsupported GPU opcode ${command.opcode}`,
        command.index
      );
  }
  reader.finish();
  return result;
}

class GpuEngine {
  constructor(
    canvas,
    device,
    context,
    format,
    limits,
    dimensions,
    testReadback,
    testDeviceLoss,
    requirements
  ) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.format = format;
    this.formatId = formatIds.get(format);
    this.limits = limits;
    // Restoring the device needs the same inputs the first one was built from.
    this.requirements = requirements;
    this.resources = new Map();
    this.handleSlots = new Map();
    this.surfaceGeneration = 1;
    this.deviceGeneration = 1;
    this.lastSequence = 0;
    this.stopped = false;
    this.disposed = false;
    this.backgrounded = false;
    this.backgroundRequested = false;
    this.foregroundScheduled = false;
    this.backgroundTexture = null;
    this.backgroundTextureValid = false;
    this.backgroundTextureSequence = 0;
    this.queue = Promise.resolve();
    // Occlusion results resolve after their batch, in submission order.
    this.occlusionDelivery = Promise.resolve();
    this.occlusionEpoch = 0;
    this.occlusionReadbacks = new Set();
    this.pendingBatches = 0;
    this.testReadbacksRemaining = testReadback ? 8 : 0;
    this.testDeviceLossPending = testDeviceLoss;
    this.pendingResize = null;
    this.resizeScheduled = false;
    this.resize(dimensions, false);
    this.observeDevice(device);
  }

  /**
   * A browser drops the device on driver resets, tab backgrounding, and memory
   * pressure. The guest is told, the device is rebuilt, and the guest is told
   * again; every GPU resource dies with the old device, so the guest owns
   * recreating them.
   */
  observeDevice(device) {
    device.addEventListener("uncapturederror", event => {
      if (this.stopped || this.disposed || this.device !== device) return;
      this.emitTextEvent(
        4,
        0,
        1,
        event.error?.message || "uncaptured WebGPU error"
      );
    });
    void device.lost.then(info => {
      if (this.stopped || this.disposed || this.device !== device) {
        return;
      }
      this.stopped = true;
      this.abandonOcclusionResults();
      this.destroyBackgroundTexture();
      this.emitTextEvent(7, 0, 1, info.message || "WebGPU device lost");
      void this.restore();
    });
  }

  async restore() {
    if (this.disposed) {
      return;
    }
    let replacement;
    let failure;
    for (let attempt = 1; attempt <= MAX_DEVICE_RESTORE_ATTEMPTS; attempt++) {
      if (this.disposed) {
        return;
      }
      try {
        replacement = await GpuEngine.acquireDevice(
          this.canvas,
          this.requirements
        );
        break;
      } catch (error) {
        failure = error;
        if (attempt < MAX_DEVICE_RESTORE_ATTEMPTS) {
          await new Promise(resolve => {
            setTimeout(resolve, DEVICE_RESTORE_RETRY_DELAY_MS * attempt);
          });
        }
      }
    }
    if (!replacement) {
      // The guest already has the loss event; a Host that cannot rebuild the
      // device leaves it there rather than pretending the surface came back.
      postMessage({
        type: "error",
        message: `WebGPU device could not be restored: ${failure?.message || String(failure)}`,
      });
      return;
    }
    if (this.disposed) {
      replacement.device.destroy();
      return;
    }
    // Every handle referred to the dead device, so the slot table starts empty
    // and the guest re-creates what it needs after the restored event.
    this.resources.clear();
    this.handleSlots.clear();
    this.destroyBackgroundTexture();
    this.device = replacement.device;
    this.context = replacement.context;
    this.format = replacement.format;
    this.formatId = formatIds.get(replacement.format);
    this.limits = replacement.limits;
    this.deviceGeneration++;
    this.lastSequence = 0;
    this.pendingBatches = 0;
    this.pendingResize = null;
    this.resizeScheduled = false;
    this.foregroundScheduled = false;
    this.backgrounded = this.backgroundRequested;
    this.queue = Promise.resolve();
    this.stopped = false;
    this.configureSurface();
    this.observeDevice(replacement.device);
    postBytes("capabilities", this.capabilities());
    this.emitTextEvent(8, 0, 0, "WebGPU device restored");
  }

  /** Acquires an adapter, device, context and limit table for `requirements`. */
  static async acquireDevice(canvas, requirements) {
    if (!globalThis.navigator?.gpu) {
      throw new Error("WebGPU is unavailable");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("WebGPU adapter is unavailable");
    }
    const ceilings = {
      maxTextureDimension2D: 4096,
      maxTextureDimension3D: MAX_TEXTURE_DIMENSION_3D,
      maxTextureArrayLayers: MAX_TEXTURE_ARRAY_LAYERS,
      maxBufferSize: 16 * 1024 * 1024,
      maxBindingsPerBindGroup: 16,
      maxBindGroups: 4,
      maxVertexBuffers: 8,
      maxVertexAttributes: 16,
      maxColorAttachments: 4,
      maxStorageBufferBindingSize: 16 * 1024 * 1024,
      maxStorageBuffersPerShaderStage: 8,
      maxComputeWorkgroupStorageSize: 16 * 1024,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupSizeX: 256,
      maxComputeWorkgroupSizeY: 256,
      maxComputeWorkgroupSizeZ: 64,
      maxComputeWorkgroupsPerDimension: 65_535,
    };
    const requested = {};
    for (const [name, ceiling] of Object.entries(ceilings)) {
      const available = Number(adapter.limits[name]);
      if (!Number.isFinite(available) || available <= 0) {
        throw new Error(`WebGPU adapter omitted ${name}`);
      }
      requested[name] = Math.min(ceiling, available);
    }
    for (const [name, minimum] of Object.entries(
      requirements.requiredLimits || {}
    )) {
      if (
        !(name in requested) ||
        !Number.isSafeInteger(minimum) ||
        minimum <= 0 ||
        requested[name] < minimum
      ) {
        throw new Error(`WebGPU does not satisfy required limit ${name}`);
      }
    }
    if (
      Array.isArray(requirements.requiredFeatures) &&
      requirements.requiredFeatures.length
    ) {
      throw new Error(
        "optional WebGPU features are unavailable in profile version 1"
      );
    }
    const device = await adapter.requestDevice({
      requiredFeatures: [],
      requiredLimits: requested,
    });
    const context = canvas.getContext("webgpu");
    if (!context) {
      throw new Error("WebGPU canvas context is unavailable");
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    if (!formatIds.has(format)) {
      throw new Error(`unsupported WebGPU surface format ${format}`);
    }
    const limits = [
      requested.maxTextureDimension2D,
      requested.maxBufferSize,
      requested.maxBindingsPerBindGroup,
      requested.maxBindGroups,
      requested.maxVertexBuffers,
      requested.maxVertexAttributes,
      requested.maxColorAttachments,
      256 * 1024 * 1024,
      64 * 1024 * 1024,
      8192,
      MAX_BATCH_BYTES,
      16 * 1024 * 1024,
      requested.maxStorageBufferBindingSize,
      requested.maxStorageBuffersPerShaderStage,
      requested.maxComputeWorkgroupStorageSize,
      requested.maxComputeInvocationsPerWorkgroup,
      requested.maxComputeWorkgroupSizeX,
      requested.maxComputeWorkgroupSizeY,
      requested.maxComputeWorkgroupSizeZ,
      requested.maxComputeWorkgroupsPerDimension,
      MAX_DISPATCHES_PER_BATCH,
      RASTER_FEATURE_LAYERED_TEXTURES |
        RASTER_FEATURE_STENCIL_DEPTH_BIAS |
        RASTER_FEATURE_BLEND_CONSTANT |
        RASTER_FEATURE_OCCLUSION_QUERIES,
      requested.maxTextureDimension3D,
      requested.maxTextureArrayLayers,
    ];
    return { device, context, format, limits };
  }

  static async create(
    canvas,
    requirements,
    dimensions,
    testReadback,
    testDeviceLoss
  ) {
    const acquired = await GpuEngine.acquireDevice(canvas, requirements);
    return new GpuEngine(
      canvas,
      acquired.device,
      acquired.context,
      acquired.format,
      acquired.limits,
      dimensions,
      testReadback,
      testDeviceLoss,
      requirements
    );
  }

  resize(dimensions, notify = true) {
    const physicalWidth = Math.max(
      1,
      Math.min(this.limits[0], dimensions.physicalWidth >>> 0)
    );
    const physicalHeight = Math.max(
      1,
      Math.min(this.limits[0], dimensions.physicalHeight >>> 0)
    );
    const logicalWidth = Math.max(1, dimensions.logicalWidth >>> 0);
    const logicalHeight = Math.max(1, dimensions.logicalHeight >>> 0);
    const scale = Number(dimensions.scale);
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new Error("invalid WebGPU surface scale");
    }
    const changed =
      this.physicalWidth !== physicalWidth ||
      this.physicalHeight !== physicalHeight ||
      this.logicalWidth !== logicalWidth ||
      this.logicalHeight !== logicalHeight ||
      this.scale !== scale;
    this.physicalWidth = physicalWidth;
    this.physicalHeight = physicalHeight;
    this.logicalWidth = logicalWidth;
    this.logicalHeight = logicalHeight;
    this.scale = scale;
    if (changed) {
      this.destroyBackgroundTexture();
    }
    this.canvas.width = physicalWidth;
    this.canvas.height = physicalHeight;
    this.configureSurface();
    if (notify && changed) {
      this.surfaceGeneration++;
      postBytes("capabilities", this.capabilities());
      const payload = new Uint8Array(28);
      const view = new DataView(payload.buffer);
      for (const [offset, value] of [
        [0, this.surfaceGeneration],
        [4, physicalWidth],
        [8, physicalHeight],
        [12, logicalWidth],
        [16, logicalHeight],
      ]) {
        view.setUint32(offset, value, true);
      }
      view.setFloat32(20, scale, true);
      view.setUint16(24, this.formatId, true);
      postBytes("event", makeEvent(6, 0, payload));
    }
  }

  /** Binds the canvas to the current device; a restored device needs this too. */
  configureSurface() {
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "opaque",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_DST |
        (this.testReadbacksRemaining > 0 ? GPUTextureUsage.COPY_SRC : 0),
    });
  }

  setBackground(backgrounded) {
    this.backgroundRequested = backgrounded;
    if (backgrounded) {
      // Hiding takes effect even for batches waiting on validation or readback.
      this.backgrounded = true;
      return;
    }
    if (!this.backgrounded || this.foregroundScheduled) {
      return;
    }
    this.foregroundScheduled = true;
    const device = this.device;
    this.queue = this.queue
      .then(() => {
        if (this.device !== device || this.disposed) return;
        this.foregroundScheduled = false;
        if (this.backgroundRequested) {
          return;
        }
        this.backgrounded = false;
        if (this.stopped) {
          return;
        }
        // Idle guests need not redraw on resume. Publish the last stored hidden
        // surface, after its batch completes and before subsequent guest work.
        // This is presentation only: no command replay or additional fence.
        if (this.backgroundTextureValid) {
          const encoder = this.device.createCommandEncoder();
          encoder.copyTextureToTexture(
            { texture: this.backgroundTexture },
            { texture: this.context.getCurrentTexture() },
            [this.physicalWidth, this.physicalHeight, 1]
          );
          this.device.queue.submit([encoder.finish()]);
          postMessage({
            type: "presented",
            sequence: this.backgroundTextureSequence,
          });
        }
        this.destroyBackgroundTexture();
      })
      .catch(error => {
        if (this.device !== device || this.disposed) return;
        postMessage({ type: "error", message: error.message || String(error) });
        this.stopped = true;
        this.abandonOcclusionResults();
      });
  }

  destroyBackgroundTexture() {
    this.backgroundTexture?.destroy();
    this.backgroundTexture = null;
    this.backgroundTextureValid = false;
    this.backgroundTextureSequence = 0;
  }

  surfaceTexture() {
    if (!this.backgrounded) {
      return this.context.getCurrentTexture();
    }
    // Surface passes still run: they may share a batch with resource uploads,
    // compute work or readbacks. One device-local target bounds hidden rendering.
    return (this.backgroundTexture ??= this.device.createTexture({
      size: [this.physicalWidth, this.physicalHeight, 1],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    }));
  }

  scheduleResize(dimensions) {
    this.pendingResize = dimensions;
    if (this.resizeScheduled) {
      return;
    }
    this.resizeScheduled = true;
    const device = this.device;
    this.queue = this.queue
      .then(() => {
        if (this.device !== device || this.disposed) return;
        const latest = this.pendingResize;
        this.pendingResize = null;
        this.resizeScheduled = false;
        if (!this.stopped && latest) {
          this.resize(latest);
        }
      })
      .catch(error => {
        if (this.device !== device || this.disposed) return;
        postMessage({ type: "error", message: error.message || String(error) });
        this.stopped = true;
        this.abandonOcclusionResults();
      });
  }

  capabilities() {
    const bytes = new Uint8Array(56 + this.limits.length * 16);
    const view = new DataView(bytes.buffer);
    bytes.set(textEncoder.encode("EGC1"), 0);
    view.setUint16(4, WIRE_VERSION, true);
    view.setUint32(8, bytes.byteLength, true);
    view.setUint16(12, this.formatId, true);
    view.setUint32(16, this.physicalWidth, true);
    view.setUint32(20, this.physicalHeight, true);
    view.setUint32(24, this.logicalWidth, true);
    view.setUint32(28, this.logicalHeight, true);
    view.setFloat32(32, this.scale, true);
    view.setUint32(36, this.surfaceGeneration, true);
    view.setUint32(40, this.deviceGeneration, true);
    view.setUint32(44, this.limits.length, true);
    this.limits.forEach((value, index) => {
      const offset = 56 + index * 16;
      view.setUint16(offset, index + 1, true);
      view.setBigUint64(offset + 4, BigInt(value), true);
    });
    return bytes;
  }

  submit(bytes) {
    const device = this.device;
    if (this.pendingBatches >= MAX_PENDING_BATCHES) {
      this.emitBatchRejected(0xffffffff, 3, 0, "GPU submission queue is full");
      return;
    }
    this.pendingBatches++;
    this.queue = this.queue
      .then(() => {
        if (this.device === device) return this.execute(bytes);
      })
      .catch(error => {
        if (this.device !== device || this.disposed) return;
        postMessage({ type: "error", message: error.message || String(error) });
        this.stopped = true;
        this.abandonOcclusionResults();
      })
      .finally(() => {
        if (this.device === device) this.pendingBatches--;
      });
  }

  // Validation is one atomic state transition across the complete opcode set.
  // eslint-disable-next-line complexity
  validate(batch) {
    if (batch.sequence <= this.lastSequence) {
      throw new ProtocolError("GPU sequence is not increasing");
    }
    const shadow = new Map(this.resources);
    const slots = new Map(this.handleSlots);
    let pass = false;
    let computePass = false;
    const stats = resourceStats(shadow);
    const creations = {
      counts: new Map(),
      bufferBytes: 0,
      textureBytes: 0,
      compilations: 0,
    };
    let renderPasses = 0;
    let occlusionQueries = 0;
    let pendingQueries = 0;
    for (const entry of this.occlusionReadbacks) pendingQueries += entry.count;
    let pendingQueryPasses = this.occlusionReadbacks.size;
    let queries = null;
    let draws = 0;
    let computePasses = 0;
    let dispatches = 0;
    let uploadBytes = 0;
    const commands = batch.commands.map(parseCommand);
    for (const command of commands) {
      const index = command.index;
      if (command.opcode === 2 || command.opcode === 4) {
        uploadBytes += command.data.byteLength;
        if (uploadBytes > this.limits[11]) {
          throw new ProtocolError("GPU upload budget exceeded", index);
        }
      }
      switch (command.opcode) {
        case 1:
          if (!command.size || command.size > this.limits[1]) {
            throw new ProtocolError("invalid buffer size", index);
          }
          command.resourceEntry = createBoundedResource(
            shadow,
            slots,
            stats,
            creations,
            command.id,
            "buffer",
            command,
            index
          );
          break;
        case 2:
          resource(shadow, command.id, "buffer", index);
          break;
        case 3:
          validateTexture(command, this.limits);
          command.resourceEntry = createBoundedResource(
            shadow,
            slots,
            stats,
            creations,
            command.id,
            "texture",
            command,
            index
          );
          break;
        case 4:
          validateTextureUpload(
            command,
            resource(shadow, command.id, "texture", index).descriptor
          );
          break;
        case 5:
          command.resourceEntry = createBoundedResource(
            shadow,
            slots,
            stats,
            creations,
            command.id,
            "sampler",
            command,
            index
          );
          break;
        case 6:
          if (!command.source.length || command.source.length > 1024 * 1024) {
            throw new ProtocolError("invalid WGSL source", index);
          }
          command.resourceEntry = createBoundedResource(
            shadow,
            slots,
            stats,
            creations,
            command.id,
            "shader",
            command,
            index
          );
          break;
        case 7:
          if (command.entries.length > this.limits[2]) {
            throw new ProtocolError("too many bind group entries", index);
          }
          command.resourceEntry = createBoundedResource(
            shadow,
            slots,
            stats,
            creations,
            command.id,
            "bindGroupLayout",
            command,
            index
          );
          break;
        case 8:
          if (command.layouts.length > this.limits[3]) {
            throw new ProtocolError("too many pipeline bind groups", index);
          }
          command.layouts.forEach(id =>
            resource(shadow, id, "bindGroupLayout", index)
          );
          command.resourceEntry = createBoundedResource(
            shadow,
            slots,
            stats,
            creations,
            command.id,
            "pipelineLayout",
            command,
            index
          );
          break;
        case 9:
          if (command.entries.length > this.limits[2]) {
            throw new ProtocolError("too many bind group entries", index);
          }
          resource(shadow, command.layout, "bindGroupLayout", index);
          for (const entry of command.entries) {
            resource(
              shadow,
              entry.resourceId,
              bindGroupResourceKinds.get(entry.kind) || "",
              index
            );
          }
          validateTextureBindings(command, shadow);
          command.resourceEntry = createBoundedResource(
            shadow,
            slots,
            stats,
            creations,
            command.id,
            "bindGroup",
            command,
            index
          );
          break;
        case 10:
          resource(shadow, command.layout, "pipelineLayout", index);
          resource(shadow, command.shader, "shader", index);
          if (
            command.layouts.length > this.limits[4] ||
            command.attributes.length > this.limits[5] ||
            command.targets.length > this.limits[6]
          ) {
            throw new ProtocolError(
              "pipeline exceeds negotiated limits",
              index
            );
          }
          validatePipelineDepthStencil(command, index);
          command.resourceEntry = createBoundedResource(
            shadow,
            slots,
            stats,
            creations,
            command.id,
            "renderPipeline",
            command,
            index
          );
          break;
        case 11: {
          const removed = resource(shadow, command.id, null, index);
          adjustResourceStats(stats, removed, -1, index);
          shadow.delete(command.id);
          slots.set(command.id & HANDLE_SLOT_MASK, command.id >>> 20);
          break;
        }
        case 12:
          if (pass || computePass) {
            throw new ProtocolError("nested GPU pass", index);
          }
          if (command.colorView === 0 &&
              command.surfaceGeneration !== this.surfaceGeneration) {
            throw new ProtocolError(
              `render pass surface generation ${command.surfaceGeneration} ` +
                `does not match current generation ${this.surfaceGeneration}`,
              index,
              BATCH_ERROR_STALE_SURFACE
            );
          }
          if (command.colorView !== 0) {
            validateTextureAttachment(shadow, command.colorView, false, index);
          }
          renderPasses++;
          if (renderPasses > MAX_RENDER_PASSES_PER_BATCH) {
            throw new ProtocolError("too many render passes", index);
          }
          if (command.depthView) {
            validateTextureAttachment(shadow, command.depthView, true, index);
          }
          validateStencilPass(command, shadow, index);
          queries = null;
          if (command.flags & RENDER_PASS_HAS_OCCLUSION_QUERIES) {
            if (command.queryCount === 0) {
              throw new ProtocolError("occlusion query count must be nonzero", index);
            }
            occlusionQueries += command.queryCount;
            if (occlusionQueries > MAX_OCCLUSION_QUERIES_PER_BATCH) {
              throw new ProtocolError("occlusion query count exceeds the batch limit", index);
            }
            pendingQueries += command.queryCount;
            pendingQueryPasses++;
            if (pendingQueries > MAX_OCCLUSION_QUERIES_PER_BATCH * MAX_PENDING_BATCHES ||
                pendingQueryPasses > MAX_RENDER_PASSES_PER_BATCH * MAX_PENDING_BATCHES) {
              throw new ProtocolError("GPU occlusion readback queue is full", index, 3);
            }
            queries = { count: command.queryCount, used: new Set(), open: false };
          }
          pass = true;
          break;
        case 13:
          if (!pass) {
            throw new ProtocolError("pipeline set outside render pass", index);
          }
          resource(shadow, command.id, "renderPipeline", index);
          break;
        case 14:
          if (command.slot >= this.limits[4]) {
            throw new ProtocolError(
              "vertex buffer slot exceeds negotiated limits",
              index
            );
          }
          if (!pass) {
            throw new ProtocolError(
              "vertex buffer set outside render pass",
              index
            );
          }
          resource(shadow, command.buffer, "buffer", index);
          break;
        case 15:
          if (!pass) {
            throw new ProtocolError(
              "index buffer set outside render pass",
              index
            );
          }
          resource(shadow, command.buffer, "buffer", index);
          break;
        case 16:
          if (command.bindIndex >= this.limits[3]) {
            throw new ProtocolError(
              "bind group index exceeds negotiated limits",
              index
            );
          }
          if (!pass) {
            throw new ProtocolError(
              "bind group set outside render pass",
              index
            );
          }
          resource(shadow, command.bindGroup, "bindGroup", index);
          break;
        case 17:
        case 18:
          if (!pass) {
            throw new ProtocolError(
              "render command outside render pass",
              index
            );
          }
          break;
        case 19:
        case 20:
          if (!pass) {
            throw new ProtocolError(
              "render command outside render pass",
              index
            );
          }
          draws++;
          if (draws > MAX_DRAWS_PER_BATCH) {
            throw new ProtocolError("too many draw commands", index);
          }
          break;
        case 21:
          if (!pass) {
            throw new ProtocolError("render pass is not active", index);
          }
          if (queries?.open) {
            throw new ProtocolError("render pass ended with an open occlusion query", index);
          }
          pass = false;
          queries = null;
          break;
        case 22:
          if (pass || computePass) {
            throw new ProtocolError("buffer copy inside GPU pass", index);
          }
          resource(shadow, command.source, "buffer", index);
          resource(shadow, command.destination, "buffer", index);
          break;
        case 23:
          validateTextureView(
            command,
            resource(shadow, command.texture, "texture", index).descriptor
          );
          command.resourceEntry = createBoundedResource(
            shadow,
            slots,
            stats,
            creations,
            command.id,
            "textureView",
            command,
            index
          );
          break;
        case 24:
          resource(shadow, command.layout, "pipelineLayout", index);
          resource(shadow, command.shader, "shader", index);
          command.resourceEntry = createBoundedResource(
            shadow,
            slots,
            stats,
            creations,
            command.id,
            "computePipeline",
            command,
            index
          );
          break;
        case 25:
          if (pass || computePass) {
            throw new ProtocolError("nested GPU pass", index);
          }
          computePasses++;
          if (computePasses > MAX_COMPUTE_PASSES_PER_BATCH) {
            throw new ProtocolError("too many compute passes", index);
          }
          computePass = true;
          break;
        case 26:
          if (!computePass) {
            throw new ProtocolError("compute pipeline set outside compute pass", index);
          }
          resource(shadow, command.id, "computePipeline", index);
          break;
        case 27:
          if (command.bindIndex >= this.limits[3]) {
            throw new ProtocolError(
              "bind group index exceeds negotiated limits",
              index
            );
          }
          if (!computePass) {
            throw new ProtocolError("bind group set outside compute pass", index);
          }
          resource(shadow, command.bindGroup, "bindGroup", index);
          break;
        case 28:
          if (!computePass) {
            throw new ProtocolError("dispatch outside compute pass", index);
          }
          if (command.values.some(value => value === 0 || value > this.limits[19])) {
            throw new ProtocolError("dispatch exceeds negotiated limits", index);
          }
          dispatches++;
          if (dispatches > MAX_DISPATCHES_PER_BATCH) {
            throw new ProtocolError("too many dispatch commands", index);
          }
          break;
        case 29:
          if (!computePass) {
            throw new ProtocolError("compute pass is not active", index);
          }
          computePass = false;
          break;
        case 30:
          if (!pass) {
            throw new ProtocolError("stencil reference outside render pass", index);
          }
          if (command.reference > MAX_STENCIL_VALUE) {
            throw new ProtocolError("stencil reference exceeds 255", index);
          }
          break;
        case 31:
          if (!pass) {
            throw new ProtocolError("blend constant outside render pass", index);
          }
          break;
        case 32:
          if (!pass) {
            throw new ProtocolError("occlusion query outside render pass", index);
          }
          if (!queries) {
            throw new ProtocolError("render pass has no occlusion queries", index);
          }
          if (queries.open) {
            throw new ProtocolError("occlusion queries cannot nest", index);
          }
          if (command.query >= queries.count) {
            throw new ProtocolError("occlusion query index exceeds the pass query count", index);
          }
          if (queries.used.has(command.query)) {
            throw new ProtocolError("occlusion query index is reused within its pass", index);
          }
          queries.used.add(command.query);
          queries.open = true;
          break;
        case 33:
          if (!queries?.open) {
            throw new ProtocolError("occlusion query is not active", index);
          }
          queries.open = false;
          break;
      }
    }
    if (pass) {
      throw new ProtocolError("render pass was not ended");
    }
    if (computePass) {
      throw new ProtocolError("compute pass was not ended");
    }
    return { commands, shadow, slots };
  }

  // Execution mirrors the validated opcode set and commits it transactionally.
  // eslint-disable-next-line complexity
  async execute(bytes) {
    if (this.stopped) {
      return;
    }
    const device = this.device;
    const epoch = this.occlusionEpoch;
    let batch;
    let validated;
    try {
      batch = parseCommands(bytes);
    } catch (error) {
      throw new Error(`malformed GPU batch: ${error.message}`);
    }
    try {
      validated = this.validate(batch);
    } catch (error) {
      this.emitBatchRejected(
        error.commandIndex ?? 0xffffffff,
        error.errorCode ?? 1,
        batch.sequence,
        error.message
      );
      return;
    }
    this.device.pushErrorScope("validation");
    this.device.pushErrorScope("out-of-memory");
    const next = new Map(this.resources);
    let encoder = null;
    let pass = null;
    let surfaceView = null;
    let surfaceTexture = null;
    let readback = null;
    let surfaceStored = false;
    let occlusion = null;
    const occlusionReadbacks = [];
    const backgrounded = this.backgrounded;
    const removed = [];
    const shaders = [];
    const created = [];
    try {
      for (const command of validated.commands) {
        const entry = command.resourceEntry;
        switch (command.opcode) {
          case 1:
            entry.value = this.device.createBuffer({
              size: command.size,
              usage: command.usage,
            });
            next.set(command.id, entry);
            created.push(entry);
            break;
          case 2:
            this.device.queue.writeBuffer(
              resource(next, command.id, "buffer", command.index).value,
              command.offset,
              command.data
            );
            break;
          case 3:
            entry.value = this.device.createTexture({
              size: [
                command.width,
                command.height,
                command.depthOrArrayLayers,
              ],
              mipLevelCount: command.mipLevelCount,
              sampleCount: command.sampleCount,
              dimension: command.dimension,
              format: command.format,
              usage: command.usage,
            });
            next.set(command.id, entry);
            created.push(entry);
            break;
          case 4:
            this.device.queue.writeTexture(
              {
                texture: resource(next, command.id, "texture", command.index)
                  .value,
                mipLevel: command.mipLevel,
                origin: command.origin,
              },
              command.data,
              {
                offset: 0,
                bytesPerRow: command.bytesPerRow,
                rowsPerImage: command.rowsPerImage,
              },
              command.size
            );
            break;
          case 5:
            entry.value = this.device.createSampler(command);
            next.set(command.id, entry);
            created.push(entry);
            break;
          case 6:
            entry.value = this.device.createShaderModule({
              code: command.source,
            });
            next.set(command.id, entry);
            created.push(entry);
            shaders.push([entry, command.id]);
            break;
          case 7:
            entry.value = this.device.createBindGroupLayout({
              entries: command.entries,
            });
            next.set(command.id, entry);
            created.push(entry);
            break;
          case 8:
            entry.value = this.device.createPipelineLayout({
              bindGroupLayouts: command.layouts.map(
                id => resource(next, id, "bindGroupLayout", command.index).value
              ),
            });
            next.set(command.id, entry);
            created.push(entry);
            break;
          case 9:
            entry.value = this.device.createBindGroup({
              layout: resource(
                next,
                command.layout,
                "bindGroupLayout",
                command.index
              ).value,
              entries: command.entries.map(item => ({
                binding: item.binding,
                resource:
                  item.kind === 1 || item.kind === 4 || item.kind === 5
                    ? {
                        buffer: resource(
                          next,
                          item.resourceId,
                          "buffer",
                          command.index
                        ).value,
                        offset: item.offset,
                        size: item.size,
                      }
                    : resource(
                        next,
                        item.resourceId,
                        item.kind === 2 ? "sampler" : "textureView",
                        command.index
                      ).value,
              })),
            });
            next.set(command.id, entry);
            created.push(entry);
            break;
          case 10: {
            const buffers = command.layouts.map(layout => ({
              arrayStride: layout.arrayStride,
              stepMode: layout.stepMode,
              attributes: command.attributes.slice(
                layout.firstAttribute,
                layout.firstAttribute + layout.attributeCount
              ),
            }));
            const descriptor = {
              layout: resource(
                next,
                command.layout,
                "pipelineLayout",
                command.index
              ).value,
              vertex: {
                module: resource(next, command.shader, "shader", command.index)
                  .value,
                entryPoint: "vs_main",
                buffers,
              },
              fragment: {
                module: resource(next, command.shader, "shader", command.index)
                  .value,
                entryPoint: "fs_main",
                targets: command.targets,
              },
              primitive: {
                topology: command.topology,
                frontFace: command.frontFace,
                cullMode: command.cullMode,
                stripIndexFormat: command.stripIndexFormat,
              },
              multisample: { count: command.sampleCount },
            };
            if (command.depthFormatId) {
              descriptor.depthStencil = {
                format: mapped(formats, command.depthFormatId, "depth format"),
                depthWriteEnabled: Boolean(command.flags & PIPELINE_DEPTH_WRITE),
                depthCompare: command.depthCompare,
              };
              if (command.flags & PIPELINE_STENCIL_DEPTH_BIAS) {
                Object.assign(descriptor.depthStencil, {
                  stencilFront: command.stencilFront,
                  stencilBack: command.stencilBack,
                  stencilReadMask: command.stencilReadMask,
                  stencilWriteMask: command.stencilWriteMask,
                  depthBias: command.depthBias,
                  depthBiasSlopeScale: command.depthBiasSlopeScale,
                  depthBiasClamp: command.depthBiasClamp,
                });
              }
            }
            entry.value = this.device.createRenderPipeline(descriptor);
            next.set(command.id, entry);
            created.push(entry);
            break;
          }
          case 11: {
            const removedEntry = resource(
              next,
              command.id,
              null,
              command.index
            );
            removed.push(removedEntry);
            next.delete(command.id);
            break;
          }
          case 12: {
            encoder ||= this.device.createCommandEncoder();
            if (!command.colorView) {
              surfaceStored = (command.flags & 2) !== 0;
              if (backgrounded) {
                this.backgroundTextureValid = false;
              }
            }
            const colorAttachment = {
              view: command.colorView
                ? resource(
                    next,
                    command.colorView,
                    "textureView",
                    command.index
                  ).value
                : (surfaceView ??= (surfaceTexture ??=
                    this.surfaceTexture()).createView()),
              loadOp: command.flags & 1 ? "load" : "clear",
              storeOp: command.flags & 2 ? "store" : "discard",
              clearValue: command.clearColor,
            };
            const descriptor = { colorAttachments: [colorAttachment] };
            if (command.depthView) {
              const depthView = resource(
                next,
                command.depthView,
                "textureView",
                command.index
              );
              descriptor.depthStencilAttachment = {
                view: depthView.value,
                depthLoadOp: command.flags & RENDER_PASS_DEPTH_LOAD ? "load" : "clear",
                depthStoreOp:
                  command.flags & RENDER_PASS_DEPTH_STORE ? "store" : "discard",
                depthClearValue: command.clearDepth,
              };
              if (stencilFormat(depthView.descriptor.format)) {
                Object.assign(descriptor.depthStencilAttachment, {
                  stencilLoadOp:
                    command.flags & RENDER_PASS_STENCIL_LOAD ? "load" : "clear",
                  stencilStoreOp:
                    command.flags & RENDER_PASS_STENCIL_STORE ? "store" : "discard",
                  stencilClearValue: command.clearStencil,
                });
              }
            }
            if (command.queryCount) {
              occlusion = {
                querySet: this.device.createQuerySet({
                  type: "occlusion",
                  count: command.queryCount,
                }),
                count: command.queryCount,
                token: command.queryToken,
                used: new Uint8Array(command.queryCount),
              };
              occlusionReadbacks.push(occlusion);
              this.occlusionReadbacks.add(occlusion);
              descriptor.occlusionQuerySet = occlusion.querySet;
            }
            pass = encoder.beginRenderPass(descriptor);
            break;
          }
          case 13:
            pass.setPipeline(
              resource(next, command.id, "renderPipeline", command.index).value
            );
            break;
          case 14:
            pass.setVertexBuffer(
              command.slot,
              resource(next, command.buffer, "buffer", command.index).value,
              command.offset,
              command.size
            );
            break;
          case 15:
            pass.setIndexBuffer(
              resource(next, command.buffer, "buffer", command.index).value,
              command.format,
              command.offset,
              command.size
            );
            break;
          case 16:
            pass.setBindGroup(
              command.bindIndex,
              resource(next, command.bindGroup, "bindGroup", command.index)
                .value,
              command.dynamicOffsets
            );
            break;
          case 17:
            pass.setViewport(...command.values);
            break;
          case 18:
            pass.setScissorRect(...command.values);
            break;
          case 19:
            pass.draw(...command.values);
            break;
          case 20:
            pass.drawIndexed(...command.values);
            break;
          case 21:
            if (occlusion) {
              // Unused indices run an empty query, so every result is zero
              // instead of depending on how unwritten queries resolve.
              occlusion.used.forEach((used, query) => {
                if (!used) {
                  pass.beginOcclusionQuery(query);
                  pass.endOcclusionQuery();
                }
              });
            }
            pass.end();
            pass = null;
            if (occlusion) {
              const size = occlusion.count * 8;
              occlusion.resolved = this.device.createBuffer({
                size,
                usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
              });
              occlusion.results = this.device.createBuffer({
                size,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
              });
              encoder.resolveQuerySet(
                occlusion.querySet, 0, occlusion.count, occlusion.resolved, 0
              );
              encoder.copyBufferToBuffer(
                occlusion.resolved, 0, occlusion.results, 0, size
              );
              occlusion = null;
            }
            break;
          case 32:
            pass.beginOcclusionQuery(command.query);
            occlusion.used[command.query] = 1;
            break;
          case 33:
            pass.endOcclusionQuery();
            break;
          case 22:
            encoder ||= this.device.createCommandEncoder();
            encoder.copyBufferToBuffer(
              resource(next, command.source, "buffer", command.index).value,
              command.sourceOffset,
              resource(next, command.destination, "buffer", command.index)
                .value,
              command.destinationOffset,
              command.size
            );
            break;
          case 23:
            entry.value = resource(
              next,
              command.texture,
              "texture",
              command.index
            ).value.createView({
              // Derive the aspect-specific format from the validated backing texture.
              dimension: command.dimension,
              aspect: command.aspect,
              baseMipLevel: command.baseMipLevel,
              mipLevelCount: command.mipLevelCount,
              baseArrayLayer: command.baseArrayLayer,
              ...(command.dimension === "3d"
                ? {}
                : { arrayLayerCount: command.arrayLayerCount }),
            });
            next.set(command.id, entry);
            created.push(entry);
            break;
          case 24:
            entry.value = this.device.createComputePipeline({
              layout: resource(
                next,
                command.layout,
                "pipelineLayout",
                command.index
              ).value,
              compute: {
                module: resource(next, command.shader, "shader", command.index)
                  .value,
                entryPoint: "cs_main",
              },
            });
            next.set(command.id, entry);
            created.push(entry);
            break;
          case 25:
            encoder ||= this.device.createCommandEncoder();
            pass = encoder.beginComputePass();
            break;
          case 26:
            pass.setPipeline(
              resource(next, command.id, "computePipeline", command.index).value
            );
            break;
          case 27:
            pass.setBindGroup(
              command.bindIndex,
              resource(next, command.bindGroup, "bindGroup", command.index)
                .value,
              command.dynamicOffsets
            );
            break;
          case 28:
            pass.dispatchWorkgroups(...command.values);
            break;
          case 29:
            pass.end();
            pass = null;
            break;
          case 30:
            pass.setStencilReference(command.reference);
            break;
          case 31:
            pass.setBlendConstant(command.color);
            break;
        }
      }
      if (encoder && surfaceTexture && this.testReadbacksRemaining > 0) {
        readback = this.device.createBuffer({
          size: 3 * 256,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const sampleLocations = [
          [this.physicalWidth >> 1, this.physicalHeight >> 1],
          [
            Math.min(8, this.physicalWidth - 1),
            Math.min(8, this.physicalHeight - 1),
          ],
          [Math.max(0, this.physicalWidth - 20), this.physicalHeight >> 1],
        ];
        for (const [index, [x, y]] of sampleLocations.entries()) {
          encoder.copyTextureToBuffer(
            { texture: surfaceTexture, origin: { x, y } },
            {
              buffer: readback,
              offset: index * 256,
              bytesPerRow: 256,
              rowsPerImage: 1,
            },
            { width: 1, height: 1, depthOrArrayLayers: 1 }
          );
        }
      }
      if (encoder) {
        this.device.queue.submit([encoder.finish()]);
      }
    } catch (error) {
      created.forEach(entry => entry.value?.destroy?.());
      readback?.destroy();
      destroyOcclusionReadbacks(occlusionReadbacks, this.occlusionReadbacks);
      await Promise.allSettled([device.popErrorScope(), device.popErrorScope()]);
      throw error;
    }
    let outOfMemory;
    let validation;
    try {
      [outOfMemory, validation] = await Promise.all([
        device.popErrorScope(),
        device.popErrorScope(),
      ]);
    } catch (error) {
      readback?.destroy();
      destroyOcclusionReadbacks(occlusionReadbacks, this.occlusionReadbacks);
      created.forEach(entry => entry.value?.destroy?.());
      if (this.stopped || this.device !== device || epoch !== this.occlusionEpoch) return;
      throw error;
    }
    if (this.stopped || this.device !== device || epoch !== this.occlusionEpoch) {
      readback?.destroy();
      destroyOcclusionReadbacks(occlusionReadbacks, this.occlusionReadbacks);
      created.forEach(entry => entry.value?.destroy?.());
      return;
    }
    const gpuError = outOfMemory || validation;
    if (gpuError) {
      readback?.destroy();
      destroyOcclusionReadbacks(occlusionReadbacks, this.occlusionReadbacks);
      created.forEach(entry => entry.value?.destroy?.());
      this.emitBatchRejected(
        0xffffffff,
        outOfMemory ? 2 : 1,
        batch.sequence,
        gpuError.message
      );
      return;
    }
    this.resources = next;
    this.handleSlots = validated.slots;
    this.lastSequence = batch.sequence;
    if (backgrounded && surfaceTexture === this.backgroundTexture) {
      this.backgroundTextureValid = surfaceStored;
      this.backgroundTextureSequence = batch.sequence;
    }
    removed.forEach(entry => entry.value?.destroy?.());
    shaders.forEach(([entry, handle]) =>
      this.watchShader(entry, handle, batch.sequence)
    );
    if (readback) {
      try {
        await readback.mapAsync(GPUMapMode.READ);
      } catch (error) {
        readback.destroy();
        destroyOcclusionReadbacks(occlusionReadbacks, this.occlusionReadbacks);
        if (this.stopped || this.device !== device || epoch !== this.occlusionEpoch) return;
        throw error;
      }
      if (this.stopped || this.device !== device || epoch !== this.occlusionEpoch) {
        readback.destroy();
        destroyOcclusionReadbacks(occlusionReadbacks, this.occlusionReadbacks);
        return;
      }
      const readbackBytes = new Uint8Array(readback.getMappedRange());
      const samples = [0, 256, 512].map(offset =>
        Array.from(readbackBytes.subarray(offset, offset + 4))
      );
      readback.unmap();
      readback.destroy();
      this.testReadbacksRemaining--;
      postMessage({ type: "test-readback", samples });
    }
    postBytes("event", makeEvent(5, batch.sequence));
    this.deliverOcclusionResults(batch.sequence, occlusionReadbacks);
    if (surfaceStored && !backgrounded && !this.backgrounded) {
      postMessage({ type: "presented", sequence: batch.sequence });
    }
    if (this.testDeviceLossPending && surfaceTexture) {
      this.testDeviceLossPending = false;
      this.device.destroy();
    }
  }

  /**
   * Maps each pass's resolved results after the batch completion event and
   * posts them in submission order without delaying later batches. Results
   * of a reset, stopped or lost device are dropped.
   */
  deliverOcclusionResults(sequence, readbacks) {
    if (!readbacks.length) {
      return;
    }
    const epoch = this.occlusionEpoch;
    for (const entry of readbacks) {
      entry.querySet.destroy();
      entry.resolved.destroy();
    }
    this.occlusionDelivery = this.occlusionDelivery.then(async () => {
      for (const entry of readbacks) {
        const { token, count, results } = entry;
        try {
          if (epoch !== this.occlusionEpoch) continue;
          await results.mapAsync(GPUMapMode.READ);
          if (epoch === this.occlusionEpoch) {
            const payload = new Uint8Array(8 + count * 8);
            const view = new DataView(payload.buffer);
            view.setUint32(0, token, true);
            view.setUint32(4, count, true);
            payload.set(new Uint8Array(results.getMappedRange()), 8);
            postBytes("event", makeEvent(9, sequence, payload));
          }
        } catch {
          // A lost or destroyed device abandons its in-flight results.
        } finally {
          results.destroy();
          this.occlusionReadbacks.delete(entry);
        }
      }
    });
  }

  abandonOcclusionResults() {
    this.occlusionEpoch++;
    destroyOcclusionReadbacks(this.occlusionReadbacks, this.occlusionReadbacks);
    // A lost map must not hold up results produced by the replacement device.
    this.occlusionDelivery = Promise.resolve();
  }

  async watchShader(entry, handle, sequence) {
    const epoch = this.occlusionEpoch;
    try {
      const info = await entry.value.getCompilationInfo();
      if (this.stopped || epoch !== this.occlusionEpoch) return;
      for (const message of info.messages) {
        let severity = 3;
        if (message.type === "error") {
          severity = 1;
        } else if (message.type === "warning") {
          severity = 2;
        }
        const text = diagnosticBytes(message.message || "shader diagnostic");
        const payload = new Uint8Array(32 + align4(text.bytes.byteLength));
        const view = new DataView(payload.buffer);
        view.setUint32(0, handle, true);
        view.setUint16(4, severity, true);
        view.setUint16(6, text.truncated ? 1 : 0, true);
        view.setUint32(8, message.lineNum || 0, true);
        view.setUint32(12, message.linePos || 0, true);
        view.setUint32(16, message.offset || 0, true);
        view.setUint32(20, message.length || 0, true);
        view.setUint32(24, text.bytes.byteLength, true);
        payload.set(text.bytes, 32);
        postBytes("event", makeEvent(2, sequence, payload));
        if (severity === 1) {
          entry.failed = true;
        }
      }
    } catch {}
  }

  emitBatchRejected(commandIndex, errorCode, sequence, message) {
    const diagnostic = diagnosticBytes(
      `surface_generation=${this.surfaceGeneration} ` +
        `physical=${this.physicalWidth}x${this.physicalHeight} ` +
        `logical=${this.logicalWidth}x${this.logicalHeight} ` +
        `scale=${this.scale} last_sequence=${this.lastSequence}: ${message}`
    );
    const payload = new Uint8Array(16 + align4(diagnostic.bytes.byteLength));
    const view = new DataView(payload.buffer);
    view.setUint32(0, commandIndex, true);
    view.setUint32(4, errorCode, true);
    view.setUint32(8, diagnostic.bytes.byteLength, true);
    view.setUint32(12, diagnostic.truncated ? 1 : 0, true);
    payload.set(diagnostic.bytes, 16);
    postBytes("event", makeEvent(1, sequence, payload));
  }

  emitTextEvent(type, sequence, errorCode, message) {
    const text = diagnosticBytes(message);
    const payload = new Uint8Array(12 + align4(text.bytes.byteLength));
    const view = new DataView(payload.buffer);
    view.setUint32(0, errorCode, true);
    view.setUint32(4, text.bytes.byteLength, true);
    view.setUint32(8, text.truncated ? 1 : 0, true);
    payload.set(text.bytes, 12);
    postBytes("event", makeEvent(type, sequence, payload));
  }

  reset() {
    const device = this.device;
    this.queue = this.queue
      .then(() => {
        if (this.stopped || this.device !== device) {
          return;
        }
        for (const entry of this.resources.values()) {
          entry.value?.destroy?.();
        }
        this.resources.clear();
        this.handleSlots.clear();
        this.destroyBackgroundTexture();
        this.abandonOcclusionResults();
        this.pendingResize = null;
        this.lastSequence = 0;
      })
      .catch(error => {
        if (this.device !== device || this.disposed) return;
        postMessage({ type: "error", message: error.message || String(error) });
        this.stopped = true;
        this.abandonOcclusionResults();
      });
  }

  stop() {
    this.stopped = true;
    this.disposed = true;
    this.abandonOcclusionResults();
    for (const entry of this.resources.values()) {
      entry.value?.destroy?.();
    }
    this.destroyBackgroundTexture();
    this.pendingResize = null;
    this.resources.clear();
    this.handleSlots.clear();
    this.device.destroy();
  }
}

function destroyOcclusionReadbacks(readbacks, pending) {
  for (const entry of readbacks) {
    entry.querySet.destroy();
    entry.resolved?.destroy();
    entry.results?.destroy();
    pending.delete(entry);
  }
}

function align4(value) {
  return (value + 3) & ~3;
}

function diagnosticBytes(message) {
  const encoded = textEncoder.encode(String(message));
  if (encoded.byteLength <= MAX_DIAGNOSTIC_BYTES) {
    return { bytes: encoded, truncated: false };
  }
  let end = MAX_DIAGNOSTIC_BYTES;
  while (end > 0) {
    try {
      textDecoder.decode(encoded.subarray(0, end));
      break;
    } catch {
      end--;
    }
  }
  return { bytes: encoded.slice(0, end), truncated: true };
}

function makeEvent(type, sequence, payload = new Uint8Array()) {
  const bytes = new Uint8Array(EVENT_HEADER_BYTES + payload.byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set(textEncoder.encode("EGE1"), 0);
  view.setUint16(4, WIRE_VERSION, true);
  view.setUint16(6, type, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setBigUint64(16, BigInt(sequence), true);
  bytes.set(payload, EVENT_HEADER_BYTES);
  return bytes;
}

function postBytes(type, bytes) {
  postMessage({ type, bytes }, [bytes.buffer]);
}

let engine = null;
let backgrounded = false;

onmessage = event => {
  const message = event.data;
  if (message?.type === "init" && !engine) {
    void GpuEngine.create(
      message.canvas,
      message.requirements || {},
      message.dimensions,
      message.testReadback === true,
      message.testDeviceLoss === true
    )
      .then(created => {
        engine = created;
        engine.setBackground(backgrounded);
        postBytes("capabilities", engine.capabilities());
      })
      .catch(error =>
        postMessage({ type: "error", message: error.message || String(error) })
      );
  } else if (message?.type === "batch" && engine) {
    engine.submit(new Uint8Array(message.bytes));
  } else if (message?.type === "resize" && engine) {
    engine.scheduleResize(message.dimensions);
  } else if (message?.type === "background") {
    backgrounded = message.backgrounded === true;
    engine?.setBackground(backgrounded);
  } else if (message?.type === "reset" && engine) {
    engine.reset();
  } else if (message?.type === "stop" && engine) {
    engine.stop();
    engine = null;
  }
};
