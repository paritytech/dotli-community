/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

(() => {
  const STATUS_FINISHED = -1;
  const STATUS_ECALL = -2;
  const STATUS_TRAP = -3;
  const STATUS_OUT_OF_GAS = -4;
  const CORE_STATUS_INVALID = -3;
  const CORE_STATUS_DENIED = -5;
  const CORE_STATUS_LIMIT = -6;
  const INPUT_EVENT_BYTES = 8;
  const MOTION_SAMPLE_BYTES = 48;
  const MOTION_STATUS_UNAVAILABLE = 0;
  const MOTION_STATUS_AVAILABLE = 1;
  const MOTION_STATUS_PERMISSION_DENIED = 2;
  const MOTION_ERROR_UNAVAILABLE = -1;
  const MOTION_ERROR_PERMISSION_DENIED = -2;
  const MOTION_ERROR_INVALID_GUEST_RANGE = -3;
  const MOTION_ERROR_BUFFER_TOO_SMALL = -4;
  const MAX_MEDIATED_INPUT_KIND_BYTES = 32;
  const MAX_MEDIATED_INPUT_MEDIA_TYPE_BYTES = 64;
  const MAX_MEDIATED_INPUT_BYTES = 1024 * 1024;
  const MAX_MEDIATED_INPUT_REGISTRATIONS = 8;
  const MAX_MEDIATED_INPUT_COMMANDS = 2 * MAX_MEDIATED_INPUT_REGISTRATIONS;
  const MEDIATED_INPUT_STATUS_REGISTERED = 1;
  const MEDIATED_INPUT_STATUS_ACTIVE = 2;
  const MEDIATED_INPUT_STATUS_READY = 3;
  const MEDIATED_INPUT_STATUS_CANCELLED = 4;
  const MEDIATED_INPUT_STATUS_PERMISSION_DENIED = 5;
  const MEDIATED_INPUT_STATUS_FAILED = 6;
  const MAX_FILE_DESCRIPTOR_BYTES = 4 * 1024;
  const MAX_FILE_ID_BYTES = 64;
  const MAX_FILE_LABEL_BYTES = 80;
  const MAX_FILE_EXTENSIONS = 16;
  const MAX_FILE_MIME_TYPES = 16;
  const MAX_FILE_MIME_TYPE_BYTES = 127;
  const MAX_FILE_MOUNT_PATH_BYTES = 1024;
  const MAX_FILE_NAME_BYTES = 1024;
  const MAX_INLINE_FILE_BYTES = 8 * 1024 * 1024;
  const MAX_RELAUNCH_FILE_BYTES = 128 * 1024 * 1024;
  const MAX_STREAM_FILE_BYTES = 0xffffffff;
  const MAX_FILE_READ_BYTES = 65536;
  const MAX_FILE_CACHE_BYTES = 512 * 1024 * 1024;
  const MAX_ASSET_FILES = 2048;
  const MAX_ASSET_BYTES = 256 * 1024 * 1024;
  const FILE_REGISTER_DELIVERY_UNAVAILABLE = -4;
  const FILE_INFO_INVALID = -1;
  const JSON_ESCAPES = Object.freeze({
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
  });
  const FILE_DESCRIPTOR_FIELDS = new Set([
    "id",
    "label",
    "extensions",
    "mimeTypes",
    "delivery",
    "maxBytes",
    "mountPath",
  ]);
  const INPUT_POINTER_CAPTURE = 15;
  const INPUT_SAFE_AREA_INSETS = 16;
  const INPUT_KEYBOARD_INSETS = 17;
  const INPUT_INSETS_HORIZONTAL = 0;
  const INPUT_INSETS_VERTICAL = 1;
  const POINTER_CAPTURE_IMPORT = "host_pointer_capture";
  const UPDATE_AFTER_IMPORT = "host_update_after";
  const POINTER_CAPTURE_RELEASE = 0;
  const POINTER_CAPTURE_ARM = 1;
  const POINTER_CAPTURE_RELEASED = 0;
  const POINTER_CAPTURE_ARMED = 1;
  const POINTER_CAPTURE_ACTIVE = 2;
  const POINTER_CAPTURE_UNSUPPORTED = -1;
  const POINTER_CAPTURE_INVALID_REQUEST = -2;
  const MAX_INPUT_EVENTS = 4096;
  const MAX_HOSTCALLS_PER_INIT = 1024 * 1024;
  const MAX_HOSTCALLS_PER_UPDATE = 65536;
  const MAX_HOSTCALL_BYTES = 32 * 1024 * 1024;
  const MAX_CORE_RANDOM_BYTES = 4 * 1024;
  const MAX_LOG_BYTES = 4 * 1024;
  const MAX_SAVE_BYTES = 1024 * 1024;
  const MAX_RANDOM_BYTES_PER_CALL = 4 * 1024;
  const RANDOM_BYTES_PER_EXECUTION = 64 * 1024;
  const MAX_AUDIO_SAMPLES = 48000 * 2;
  const MAX_FRAME_BYTES = 16 * 1024 * 1024;
  const MAX_TRI2D_BYTES = 8 * 1024 * 1024;
  const MAX_UI_SEMANTICS_BYTES = 256 * 1024;
  const MAX_UI_SEMANTIC_NODES = 1024;
  const MAX_UI_SEMANTIC_STRING_BYTES = 1024;
  const UI_OUTPUT_HEADER_BYTES = 48;
  const UI_OUTPUT_COMMAND_HEADER_BYTES = 8;
  const MAX_UI_COPY_IMAGE_BYTES = 4 * 1024 * 1024;
  const MAX_UI_OUTPUT_BYTES = MAX_UI_COPY_IMAGE_BYTES + 256 * 1024;
  const MAX_UI_OUTPUT_COMMANDS = 64;
  const MAX_UI_COPY_TEXT_BYTES = 64 * 1024;
  const MAX_UI_COPY_IMAGE_PIXELS = 1024 * 1024;
  const MAX_UI_COPY_IMAGE_DIMENSION = 2048;
  const MAX_UI_OPEN_URL_BYTES = 8 * 1024;
  const UI_CURSOR_ICONS = Object.freeze([
    "default",
    "none",
    "context-menu",
    "help",
    "pointer",
    "progress",
    "wait",
    "cell",
    "crosshair",
    "text",
    "vertical-text",
    "alias",
    "copy",
    "move",
    "no-drop",
    "not-allowed",
    "grab",
    "grabbing",
    "all-scroll",
    "ew-resize",
    "nesw-resize",
    "nwse-resize",
    "ns-resize",
    "e-resize",
    "se-resize",
    "s-resize",
    "sw-resize",
    "w-resize",
    "nw-resize",
    "n-resize",
    "ne-resize",
    "col-resize",
    "row-resize",
    "zoom-in",
    "zoom-out",
  ]);
  const MAX_GPU_BATCH_BYTES = 4 * 1024 * 1024;
  const MAX_GPU_EVENT_BYTES = 64 * 1024;
  const MAX_GPU_EVENTS = 256;
  const MAX_GPU_SUBMITS_PER_UPDATE = 8;
  const MAX_HOST_FRAME_BYTES = 1024 * 1024;
  const MAX_HOST_FRAMES = 32;
  const MAX_QUEUED_HOST_FRAME_BYTES = 4 * 1024 * 1024;
  const MAX_GPU_COMMANDS = 16_384;
  const GPU_ERROR_MALFORMED_BATCH = -2;
  const GPU_ERROR_QUOTA_EXCEEDED = -3;
  const GPU_ERROR_INVALID_STATE = -5;
  const IOV_MAX = 1024n;
  const AT_FDCWD = BigInt.asUintN(64, -100n);
  const ENOSYS = 38;
  const EFAULT = 14;
  const ENOENT = 2;
  const EBADF = 9;
  const EACCES = 13;
  const EINVAL = 22;
  const SYS_OPENAT = 56n;
  const SYS_CLOSE = 57n;
  const SYS_LSEEK = 62n;
  const SYS_READ = 63n;
  const SYS_READV = 65n;
  const SYS_WRITEV = 66n;
  const SYS_EXIT = 93n;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const strictDecoder = new TextDecoder("utf-8", { fatal: true });
  const descriptorDecoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  });

  function executionRandomBytes() {
    const bytes = new Uint8Array(RANDOM_BYTES_PER_EXECUTION);
    const browserCrypto = globalThis.crypto;
    if (typeof browserCrypto?.getRandomValues !== "function") {
      return new Uint8Array();
    }
    try {
      browserCrypto.getRandomValues(bytes);
      return bytes;
    } catch {
      return new Uint8Array();
    }
  }

  function isWebGpuProfile(profile) {
    return profile === "webgpu-raster" || profile === "webgpu";
  }

  function validMediatedInputToken(value, maxBytes) {
    const bytes = encoder.encode(value);
    return (
      bytes.byteLength > 0 &&
      bytes.byteLength <= maxBytes &&
      /^[a-z0-9][a-z0-9+._-]*[a-z0-9]$|^[a-z0-9]$/.test(value)
    );
  }

  /**
   * Parses JSON with the strictness of the native runtime: duplicate keys,
   * lone surrogates, and numbers other than non-negative integers are errors.
   */
  function parseStrictJson(text) {
    let index = 0;
    const fail = () => {
      throw new SyntaxError("invalid strict JSON");
    };
    const skipWhitespace = () => {
      while (/[ \t\n\r]/.test(text[index] ?? "")) {
        index++;
      }
    };
    const parseString = () => {
      if (text[index] !== '"') {
        fail();
      }
      index++;
      let value = "";
      while (true) {
        const character = text[index++];
        if (character === undefined || character < " ") {
          fail();
        }
        if (character === '"') {
          break;
        }
        if (character !== "\\") {
          value += character;
          continue;
        }
        const escape = text[index++];
        if (Object.hasOwn(JSON_ESCAPES, escape)) {
          value += JSON_ESCAPES[escape];
          continue;
        }
        if (escape !== "u") {
          fail();
        }
        const hex = text.slice(index, index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          fail();
        }
        index += 4;
        value += String.fromCharCode(Number.parseInt(hex, 16));
      }
      if (!value.isWellFormed()) {
        fail();
      }
      return value;
    };
    const parseValue = () => {
      skipWhitespace();
      const character = text[index];
      if (character === "{") {
        index++;
        const object = Object.create(null);
        skipWhitespace();
        if (text[index] === "}") {
          index++;
          return object;
        }
        while (true) {
          skipWhitespace();
          const key = parseString();
          if (Object.hasOwn(object, key)) {
            fail();
          }
          skipWhitespace();
          if (text[index++] !== ":") {
            fail();
          }
          object[key] = parseValue();
          skipWhitespace();
          const separator = text[index++];
          if (separator === "}") {
            return object;
          }
          if (separator !== ",") {
            fail();
          }
        }
      }
      if (character === "[") {
        index++;
        const array = [];
        skipWhitespace();
        if (text[index] === "]") {
          index++;
          return array;
        }
        while (true) {
          array.push(parseValue());
          skipWhitespace();
          const separator = text[index++];
          if (separator === "]") {
            return array;
          }
          if (separator !== ",") {
            fail();
          }
        }
      }
      if (character === '"') {
        return parseString();
      }
      for (const [literal, value] of [
        ["true", true],
        ["false", false],
        ["null", null],
      ]) {
        if (text.startsWith(literal, index)) {
          index += literal.length;
          return value;
        }
      }
      const number = /^(0|[1-9][0-9]*)(?![0-9.eE+-])/.exec(text.slice(index));
      if (number === null) {
        fail();
      }
      index += number[0].length;
      return Number(number[0]);
    };
    const value = parseValue();
    skipWhitespace();
    if (index !== text.length) {
      fail();
    }
    return value;
  }

  function byteLength(value) {
    return encoder.encode(value).byteLength;
  }

  function validFileId(value) {
    return (
      typeof value === "string" &&
      value.length <= MAX_FILE_ID_BYTES &&
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value)
    );
  }

  function validFileLabel(value) {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      byteLength(value) <= MAX_FILE_LABEL_BYTES
    );
  }

  function validFileExtension(value) {
    return typeof value === "string" && /^\.[a-z0-9]{1,16}$/.test(value);
  }

  function validFileMimeType(value) {
    return (
      typeof value === "string" &&
      value.length <= MAX_FILE_MIME_TYPE_BYTES &&
      /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value)
    );
  }

  function validFileMountPath(value) {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      byteLength(value) <= MAX_FILE_MOUNT_PATH_BYTES &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(value) &&
      value
        .split("/")
        .every((segment) => segment && segment !== "." && segment !== "..")
    );
  }

  function uniqueWithin(values, limit, valid) {
    return (
      Array.isArray(values) &&
      values.length <= limit &&
      values.every(valid) &&
      new Set(values).size === values.length
    );
  }

  function validFileTypeFilter(label, extensions, mimeTypes) {
    return (
      validFileLabel(label) &&
      uniqueWithin(extensions, MAX_FILE_EXTENSIONS, validFileExtension) &&
      uniqueWithin(mimeTypes, MAX_FILE_MIME_TYPES, validFileMimeType) &&
      (extensions.length > 0 || mimeTypes.length > 0)
    );
  }

  /** Parses one `host_file_register` descriptor, or returns null. */
  function parseFileDescriptor(bytes) {
    if (bytes.byteLength > MAX_FILE_DESCRIPTOR_BYTES) {
      return null;
    }
    let raw;
    try {
      raw = parseStrictJson(descriptorDecoder.decode(bytes));
    } catch {
      return null;
    }
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).some((key) => !FILE_DESCRIPTOR_FIELDS.has(key))
    ) {
      return null;
    }
    const extensions = raw.extensions ?? [];
    const mimeTypes = raw.mimeTypes ?? [];
    const { id, label, delivery, maxBytes, mountPath } = raw;
    if (
      (Object.hasOwn(raw, "extensions") && !Array.isArray(raw.extensions)) ||
      (Object.hasOwn(raw, "mimeTypes") && !Array.isArray(raw.mimeTypes))
    ) {
      return null;
    }
    const bound =
      delivery === "inline"
        ? MAX_INLINE_FILE_BYTES
        : delivery === "relaunch"
          ? MAX_RELAUNCH_FILE_BYTES
          : delivery === "stream"
            ? MAX_STREAM_FILE_BYTES
            : 0;
    const mountPathValid =
      delivery === "inline" || delivery === "stream"
        ? !Object.hasOwn(raw, "mountPath")
        : validFileMountPath(mountPath);
    if (
      !validFileId(id) ||
      !validFileTypeFilter(label, extensions, mimeTypes) ||
      !Number.isInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > bound ||
      !mountPathValid
    ) {
      return null;
    }
    const descriptor = { id, label, extensions, mimeTypes, delivery, maxBytes };
    if (delivery === "relaunch") {
      descriptor.mountPath = mountPath;
    }
    return descriptor;
  }

  function sameFileDescriptor(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  /** Reduces a Host-received name to the base name the guest may see. */
  function sanitizeFileName(name) {
    if (typeof name !== "string") {
      throw new Error("file name must be a string");
    }
    const base = name.toWellFormed().split(/[/\\]/).at(-1);
    const sanitized = base.replace(/[\u0000-\u001f\u007f-\u009f]/g, "�");
    if (!sanitized || byteLength(sanitized) > MAX_FILE_NAME_BYTES) {
      throw new Error(`file name must reduce to 1..=${MAX_FILE_NAME_BYTES} bytes`);
    }
    return sanitized;
  }

  function validateSelectedMimeType(mimeType) {
    if (
      typeof mimeType !== "string" ||
      (mimeType !== "" && !validFileMimeType(mimeType))
    ) {
      throw new Error(`invalid file MIME type ${mimeType}`);
    }
  }

  function encodeFileInfo(file) {
    return encoder.encode(
      JSON.stringify({ name: file.name, mimeType: file.mimeType, size: file.size }),
    );
  }

  function isComputeOpcode(opcode) {
    return opcode >= 24 && opcode <= 29;
  }

  function validUiSemantics(bytes) {
    let snapshot;
    try {
      snapshot = JSON.parse(decoder.decode(bytes));
    } catch {
      return false;
    }
    if (
      snapshot?.version !== 1 ||
      !Number.isSafeInteger(snapshot.generation) ||
      snapshot.generation < 0 ||
      !Array.isArray(snapshot.nodes) ||
      !snapshot.nodes.length ||
      snapshot.nodes.length > MAX_UI_SEMANTIC_NODES
    ) {
      return false;
    }
    const ids = new Set();
    let roots = 0;
    for (const node of snapshot.nodes) {
      if (
        typeof node?.id !== "string" ||
        !/^[0-9a-f]{1,16}$/.test(node.id) ||
        ids.has(node.id) ||
        !Array.isArray(node.bounds) ||
        node.bounds.length !== 4 ||
        !node.bounds.every(Number.isFinite) ||
        node.bounds[2] < node.bounds[0] ||
        node.bounds[3] < node.bounds[1] ||
        typeof node.name !== "string" ||
        encoder.encode(node.name).byteLength > MAX_UI_SEMANTIC_STRING_BYTES ||
        typeof node.value !== "string" ||
        encoder.encode(node.value).byteLength > MAX_UI_SEMANTIC_STRING_BYTES
      ) {
        return false;
      }
      ids.add(node.id);
      if (node.parent === null) {
        roots++;
      }
    }
    return (
      roots === 1 &&
      snapshot.nodes.every(
        (node) => node.parent === null || ids.has(node.parent),
      )
    );
  }

  function decodeUiOutput(bytes) {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < UI_OUTPUT_HEADER_BYTES ||
      bytes.byteLength > MAX_UI_OUTPUT_BYTES
    ) {
      return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      bytes[0] !== 0x50 ||
      bytes[1] !== 0x55 ||
      bytes[2] !== 0x49 ||
      bytes[3] !== 0x31 ||
      view.getUint16(4, true) !== 1 ||
      view.getUint16(6, true) !== UI_OUTPUT_HEADER_BYTES ||
      view.getUint32(8, true) !== bytes.byteLength
    ) {
      return null;
    }
    const commandCount = view.getUint16(12, true);
    const cursorIcon = UI_CURSOR_ICONS[bytes[14]];
    const flags = bytes[15];
    if (
      commandCount > MAX_UI_OUTPUT_COMMANDS ||
      cursorIcon === undefined ||
      (flags & ~3) !== 0
    ) {
      return null;
    }
    const readRect = (offset) => [
      view.getFloat32(offset, true),
      view.getFloat32(offset + 4, true),
      view.getFloat32(offset + 8, true),
      view.getFloat32(offset + 12, true),
    ];
    const validRect = (rect) =>
      rect.every(Number.isFinite) && rect[2] >= rect[0] && rect[3] >= rect[1];
    let ime = null;
    if (flags & 2) {
      const rect = readRect(16);
      const cursorRect = readRect(32);
      if (!validRect(rect) || !validRect(cursorRect)) {
        return null;
      }
      ime = { rect, cursorRect };
    } else if (
      bytes.subarray(16, UI_OUTPUT_HEADER_BYTES).some((byte) => byte)
    ) {
      return null;
    }

    const commands = [];
    let offset = UI_OUTPUT_HEADER_BYTES;
    try {
      for (let index = 0; index < commandCount; index++) {
        if (offset + UI_OUTPUT_COMMAND_HEADER_BYTES > bytes.byteLength) {
          return null;
        }
        const opcode = bytes[offset];
        const commandFlags = bytes[offset + 1];
        if (bytes[offset + 2] !== 0 || bytes[offset + 3] !== 0) {
          return null;
        }
        const payloadLength = view.getUint32(offset + 4, true);
        const payloadStart = offset + UI_OUTPUT_COMMAND_HEADER_BYTES;
        const payloadEnd = payloadStart + payloadLength;
        if (payloadEnd > bytes.byteLength) {
          return null;
        }
        const payloadBytes = bytes.subarray(payloadStart, payloadEnd);
        if (opcode === 1) {
          if (commandFlags !== 0 || payloadLength > MAX_UI_COPY_TEXT_BYTES) {
            return null;
          }
          commands.push({
            type: "copy-text",
            text: strictDecoder.decode(payloadBytes),
          });
        } else if (opcode === 2) {
          if (
            (commandFlags & ~1) !== 0 ||
            payloadLength === 0 ||
            payloadLength > MAX_UI_OPEN_URL_BYTES
          ) {
            return null;
          }
          commands.push({
            type: "open-url",
            url: strictDecoder.decode(payloadBytes),
            newSurface: (commandFlags & 1) !== 0,
          });
        } else if (opcode === 3) {
          if (commandFlags !== 0 || payloadLength < 8) {
            return null;
          }
          const payloadView = new DataView(
            bytes.buffer,
            bytes.byteOffset + payloadStart,
            payloadLength,
          );
          const width = payloadView.getUint32(0, true);
          const height = payloadView.getUint32(4, true);
          const pixelBytes = payloadLength - 8;
          if (
            width === 0 ||
            height === 0 ||
            width > MAX_UI_COPY_IMAGE_DIMENSION ||
            height > MAX_UI_COPY_IMAGE_DIMENSION ||
            width * height > MAX_UI_COPY_IMAGE_PIXELS ||
            width * height * 4 !== pixelBytes
          ) {
            return null;
          }
          commands.push({
            type: "copy-image",
            width,
            height,
            rgba: payloadBytes.subarray(8),
          });
        } else {
          return null;
        }
        offset = payloadEnd;
      }
    } catch {
      return null;
    }
    if (offset !== bytes.byteLength) {
      return null;
    }
    return {
      cursorIcon,
      mutableTextUnderCursor: (flags & 1) !== 0,
      ime,
      commands,
    };
  }

  function readMetadata(module) {
    const sections = WebAssembly.Module.customSections(
      module,
      "epoca.pvm.meta",
    );
    if (sections.length !== 1) {
      throw new Error("translated PolkaVM module has invalid metadata");
    }
    const bytes = new Uint8Array(sections[0]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const requireBytes = (length) => {
      if (offset + length > bytes.byteLength) {
        throw new Error("translated PolkaVM metadata is truncated");
      }
    };
    const readU16 = () => {
      requireBytes(2);
      const value = view.getUint16(offset, true);
      offset += 2;
      return value;
    };
    const readU32 = () => {
      requireBytes(4);
      const value = view.getUint32(offset, true);
      offset += 4;
      return value;
    };
    const readString = (length) => {
      requireBytes(length);
      const value = decoder.decode(bytes.subarray(offset, offset + length));
      offset += length;
      return value;
    };
    requireBytes(4);
    if (decoder.decode(bytes.subarray(0, 4)) !== "EPM2") {
      throw new Error("translated PolkaVM metadata has an incompatible ABI");
    }
    offset = 4;
    const is64Bit = readU32() !== 0;
    const names = [
      "roAddress",
      "roSize",
      "roPhysical",
      "rwAddress",
      "rwSize",
      "rwPhysical",
      "heapBase",
      "heapLimit",
      "stackLow",
      "stackHigh",
      "stackPhysical",
    ];
    const layout = {};
    for (const name of names) {
      layout[name] = readU32();
    }
    const imports = [];
    const importCount = readU32();
    for (let index = 0; index < importCount; index++) {
      const length = readU16();
      imports.push(length ? readString(length) : null);
    }
    const exports = new Map();
    const exportCount = readU32();
    for (let index = 0; index < exportCount; index++) {
      const name = readString(readU16());
      const block = readU32();
      if (!name || exports.has(name)) {
        throw new Error("translated PolkaVM metadata has invalid exports");
      }
      exports.set(name, block);
    }
    if (offset !== bytes.byteLength) {
      throw new Error("translated PolkaVM metadata has trailing data");
    }
    return { is64Bit, layout, imports, exports };
  }

  function errno(code) {
    return BigInt.asUintN(64, -BigInt(code));
  }

  function normalizedPath(path) {
    while (path.startsWith("./")) {
      path = path.slice(2);
    }
    return path.replace(/^\/+/, "");
  }

  function hidToCoreVm(code) {
    if (code >= 0x04 && code <= 0x1d) {
      return 0x61 + code - 0x04;
    }
    if (code >= 0x1e && code <= 0x26) {
      return 0x31 + code - 0x1e;
    }
    const keys = new Map([
      [0x27, 0x30],
      [0x28, 0x0a],
      [0x58, 0x0a],
      [0x29, 0x1b],
      [0x2a, 0x08],
      [0x2b, 0x09],
      [0x2c, 0x20],
      [0x2d, 0x2d],
      [0x56, 0x2d],
      [0x2e, 0x3d],
      [0x2f, 0x5b],
      [0x30, 0x5d],
      [0x31, 0x5c],
      [0x33, 0x3b],
      [0x34, 0x27],
      [0x35, 0x60],
      [0x36, 0x2c],
      [0x37, 0x2e],
      [0x63, 0x2e],
      [0x38, 0x2f],
      [0x54, 0x2f],
      [0x46, 0x91],
      [0x47, 0x92],
      [0x48, 0x93],
      [0x49, 0x94],
      [0x4a, 0x96],
      [0x4b, 0x98],
      [0x4c, 0x95],
      [0x4d, 0x97],
      [0x4e, 0x99],
      [0x4f, 0x82],
      [0x50, 0x83],
      [0x51, 0x81],
      [0x52, 0x80],
      [0x55, 0x2a],
      [0x57, 0x2b],
      [0x59, 0x97],
      [0x5a, 0x81],
      [0x5b, 0x99],
      [0x5c, 0x83],
      [0x5d, 0x35],
      [0x5e, 0x82],
      [0x5f, 0x96],
      [0x60, 0x80],
      [0x61, 0x98],
      [0x62, 0x2e],
      [0xe0, 0x9c],
      [0xe1, 0x9a],
      [0xe2, 0x9e],
      [0xe4, 0x9d],
      [0xe5, 0x9b],
      [0xe6, 0x9f],
    ]);
    if (code >= 0x3a && code <= 0x45) {
      return 0x84 + code - 0x3a;
    }
    return keys.get(code);
  }

  function validMotionSample(bytes) {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength !== MOTION_SAMPLE_BYTES
    ) {
      return false;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const flags = view.getUint16(6, true);
    if (
      bytes[0] !== 0x50 ||
      bytes[1] !== 0x4d ||
      bytes[2] !== 0x4f ||
      bytes[3] !== 0x31 ||
      view.getUint16(4, true) !== 1 ||
      !flags ||
      flags & ~7 ||
      (flags & 4 && !(flags & 2)) ||
      view.getUint32(8, true) !== MOTION_SAMPLE_BYTES ||
      view.getUint32(12, true) === 0
    ) {
      return false;
    }
    const timestamp = view.getFloat64(16, true);
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      return false;
    }
    for (let offset = 24; offset < MOTION_SAMPLE_BYTES; offset += 4) {
      if (!Number.isFinite(view.getFloat32(offset, true))) {
        return false;
      }
    }
    return true;
  }

  class TranslatedPolkaVmRuntime {
    static async compile(bytes) {
      const module = await WebAssembly.compile(bytes);
      const parts = [];
      for (const bytes of WebAssembly.Module.customSections(
        module,
        "epoca.pvm.code-part",
      )) {
        // Keep native compilation bounded to one code part at a time.
        parts.push(await WebAssembly.compile(bytes));
      }
      return { module, parts };
    }

    static isCompiledProgram(value) {
      if (
        value === null ||
        typeof value !== "object" ||
        !(value.module instanceof WebAssembly.Module) ||
        !Array.isArray(value.parts)
      ) {
        return false;
      }
      for (const part of value.parts) {
        if (!(part instanceof WebAssembly.Module)) {
          return false;
        }
      }
      return true;
    }

    constructor(
      program,
      assets,
      emit,
      maxGas,
      audioEnabled,
      graphicsProfile,
      gpuCapabilities = null,
      motionAvailability = MOTION_STATUS_UNAVAILABLE,
      mediatedInputKinds = [],
      fileInput = null,
    ) {
      if (!TranslatedPolkaVmRuntime.isCompiledProgram(program)) {
        throw new TypeError("invalid translated PolkaVM compiled program");
      }
      this.metadata = readMetadata(program.module);
      this.instance = new WebAssembly.Instance(program.module, {});
      this.pvm = this.instance.exports;
      this.memory = this.pvm.memory;
      if (!(this.memory instanceof WebAssembly.Memory)) {
        throw new Error("translated PolkaVM module is missing guest memory");
      }
      const imports = { pvm: this.pvm };
      this.partInstances = program.parts.map(
        (part) => new WebAssembly.Instance(part, imports),
      );
      this.assets = new Map(
        assets.map((asset) => [
          normalizedPath(asset.path),
          new Uint8Array(asset.bytes),
        ]),
      );
      this.emit = emit;
      this.audioEnabled = audioEnabled;
      if (
        !["framebuffer", "tri2d", "webgpu-raster", "webgpu"].includes(
          graphicsProfile,
        )
      ) {
        throw new Error(
          `translated PolkaVM runtime has invalid graphics profile ${graphicsProfile}`,
        );
      }
      this.graphicsProfile = graphicsProfile;
      if (
        isWebGpuProfile(graphicsProfile) &&
        !(gpuCapabilities instanceof Uint8Array)
      ) {
        throw new Error(
          "WebGPU capabilities are required before PolkaVM initialization",
        );
      }
      this.gpuCapabilities =
        gpuCapabilities instanceof Uint8Array ? gpuCapabilities.slice() : null;
      this.gpuEvents = [];
      this.gpuSubmits = 0;
      this.gpuLastSequence = 0n;
      this.hostFrameRequests = 0;
      this.hostFrameRequestBytes = 0;
      this.hostFrameResponses = [];
      this.hostFrameResponseBytes = 0;
      if (
        !Array.isArray(mediatedInputKinds) ||
        mediatedInputKinds.length > MAX_MEDIATED_INPUT_REGISTRATIONS ||
        mediatedInputKinds.some(
          (kind) =>
            typeof kind !== "string" ||
            !validMediatedInputToken(kind, MAX_MEDIATED_INPUT_KIND_BYTES),
        ) ||
        new Set(mediatedInputKinds).size !== mediatedInputKinds.length
      ) {
        throw new Error("translated PolkaVM runtime has invalid mediated-input kinds");
      }
      this.mediatedInputKinds = new Set(mediatedInputKinds);
      if (
        fileInput !== null &&
        (typeof fileInput?.inline !== "boolean" ||
          typeof fileInput.relaunch !== "boolean" ||
          (fileInput.stream !== undefined && typeof fileInput.stream !== "boolean") ||
          ((fileInput.inline || fileInput.relaunch || fileInput.stream) &&
            !validFileMountPath(fileInput.entrypoint)))
      ) {
        throw new Error("translated PolkaVM runtime has invalid file-input support");
      }
      this.fileInput =
        fileInput?.inline || fileInput?.relaunch || fileInput?.stream
          ? { ...fileInput, stream: fileInput.stream ?? false }
          : null;
      this.mountedFile = null;
      this.initialized = false;
      this.mediatedInputRegistrations = new Map();
      this.fileCacheBytes = 0;
      this.fileCacheCleanups = new Set();
      this.fileCacheCleanupFailed = false;
      this.fileCacheStopped = null;
      this.nextMediatedInputHandle = 0;
      this.activeMediatedInputHandle = null;
      this.mediatedInputCommands = 0;
      this.tri2dSubmitted = false;
      this.uiSemanticsSubmitted = false;
      this.uiOutputSubmitted = false;
      this.maxGas = BigInt(maxGas);
      this.input = [];
      this.coreInput = [];
      this.epocaInput = [];
      this.pointer = null;
      this.setMotionAvailability(motionAvailability);
      this.motionSample = null;
      this.pointerCapture = {
        supported: false,
        armed: false,
        active: false,
        request: null,
      };
      this.timeMs = null;
      this.randomBytes = executionRandomBytes();
      this.randomOffset = 0;
      this.updateAfterMs = null;
      this.clockStartedAt = performance.now();
      this.hostcalls = 0;
      this.hostcallBytes = 0;
      this.resumePending = false;
      this.stopped = false;
      this.coreVm = this.metadata.exports.has("_pvm_start");
      if (this.coreVm && graphicsProfile !== "framebuffer") {
        throw new Error(
          "CoreVM guests require the framebuffer graphics profile",
        );
      }
      this.coreVmStarted = false;
      this.palette = new Uint32Array(256);
      this.palette.fill(0xffffffff);
      this.audioChannels = 0;
      this.audioSampleRate = 0;
      this.fds = new Map();
      this.nextFd = 3;
      this.imports = this.metadata.imports;
      this.exports = this.metadata.exports;
      for (let index = 0; index < 13; index++) {
        if (!(this.pvm[`r${index}`] instanceof WebAssembly.Global)) {
          throw new Error("translated PolkaVM module is missing registers");
        }
      }
    }

    initialize(maxGas = this.maxGas) {
      this.initialized = true;
      const gas = BigInt(maxGas);
      this.#resetBudget(MAX_HOSTCALLS_PER_INIT, gas);
      if (this.coreVm) {
        this.#setupCoreVm();
        return;
      }
      const init = this.exports.get("init");
      if (init !== undefined) {
        this.#run(init, false, gas);
      }
    }

    usesMotion() {
      return this.imports.includes("host_motion_read");
    }

    usesPointerCapture() {
      return this.imports.includes(POINTER_CAPTURE_IMPORT);
    }

    usesUpdateScheduling() {
      return this.imports.includes(UPDATE_AFTER_IMPORT);
    }

    updateAfterMilliseconds() {
      return this.updateAfterMs;
    }

    hasPendingContinuation() {
      return !this.coreVm && this.resumePending;
    }

    pendingHostFrameResponses() {
      return this.hostFrameResponses.length;
    }

    setPointerCaptureSupported(supported) {
      this.pointerCapture.supported = supported === true;
      if (!this.pointerCapture.supported) {
        this.pointerCapture.armed = false;
        this.pointerCapture.request = null;
      }
    }

    setPointerCaptureActive(active) {
      const next = active === true;
      if (this.pointerCapture.active === next) {
        return;
      }
      this.pointerCapture.active = next;
      if (next) {
        this.pointerCapture.armed = false;
      }
      const record = new Uint8Array(INPUT_EVENT_BYTES);
      record[0] = INPUT_POINTER_CAPTURE;
      record[1] = next ? 1 : 0;
      this.sendInput(record);
    }

    takePointerCaptureRequest() {
      const request = this.pointerCapture.request;
      this.pointerCapture.request = null;
      return request;
    }

    #requestPointerCapture(request) {
      const state = this.pointerCapture;
      if (!state.supported) {
        return POINTER_CAPTURE_UNSUPPORTED;
      }
      if (request === POINTER_CAPTURE_ARM) {
        state.armed = true;
        state.request = true;
      } else if (request === POINTER_CAPTURE_RELEASE) {
        state.armed = false;
        state.request = false;
      } else {
        return POINTER_CAPTURE_INVALID_REQUEST;
      }
      if (state.active) {
        return POINTER_CAPTURE_ACTIVE;
      }
      return state.armed ? POINTER_CAPTURE_ARMED : POINTER_CAPTURE_RELEASED;
    }

    update(timeMs) {
      if (this.stopped) {
        return;
      }
      this.timeMs = Math.max(this.timeMs ?? 0, timeMs);
      this.updateAfterMs = null;
      this.gpuSubmits = 0;
      this.hostFrameRequests = 0;
      this.uiSemanticsSubmitted = false;
      this.uiOutputSubmitted = false;
      this.hostFrameRequestBytes = 0;
      this.#resetBudget(
        this.coreVm && !this.coreVmStarted
          ? MAX_HOSTCALLS_PER_INIT
          : MAX_HOSTCALLS_PER_UPDATE,
      );
      if (this.coreVm) {
        this.#run(this.exports.get("_pvm_start"), true);
        this.coreVmStarted = true;
        return;
      }
      const update = this.exports.get("update");
      if (update === undefined) {
        throw new Error("translated PolkaVM guest has no update export");
      }
      this.#run(update, false);
    }

    pauseInput() {
      const survivesPause = (record) =>
        record[0] === 2 || record[0] === 4 || record[0] === 7 ||
        record[0] === 12 || record[0] === 16 || record[0] === 17 ||
        record[0] === 20 || record[0] === 21 ||
        ((record[0] === 13 || record[0] === 15) && record[1] === 0);
      this.input = this.input.filter(survivesPause);
      this.epocaInput = this.epocaInput.filter(survivesPause);
      this.coreInput = this.coreInput.filter(
        ([key, value]) => value === 0 && key !== 0xa3 && key !== 0xa4,
      );
      this.pointer = null;
      this.motionSample = null;
    }

    sendInput(bytes) {
      if (this.stopped || bytes.byteLength !== INPUT_EVENT_BYTES) {
        return;
      }
      if (!this.coreVm) {
        const copy = bytes.slice();
        const type = copy[0];
        if (type === 7) {
          const existing = this.input.findLastIndex(
            (event) => event[0] === type,
          );
          if (existing !== -1) {
            this.input.splice(existing, 1);
          }
        } else if (type === 5 && this.input.at(-1)?.[0] === 5) {
          this.input[this.input.length - 1] = copy;
          return;
        } else if (type === 19) {
          const existing = this.input.findLastIndex(
            (event) => event[0] === type && event[1] === copy[1],
          );
          if (existing !== -1) {
            this.input.splice(existing, 1);
          }
        }
        if (this.input.length === MAX_INPUT_EVENTS) {
          const discardable = this.input.findIndex(
            (event) =>
              event[0] === 5 ||
              event[0] === 6 ||
              event[0] === 14 ||
              event[0] === 19,
          );
          if (discardable === -1) {
            throw new Error("translated PolkaVM input queue is full");
          }
          this.input.splice(discardable, 1);
        }
        this.input.push(copy);
        return;
      }
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      const type = bytes[0];
      if (
        type === 6 &&
        (Math.abs(view.getInt16(2, true)) > 127 ||
          Math.abs(view.getInt16(4, true)) > 127)
      ) {
        return;
      }
      if (this.imports.includes("pvm_fetch_epoca_inputs")) {
        this.#queueEpocaInput(bytes);
        return;
      }
      if (type === 1 || type === 2) {
        const key = hidToCoreVm(bytes[1]);
        if (key !== undefined) {
          this.#queueCoreInput(key, type === 1 ? 1 : 0);
        }
      } else if (type === 3 || type === 4) {
        const key =
          bytes[1] >= 1 && bytes[1] <= 3 ? 0x9f + bytes[1] : undefined;
        if (key !== undefined) {
          this.#queueCoreInput(key, type === 3 ? 1 : 0);
        }
      } else if (type === 5) {
        const current = [view.getUint16(2, true), view.getUint16(4, true)];
        if (this.pointer) {
          this.#queueCoreInput(
            0xa3,
            Math.max(-128, Math.min(127, current[0] - this.pointer[0])) & 0xff,
          );
          this.#queueCoreInput(
            0xa4,
            Math.max(-128, Math.min(127, current[1] - this.pointer[1])) & 0xff,
          );
        }
        this.pointer = current;
      } else if (type === 6) {
        this.#queueCoreInput(
          0xa3,
          Math.max(-128, Math.min(127, view.getInt16(2, true))) & 0xff,
        );
        this.#queueCoreInput(
          0xa4,
          Math.max(-128, Math.min(127, view.getInt16(4, true))) & 0xff,
        );
      }
    }

    /**
     * Queues one viewport-inset update as the pair the guest ABI defines.
     *
     * The two records carry one axis each, so they are queued together and
     * supersede the queued update of the same type: a guest must never read a
     * new axis beside the previous update's other axis. CoreVM guests have no
     * inset records, so the update is dropped for them.
     */
    sendViewInsets(eventType, left, top, right, bottom) {
      if (this.stopped || this.coreVm) {
        return;
      }
      const horizontal = new Uint8Array(INPUT_EVENT_BYTES);
      horizontal[0] = eventType;
      horizontal[1] = INPUT_INSETS_HORIZONTAL;
      const vertical = new Uint8Array(INPUT_EVENT_BYTES);
      vertical[0] = eventType;
      vertical[1] = INPUT_INSETS_VERTICAL;
      const horizontalView = new DataView(horizontal.buffer);
      horizontalView.setUint16(2, left, true);
      horizontalView.setUint16(4, right, true);
      const verticalView = new DataView(vertical.buffer);
      verticalView.setUint16(2, top, true);
      verticalView.setUint16(4, bottom, true);
      this.input = this.input.filter((record) => record[0] !== eventType);
      while (this.input.length > MAX_INPUT_EVENTS - 2) {
        this.input.shift();
      }
      this.input.push(horizontal, vertical);
    }

    /**
     * How many queued records a guest buffer of `slots` records receives.
     *
     * A buffer that ends between the two halves of an inset update would hand
     * the guest a new axis beside a stale one, so the pair waits for the next
     * poll. A buffer too small to ever hold both is served as-is rather than
     * stalling behind a pair it can never take.
     */
    pollableInputCount(slots) {
      const available = Math.min(slots, this.input.length);
      if (slots < 2 || available === 0) {
        return available;
      }
      const last = this.input[available - 1];
      const startsPair =
        (last[0] === INPUT_SAFE_AREA_INSETS ||
          last[0] === INPUT_KEYBOARD_INSETS) &&
        last[1] === INPUT_INSETS_HORIZONTAL;
      return startsPair ? available - 1 : available;
    }

    setMotionAvailability(availability) {
      if (
        !Number.isInteger(availability) ||
        availability < MOTION_STATUS_UNAVAILABLE ||
        availability > MOTION_STATUS_PERMISSION_DENIED
      ) {
        throw new Error(
          "translated PolkaVM runtime has invalid motion availability",
        );
      }
      this.motionAvailability = availability;
      if (availability !== MOTION_STATUS_AVAILABLE) {
        this.motionSample = null;
      }
    }

    sendMotionSample(bytes) {
      if (this.stopped || !validMotionSample(bytes)) {
        throw new Error(
          "translated PolkaVM runtime received an invalid motion sample",
        );
      }
      this.motionAvailability = MOTION_STATUS_AVAILABLE;
      this.motionSample = bytes.slice();
    }

    setGpuCapabilities(bytes) {
      if (
        this.stopped ||
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength < 56 ||
        bytes.byteLength > 4096
      ) {
        throw new Error("invalid translated WebGPU capabilities");
      }
      this.gpuCapabilities = bytes.slice();
    }

    sendGpuEvent(bytes) {
      if (
        this.stopped ||
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength < 24 ||
        bytes.byteLength > MAX_GPU_EVENT_BYTES ||
        decoder.decode(bytes.subarray(0, 4)) !== "EGE1"
      ) {
        return;
      }
      if (this.gpuEvents.length === MAX_GPU_EVENTS) {
        this.gpuEvents.shift();
      }
      this.gpuEvents.push(bytes.slice());
    }

    sendHostFrameResponse(bytes) {
      if (
        this.stopped ||
        !(bytes instanceof Uint8Array) ||
        !bytes.byteLength ||
        bytes.byteLength > MAX_HOST_FRAME_BYTES
      ) {
        throw new Error("invalid translated host-frame response");
      }
      if (
        this.hostFrameResponses.length === MAX_HOST_FRAMES ||
        this.hostFrameResponseBytes + bytes.byteLength >
          MAX_QUEUED_HOST_FRAME_BYTES
      ) {
        return false;
      }
      this.hostFrameResponses.push(bytes.slice());
      this.hostFrameResponseBytes += bytes.byteLength;
      return true;
    }

    sendMediatedInputResult(handle, status, bytes) {
      const registration = this.mediatedInputRegistrations.get(handle);
      if (
        this.stopped ||
        !registration ||
        registration.status !== MEDIATED_INPUT_STATUS_ACTIVE ||
        this.activeMediatedInputHandle !== handle ||
        !Number.isInteger(status) ||
        ![
          MEDIATED_INPUT_STATUS_READY,
          MEDIATED_INPUT_STATUS_CANCELLED,
          MEDIATED_INPUT_STATUS_PERMISSION_DENIED,
          MEDIATED_INPUT_STATUS_FAILED,
        ].includes(status) ||
        !(bytes instanceof Uint8Array)
      ) {
        throw new Error("invalid translated mediated-input result");
      }
      if (status === MEDIATED_INPUT_STATUS_READY) {
        if (registration.descriptor) {
          throw new Error(
            "translated file results are delivered with their name and MIME type",
          );
        }
        if (!bytes.byteLength || bytes.byteLength > registration.maxBytes) {
          throw new Error("translated mediated-input result exceeds its registered bound");
        }
        registration.result = bytes.slice();
      } else if (bytes.byteLength) {
        throw new Error("translated mediated-input failure carries unexpected bytes");
      } else {
        registration.result = null;
        registration.file = null;
      }
      this.activeMediatedInputHandle = null;
      registration.status = status;
    }

    #registerMediatedInput(kind, mediaType, maxBytes) {
      if (
        !validMediatedInputToken(kind, MAX_MEDIATED_INPUT_KIND_BYTES) ||
        !validMediatedInputToken(mediaType, MAX_MEDIATED_INPUT_MEDIA_TYPE_BYTES) ||
        !Number.isInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > MAX_MEDIATED_INPUT_BYTES
      ) {
        return -1;
      }
      if (!this.mediatedInputKinds.has(kind)) {
        return -2;
      }
      for (const [handle, registration] of this.mediatedInputRegistrations) {
        if (
          !registration.descriptor &&
          registration.kind === kind &&
          registration.mediaType === mediaType &&
          registration.maxBytes === maxBytes
        ) {
          return handle;
        }
      }
      return this.#insertRegistration({ kind, mediaType, maxBytes });
    }

    #insertRegistration(source) {
      if (
        this.mediatedInputRegistrations.size === MAX_MEDIATED_INPUT_REGISTRATIONS
      ) {
        return -3;
      }
      do {
        this.nextMediatedInputHandle =
          this.nextMediatedInputHandle >= 0x7fffffff
            ? 1
            : this.nextMediatedInputHandle + 1;
      } while (
        this.mediatedInputRegistrations.has(this.nextMediatedInputHandle)
      );
      this.mediatedInputRegistrations.set(this.nextMediatedInputHandle, {
        ...source,
        status: MEDIATED_INPUT_STATUS_REGISTERED,
        result: null,
        file: null,
        source: null,
        cache: null,
      });
      return this.nextMediatedInputHandle;
    }

    #registerFile(bytes) {
      const descriptor = parseFileDescriptor(bytes);
      if (descriptor === null) {
        return -1;
      }
      if (this.fileInput === null) {
        return -2;
      }
      if (!this.fileInput[descriptor.delivery]) {
        return FILE_REGISTER_DELIVERY_UNAVAILABLE;
      }
      if (descriptor.mountPath === this.fileInput.entrypoint) {
        return -1;
      }
      for (const [handle, registration] of this.mediatedInputRegistrations) {
        const existing = registration.descriptor;
        if (!existing) {
          continue;
        }
        if (sameFileDescriptor(existing, descriptor)) {
          return handle;
        }
        if (
          existing.id === descriptor.id ||
          (descriptor.mountPath !== undefined &&
            existing.mountPath === descriptor.mountPath)
        ) {
          return -1;
        }
      }
      let mounted = null;
      if (this.mountedFile?.id === descriptor.id) {
        mounted = this.mountedFile;
        this.mountedFile = null;
        if (
          descriptor.mountPath !== mounted.mountPath ||
          mounted.file.size > descriptor.maxBytes
        ) {
          mounted = null;
        }
      }
      const handle = this.#insertRegistration({
        descriptor,
        maxBytes: descriptor.maxBytes,
      });
      if (handle > 0) {
        if (mounted !== null) {
          const registration = this.mediatedInputRegistrations.get(handle);
          registration.status = MEDIATED_INPUT_STATUS_READY;
          registration.file = mounted.file;
        }
        this.emit({
          type: "file-registrations",
          registrations: this.fileRegistrations(),
        });
      }
      return handle;
    }

    /** Every file registration of the execution, in handle order. */
    fileRegistrations() {
      return [...this.mediatedInputRegistrations]
        .filter(([, registration]) => registration.descriptor)
        .sort(([left], [right]) => left - right)
        .map(([handle, registration]) => ({
          handle,
          descriptor: structuredClone(registration.descriptor),
        }));
    }

    /**
     * Delivers a file the user selected in Host UI, either for the guest's
     * active request or onto an idle registration.
     */
    deliverFile(handle, name, mimeType, bytes) {
      const sanitized = sanitizeFileName(name);
      validateSelectedMimeType(mimeType);
      if (this.stopped || !(bytes instanceof Uint8Array)) {
        throw new Error("invalid translated file delivery");
      }
      const registration = this.mediatedInputRegistrations.get(handle);
      if (!registration?.descriptor) {
        throw new Error(`translated handle ${handle} is not a file registration`);
      }
      if (registration.descriptor.delivery === "stream") {
        throw new Error("translated streamed files require metadata-only delivery");
      }
      const accepted =
        this.activeMediatedInputHandle === null
          ? registration.status !== MEDIATED_INPUT_STATUS_READY
          : this.activeMediatedInputHandle === handle;
      if (!accepted) {
        return { outcome: "refused" };
      }
      if (handle === this.activeMediatedInputHandle) {
        this.activeMediatedInputHandle = null;
      }
      registration.result = null;
      registration.file = null;
      if (!bytes.byteLength || bytes.byteLength > registration.maxBytes) {
        registration.status = MEDIATED_INPUT_STATUS_FAILED;
        return { outcome: "rejected" };
      }
      const file = { name: sanitized, mimeType, size: bytes.byteLength };
      if (registration.descriptor.delivery === "inline") {
        registration.result = bytes.slice();
        registration.file = file;
        registration.status = MEDIATED_INPUT_STATUS_READY;
        return { outcome: "ready" };
      }
      registration.status = MEDIATED_INPUT_STATUS_REGISTERED;
      this.stop();
      return {
        outcome: "relaunch",
        relaunch: {
          id: registration.descriptor.id,
          mountPath: registration.descriptor.mountPath,
          name: sanitized,
          mimeType,
          bytes,
        },
      };
    }

    /** Takes ownership of a Host-retained source without reading its contents. */
    sendFileStream(handle, name, mimeType, size, source, cache = null) {
      let installed = false;
      try {
        const sanitized = sanitizeFileName(name);
        validateSelectedMimeType(mimeType);
        if (
          this.stopped ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          typeof source?.read !== "function" ||
          typeof source.close !== "function" ||
          (cache !== null && ["size", "reset", "write", "read", "flush", "close"]
            .some((method) => typeof cache?.[method] !== "function"))
        ) {
          throw new Error("invalid translated stream selection");
        }
        const registration = this.mediatedInputRegistrations.get(handle);
        if (registration?.descriptor?.delivery !== "stream") {
          throw new Error(`translated handle ${handle} is not a stream registration`);
        }
        const accepted =
          this.activeMediatedInputHandle === null
            ? registration.status !== MEDIATED_INPUT_STATUS_READY
            : this.activeMediatedInputHandle === handle;
        if (!accepted) {
          return { outcome: "refused" };
        }
        this.activeMediatedInputHandle = null;
        registration.result = null;
        registration.file = null;
        if (!size || size > registration.maxBytes || size > MAX_STREAM_FILE_BYTES) {
          registration.status = MEDIATED_INPUT_STATUS_FAILED;
          return { outcome: "rejected" };
        }
        registration.file = { name: sanitized, mimeType, size };
        registration.source = source;
        registration.cache = cache === null
          ? null
          : { backend: cache, size: 0, cursor: 0, sealed: false };
        registration.status = MEDIATED_INPUT_STATUS_READY;
        installed = true;
        return { outcome: "ready" };
      } finally {
        if (!installed) {
          this.#releaseFileSource(source);
          if (typeof cache?.close === "function") this.#releaseFileCache(cache);
        }
      }
    }

    #closeFileStream(registration) {
      const source = registration.source;
      registration.source = null;
      this.#releaseFileSource(source);
      this.#closeFileCache(registration);
    }

    #releaseFileSource(source) {
      try {
        source?.close?.();
      } catch (error) {
        this.fileCacheCleanupFailed = true;
        this.emit({
          type: "error",
          fatal: false,
          message: `PolkaVM selected file cleanup failed: ${error?.message ?? error}`,
        });
      }
    }

    #closeFileCache(registration) {
      const cache = registration.cache;
      registration.cache = null;
      if (cache !== null) {
        this.#releaseFileCache(cache.backend, cache.size);
      }
    }

    #releaseFileCache(cache, reservedBytes = 0) {
      const failed = (error) => {
        this.fileCacheCleanupFailed = true;
        this.emit({
          type: "error",
          fatal: false,
          message: `PolkaVM private cache cleanup failed: ${error?.message ?? error}`,
        });
      };
      try {
        const closing = cache.close();
        if (closing?.then) {
          const pending = Promise.resolve(closing).then(() => {
            this.fileCacheBytes -= reservedBytes;
          }).catch(failed);
          this.fileCacheCleanups.add(pending);
          void pending.then(() => this.fileCacheCleanups.delete(pending));
        } else {
          this.fileCacheBytes -= reservedBytes;
        }
      } catch (error) {
        failed(error);
      }
    }

    #fileCache(handle) {
      const registration = this.mediatedInputRegistrations.get(handle);
      return registration?.status === MEDIATED_INPUT_STATUS_READY &&
        registration.source !== null && registration.cache !== null
        ? registration
        : null;
    }

    #resetFileCache(handle, size) {
      const registration = this.#fileCache(handle);
      if (registration === null) {
        return -1;
      }
      const cache = registration.cache;
      if (size < 1 || size > MAX_FILE_CACHE_BYTES ||
          this.fileCacheBytes - cache.size + size > MAX_FILE_CACHE_BYTES) {
        return -2;
      }
      const reservation = Math.max(cache.size, size);
      this.fileCacheBytes += reservation - cache.size;
      cache.size = reservation;
      try {
        cache.backend.reset(size);
        if (cache.backend.size() !== size) {
          throw new Error("invalid translated cache size");
        }
      } catch {
        this.#closeFileCache(registration);
        return -4;
      }
      this.fileCacheBytes += size - cache.size;
      cache.size = size;
      cache.cursor = 0;
      cache.sealed = false;
      return 0;
    }

    #writeFileCache(handle, offset, pointer, length) {
      const registration = this.#fileCache(handle);
      if (registration === null) {
        return -1;
      }
      const cache = registration.cache;
      if (cache.sealed || length < 1 || length > MAX_FILE_READ_BYTES ||
          offset !== cache.cursor || offset + length > cache.size) {
        return -2;
      }
      this.#chargeBytes(length);
      let bytes;
      try {
        bytes = this.#range(pointer, length);
      } catch {
        return -3;
      }
      try {
        if (cache.backend.write(offset, bytes) !== length) {
          throw new Error("short translated cache write");
        }
      } catch {
        this.#closeFileCache(registration);
        return -4;
      }
      cache.cursor += length;
      return length;
    }

    #commitFileCache(handle) {
      const registration = this.#fileCache(handle);
      if (registration === null) {
        return -1;
      }
      const cache = registration.cache;
      if (cache.sealed || cache.size === 0 || cache.cursor !== cache.size) {
        return -2;
      }
      try {
        cache.backend.flush();
      } catch {
        this.#closeFileCache(registration);
        return -4;
      }
      cache.sealed = true;
      return 0;
    }

    #readFileCache(handle, offset, pointer, length) {
      const registration = this.#fileCache(handle);
      if (registration === null || !registration.cache.sealed) {
        return -1;
      }
      const cache = registration.cache;
      if (length < 1 || length > MAX_FILE_READ_BYTES || offset > cache.size) {
        return -2;
      }
      const actual = Math.min(length, cache.size - offset);
      this.#chargeBytes(actual);
      if (actual === 0) {
        return 0;
      }
      let destination;
      try {
        destination = this.#range(pointer, actual, true);
      } catch {
        return -3;
      }
      try {
        const bytes = cache.backend.read(offset, actual);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== actual) {
          throw new Error("short translated cache read");
        }
        destination.set(bytes);
        return actual;
      } catch {
        this.#closeFileCache(registration);
        return -4;
      }
    }

    #readFileStream(handle, offset, pointer, length) {
      const registration = this.mediatedInputRegistrations.get(handle);
      if (
        registration?.descriptor?.delivery !== "stream" ||
        registration.file === null ||
        registration.source === null
      ) {
        return -1;
      }
      if (length < 1 || length > MAX_FILE_READ_BYTES || offset > registration.file.size) {
        return -2;
      }
      const actual = Math.min(length, registration.file.size - offset);
      this.#chargeBytes(actual);
      if (actual === 0) {
        return 0;
      }
      let destination;
      try {
        destination = this.#range(pointer, actual, true);
      } catch {
        return -3;
      }
      try {
        const bytes = registration.source.read(offset, actual);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== actual) {
          throw new Error("short translated stream read");
        }
        destination.set(bytes);
        return actual;
      } catch {
        registration.file = null;
        registration.status = MEDIATED_INPUT_STATUS_FAILED;
        this.#closeFileStream(registration);
        this.#emitMediatedInputCommand({ type: "mediated-input-cancel", handle });
        return -4;
      }
    }

    /**
     * Mounts a relaunch-delivered file in place of the asset at its mount
     * path before initialization.
     */
    setFileRelaunch(relaunch) {
      if (this.initialized || this.stopped) {
        throw new Error("translated relaunch files are mounted before init");
      }
      const bytes = relaunch?.bytes;
      if (
        !validFileId(relaunch?.id) ||
        !validFileMountPath(relaunch.mountPath) ||
        sanitizeFileName(relaunch.name) !== relaunch.name ||
        !(bytes instanceof Uint8Array) ||
        !bytes.byteLength ||
        bytes.byteLength > MAX_RELAUNCH_FILE_BYTES
      ) {
        throw new Error("invalid translated relaunch file");
      }
      validateSelectedMimeType(relaunch.mimeType);
      const replaced = this.assets.get(relaunch.mountPath)?.byteLength ?? 0;
      let total = bytes.byteLength - replaced;
      for (const asset of this.assets.values()) {
        total += asset.byteLength;
      }
      const count =
        this.assets.size + (this.assets.has(relaunch.mountPath) ? 0 : 1);
      if (count > MAX_ASSET_FILES || total > MAX_ASSET_BYTES) {
        throw new Error("translated relaunch file exceeds the asset bounds");
      }
      this.assets.set(relaunch.mountPath, bytes.slice());
      this.mountedFile = {
        id: relaunch.id,
        mountPath: relaunch.mountPath,
        file: {
          name: relaunch.name,
          mimeType: relaunch.mimeType,
          size: bytes.byteLength,
        },
      };
    }

    #emitMediatedInputCommand(command) {
      this.mediatedInputCommands++;
      this.emit(command);
    }

    #triggerMediatedInput(handle) {
      const registration = this.mediatedInputRegistrations.get(handle);
      if (this.activeMediatedInputHandle !== null) {
        return 2;
      }
      if (!registration) {
        return 1;
      }
      const replacingStream =
        registration.descriptor?.delivery === "stream" && registration.file !== null;
      // Like the native pending queue, bound each guest slice's output while
      // retaining room to cancel every live registration during teardown.
      if (this.mediatedInputCommands + 1 + Number(replacingStream) +
          MAX_MEDIATED_INPUT_REGISTRATIONS > MAX_MEDIATED_INPUT_COMMANDS) {
        return 2;
      }
      if (replacingStream) {
        this.#cancelMediatedInput(handle);
      }
      registration.status = MEDIATED_INPUT_STATUS_ACTIVE;
      this.activeMediatedInputHandle = handle;
      registration.result = null;
      registration.file = null;
      if (registration.descriptor) {
        this.#emitMediatedInputCommand({
          type: "file-input-request",
          handle,
          descriptor: structuredClone(registration.descriptor),
        });
        return 0;
      }
      this.#emitMediatedInputCommand({
        type: "mediated-input-request",
        handle,
        kind: registration.kind,
        mediaType: registration.mediaType,
        maxBytes: registration.maxBytes,
      });
      return 0;
    }

    #cancelMediatedInput(handle) {
      const registration = this.mediatedInputRegistrations.get(handle);
      if (!registration) {
        return 1;
      }
      if (registration.status === MEDIATED_INPUT_STATUS_READY) {
        registration.status = MEDIATED_INPUT_STATUS_REGISTERED;
        registration.result = null;
        registration.file = null;
        if (registration.descriptor?.delivery === "stream") {
          this.#closeFileStream(registration);
          this.#emitMediatedInputCommand({ type: "mediated-input-cancel", handle });
        }
        return 0;
      }
      if (registration.status !== MEDIATED_INPUT_STATUS_ACTIVE) {
        return 2;
      }
      registration.status = MEDIATED_INPUT_STATUS_REGISTERED;
      registration.result = null;
      registration.file = null;
      this.activeMediatedInputHandle = null;
      this.#emitMediatedInputCommand({ type: "mediated-input-cancel", handle });
      return 0;
    }

    stop() {
      if (this.stopped) {
        return this.fileCacheStopped;
      }
      this.stopped = true;
      for (const [handle, registration] of this.mediatedInputRegistrations) {
        if (registration.descriptor?.delivery === "stream" && registration.file !== null) {
          this.#closeFileStream(registration);
          this.#emitMediatedInputCommand({ type: "mediated-input-cancel", handle });
        } else if (registration.status === MEDIATED_INPUT_STATUS_ACTIVE) {
          this.#emitMediatedInputCommand({ type: "mediated-input-cancel", handle });
        }
      }
      this.input.length = 0;
      this.coreInput.length = 0;
      this.epocaInput.length = 0;
      this.hostFrameRequests = 0;
      this.hostFrameRequestBytes = 0;
      this.gpuEvents.length = 0;
      this.hostFrameResponses.length = 0;
      this.hostFrameResponseBytes = 0;
      this.mediatedInputRegistrations.clear();
      this.activeMediatedInputHandle = null;
      this.fileCacheStopped = (async () => {
        while (this.fileCacheCleanups.size) {
          await Promise.all([...this.fileCacheCleanups]);
        }
        return { cleanupFailed: this.fileCacheCleanupFailed };
      })();
      return this.fileCacheStopped;
    }

    #resetBudget(hostcalls, gas = this.maxGas) {
      this.hostcalls = hostcalls;
      this.hostcallBytes = MAX_HOSTCALL_BYTES;
      this.tri2dSubmitted = false;
      this.mediatedInputCommands = 0;
      this.pvm.pvm_set_gas(gas);
    }

    #run(entry, yieldOnFrame, gas = this.maxGas) {
      let status;
      if (this.resumePending) {
        this.resumePending = false;
        status = this.pvm.pvm_resume();
      } else {
        if (entry === undefined) {
          throw new Error("translated PolkaVM entrypoint is missing");
        }
        status = this.pvm.pvm_begin(entry, gas);
      }
      for (;;) {
        if (status === STATUS_FINISHED) {
          if (this.coreVm) {
            throw new Error("CoreVM guest exited");
          }
          return;
        }
        if (status === STATUS_TRAP) {
          throw new Error(
            `translated PolkaVM execution trapped at ${this.pvm.trap_pc.value}`,
          );
        }
        if (status === STATUS_OUT_OF_GAS) {
          throw new Error("translated PolkaVM guest ran out of gas");
        }
        if (status !== STATUS_ECALL) {
          throw new Error(
            `translated PolkaVM returned invalid status ${status}`,
          );
        }
        const importIndex = this.pvm.ecall.value >>> 0;
        const name = this.imports[importIndex];
        if (!name) {
          throw new Error(
            `translated PolkaVM called unknown import ${importIndex}`,
          );
        }
        this.hostcalls--;
        const yielded = this.coreVm
          ? this.#handleCoreVmCall(name)
          : this.#handleCooperativeCall(name);
        if (yielded && yieldOnFrame) {
          this.resumePending = true;
          return;
        }
        if (this.hostcalls === 0) {
          // Resume on the next worker tick after completing this ECALL. Large
          // assets can require more than one bounded hostcall slice, while
          // returning here keeps each slice capped and the worker responsive.
          this.resumePending = true;
          return;
        }
        status = this.pvm.pvm_resume();
      }
    }

    #reg(index) {
      return BigInt.asUintN(64, this.pvm[`r${index}`].value);
    }

    #setReg(index, value) {
      const normalized = this.metadata.is64Bit
        ? BigInt.asIntN(64, BigInt(value))
        : BigInt.asUintN(32, BigInt(value));
      this.pvm[`r${index}`].value = normalized;
    }
    #setU64Result(value) {
      const normalized = BigInt.asUintN(64, BigInt(value));
      this.#setReg(7, normalized);
      if (!this.metadata.is64Bit) {
        this.#setReg(8, normalized >> 32n);
      }
    }

    #u32(value) {
      return Number(value & 0xffffffffn) >>> 0;
    }

    #range(address, length, write = false) {
      address >>>= 0;
      length >>>= 0;
      const end = address + length;
      if (end > 0x100000000) {
        throw new Error(
          "translated PolkaVM guest memory access is out of range",
        );
      }
      const { layout } = this.metadata;
      let physical;
      if (address >= layout.stackLow && end <= layout.stackHigh) {
        physical = layout.stackPhysical + address - layout.stackLow;
      } else if (
        address >= layout.rwAddress &&
        end <=
          layout.rwAddress + this.memory.buffer.byteLength - layout.rwPhysical
      ) {
        physical = layout.rwPhysical + address - layout.rwAddress;
      } else if (
        !write &&
        address >= layout.roAddress &&
        end <= layout.roAddress + layout.roSize
      ) {
        physical = layout.roPhysical + address - layout.roAddress;
      } else {
        throw new Error(
          "translated PolkaVM guest memory access is out of range",
        );
      }
      return new Uint8Array(this.memory.buffer, physical, length);
    }

    #read(address, length) {
      this.#chargeBytes(length);
      return this.#range(address, length).slice();
    }

    #write(address, bytes) {
      this.#chargeBytes(bytes.byteLength);
      this.#range(address, bytes.byteLength, true).set(bytes);
    }

    #chargeBytes(length) {
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > this.hostcallBytes
      ) {
        throw new Error(
          "translated PolkaVM guest exceeded hostcall byte budget",
        );
      }
      this.hostcallBytes -= length;
    }

    #readU64(address) {
      const bytes = this.#range(address >>> 0, 8);
      return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(
        0,
        true,
      );
    }

    #writeU64(address, value) {
      const bytes = this.#range(address >>> 0, 8, true);
      new DataView(bytes.buffer, bytes.byteOffset, 8).setBigUint64(
        0,
        BigInt.asUintN(64, value),
        true,
      );
    }

    #readCString(address) {
      const output = [];
      for (let offset = 0; offset < 255; offset++) {
        let byte;
        try {
          byte = this.#range((address + offset) >>> 0, 1)[0];
        } catch {
          return null;
        }
        if (!byte) {
          return new Uint8Array(output);
        }
        output.push(byte);
      }
      return null;
    }

    // eslint-disable-next-line complexity -- Flat hostcall dispatch mirrors the guest ABI.
    #handleCooperativeCall(name) {
      const a0 = this.#reg(7);
      const a1 = this.#reg(8);
      const a2 = this.#reg(9);
      const a3 = this.#reg(10);
      const a4 = this.#reg(11);
      switch (name) {
        case "host_present_frame": {
          const width = this.#u32(a1);
          const height = this.#u32(a2);
          const stride = this.#u32(a3);
          const rowBytes = width * 4;
          const length = rowBytes * height;
          if (
            !width ||
            !height ||
            stride !== rowBytes ||
            length > MAX_FRAME_BYTES
          ) {
            this.#setReg(7, 1n);
            return false;
          }
          if (this.graphicsProfile !== "framebuffer") {
            this.#setReg(7, 3n);
            return false;
          }
          const source = this.#read(this.#u32(a0), length);
          const pixels = new Uint8Array(length);
          for (let index = 0; index < length; index += 4) {
            pixels[index] = source[index + 2];
            pixels[index + 1] = source[index + 1];
            pixels[index + 2] = source[index];
            pixels[index + 3] = source[index + 3];
          }
          this.emit({ type: "frame", width, height, pixels }, [pixels.buffer]);
          this.#setReg(7, 0n);
          return false;
        }
        case "host_tri2d_submit": {
          const length = this.#u32(a1);
          if (!length || length > MAX_TRI2D_BYTES) {
            this.#setReg(7, 1n);
            return false;
          }
          if (this.graphicsProfile !== "tri2d") {
            this.#setReg(7, 3n);
            return false;
          }
          if (this.tri2dSubmitted) {
            this.#setReg(7, 2n);
            return false;
          }
          const bytes = this.#read(this.#u32(a0), length);
          this.emit({ type: "tri2d", bytes }, [bytes.buffer]);
          this.tri2dSubmitted = true;
          this.#setReg(7, 0n);
          return false;
        }
        case "host_ui_semantics_submit": {
          const length = this.#u32(a1);
          if (!length || length > MAX_UI_SEMANTICS_BYTES) {
            this.#setReg(7, 1n);
            return false;
          }
          if (this.uiSemanticsSubmitted) {
            this.#setReg(7, 2n);
            return false;
          }
          const bytes = this.#read(this.#u32(a0), length);
          if (!validUiSemantics(bytes)) {
            this.#setReg(7, 1n);
            return false;
          }
          this.emit({ type: "ui-semantics", bytes }, [bytes.buffer]);
          this.uiSemanticsSubmitted = true;
          this.#setReg(7, 0n);
          return false;
        }
        case "host_ui_output_submit": {
          const length = this.#u32(a1);
          if (length < UI_OUTPUT_HEADER_BYTES || length > MAX_UI_OUTPUT_BYTES) {
            this.#setReg(7, 1n);
            return false;
          }
          this.#chargeBytes(length);
          if (this.uiOutputSubmitted) {
            this.#setReg(7, 2n);
            return false;
          }
          let bytes;
          try {
            bytes = this.#range(this.#u32(a0), length).slice();
          } catch {
            this.#setReg(7, 1n);
            return false;
          }
          const output = decodeUiOutput(bytes);
          if (output === null) {
            this.#setReg(7, 1n);
            return false;
          }
          this.emit({ type: "ui-output", output });
          this.uiOutputSubmitted = true;
          this.#setReg(7, 0n);
          return false;
        }
        case "host_gpu_capabilities": {
          if (!isWebGpuProfile(this.graphicsProfile)) {
            this.#setReg(7, BigInt(GPU_ERROR_INVALID_STATE));
            return false;
          }
          if (this.gpuCapabilities === null) {
            this.#setReg(7, BigInt(GPU_ERROR_INVALID_STATE));
            return false;
          }
          const capacity = this.#u32(a1);
          const required = this.gpuCapabilities.byteLength;
          if (capacity < required) {
            this.#setReg(7, BigInt(-required));
            return false;
          }
          this.#write(this.#u32(a0), this.gpuCapabilities);
          this.#setReg(7, BigInt(required));
          return false;
        }
        case "host_gpu_submit": {
          if (!isWebGpuProfile(this.graphicsProfile)) {
            this.#setReg(7, BigInt(GPU_ERROR_INVALID_STATE));
            return false;
          }
          const length = this.#u32(a1);
          if (this.gpuCapabilities === null) {
            this.#setReg(7, BigInt(GPU_ERROR_INVALID_STATE));
            return false;
          }
          if (
            !length ||
            length > MAX_GPU_BATCH_BYTES ||
            this.gpuSubmits === MAX_GPU_SUBMITS_PER_UPDATE
          ) {
            this.#setReg(
              7,
              BigInt(
                this.gpuSubmits === MAX_GPU_SUBMITS_PER_UPDATE
                  ? GPU_ERROR_QUOTA_EXCEEDED
                  : GPU_ERROR_MALFORMED_BATCH,
              ),
            );
            return false;
          }
          const bytes = this.#read(this.#u32(a0), length);
          const sequence = this.#gpuBatchSequence(bytes);
          if (sequence === null) {
            this.#setReg(7, BigInt(GPU_ERROR_MALFORMED_BATCH));
            return false;
          }
          if (
            this.graphicsProfile !== "webgpu" &&
            this.#gpuBatchUsesCompute(bytes)
          ) {
            this.#setReg(7, BigInt(GPU_ERROR_INVALID_STATE));
            return false;
          }
          if (sequence <= this.gpuLastSequence) {
            this.#setReg(7, BigInt(GPU_ERROR_INVALID_STATE));
            return false;
          }
          this.gpuSubmits++;
          this.gpuLastSequence = sequence;
          this.emit({ type: "gpu-batch", bytes }, [bytes.buffer]);
          this.#setReg(7, 0n);
          return false;
        }
        case "host_gpu_receive": {
          if (!isWebGpuProfile(this.graphicsProfile)) {
            this.#setReg(7, BigInt(GPU_ERROR_INVALID_STATE));
            return false;
          }
          const event = this.gpuEvents[0];
          if (event === undefined) {
            this.#setReg(7, 0n);
            return false;
          }
          const capacity = this.#u32(a1);
          if (capacity < event.byteLength) {
            this.#setReg(7, BigInt(-event.byteLength));
            return false;
          }
          this.#write(this.#u32(a0), event);
          this.gpuEvents.shift();
          this.#setReg(7, BigInt(event.byteLength));
          return false;
        }
        case "host_poll_input": {
          const capacity = this.#u32(a1);
          const slots = Math.floor(capacity / INPUT_EVENT_BYTES);
          const count = this.pollableInputCount(slots);
          const output = new Uint8Array(count * INPUT_EVENT_BYTES);
          for (let index = 0; index < count; index++) {
            output.set(this.input.shift(), index * INPUT_EVENT_BYTES);
          }
          this.#write(this.#u32(a0), output);
          this.#setReg(7, BigInt(output.byteLength));
          return false;
        }
        case "host_motion_read":
          return this.#readMotion();
        case POINTER_CAPTURE_IMPORT: {
          const status = this.#requestPointerCapture(this.#u32(a0));
          this.#setReg(7, BigInt(status));
          return false;
        }
        case "host_input_register": {
          const kindLength = this.#u32(a1);
          const mediaTypeLength = this.#u32(a3);
          let result = -1;
          if (
            kindLength > 0 &&
            kindLength <= MAX_MEDIATED_INPUT_KIND_BYTES &&
            mediaTypeLength > 0 &&
            mediaTypeLength <= MAX_MEDIATED_INPUT_MEDIA_TYPE_BYTES
          ) {
            this.#chargeBytes(kindLength + mediaTypeLength);
            try {
              const kind = strictDecoder.decode(
                this.#read(this.#u32(a0), kindLength),
              );
              const mediaType = strictDecoder.decode(
                this.#read(this.#u32(a2), mediaTypeLength),
              );
              result = this.#registerMediatedInput(
                kind,
                mediaType,
                this.#u32(a4),
              );
            } catch {
              result = -1;
            }
          }
          this.#setReg(7, BigInt(result));
          return false;
        }
        case "host_file_register": {
          const length = this.#u32(a1);
          let result = -1;
          if (length <= MAX_FILE_DESCRIPTOR_BYTES) {
            this.#chargeBytes(length);
            let bytes = null;
            try {
              bytes = this.#range(this.#u32(a0), length).slice();
            } catch {}
            if (bytes !== null) {
              result = this.#registerFile(bytes);
            }
          }
          this.#setReg(7, BigInt(result));
          return false;
        }
        case "host_file_info": {
          const registration = this.mediatedInputRegistrations.get(
            this.#u32(a0),
          );
          if (!registration?.descriptor) {
            this.#setReg(7, BigInt(FILE_INFO_INVALID));
            return false;
          }
          if (registration.file === null) {
            this.#setReg(7, 0n);
            return false;
          }
          const info = encodeFileInfo(registration.file);
          if (this.#u32(a2) < info.byteLength) {
            this.#setReg(7, BigInt(-info.byteLength));
            return false;
          }
          this.#chargeBytes(info.byteLength);
          let written = true;
          try {
            this.#range(this.#u32(a1), info.byteLength, true).set(info);
          } catch {
            written = false;
          }
          this.#setReg(7, BigInt(written ? info.byteLength : FILE_INFO_INVALID));
          return false;
        }
        case "host_file_read": {
          this.#setReg(
            7,
            BigInt(this.#readFileStream(
              this.#u32(a0), this.#u32(a1), this.#u32(a2), this.#u32(a3),
            )),
          );
          return false;
        }
        case "host_file_cache_reset":
          this.#setReg(7, BigInt(this.#resetFileCache(this.#u32(a0), this.#u32(a1))));
          return false;
        case "host_file_cache_write":
          this.#setReg(7, BigInt(this.#writeFileCache(
            this.#u32(a0), this.#u32(a1), this.#u32(a2), this.#u32(a3),
          )));
          return false;
        case "host_file_cache_commit":
          this.#setReg(7, BigInt(this.#commitFileCache(this.#u32(a0))));
          return false;
        case "host_file_cache_read":
          this.#setReg(7, BigInt(this.#readFileCache(
            this.#u32(a0), this.#u32(a1), this.#u32(a2), this.#u32(a3),
          )));
          return false;
        case "host_input_trigger": {
          this.#setReg(
            7,
            BigInt(this.#triggerMediatedInput(this.#u32(a0))),
          );
          return false;
        }
        case "host_input_status": {
          const registration = this.mediatedInputRegistrations.get(
            this.#u32(a0),
          );
          this.#setReg(7, BigInt(registration?.status ?? 0));
          return false;
        }
        case "host_input_read": {
          const registration = this.mediatedInputRegistrations.get(
            this.#u32(a0),
          );
          if (
            registration?.status === MEDIATED_INPUT_STATUS_READY &&
            registration.result === null &&
            registration.descriptor?.delivery === "relaunch" &&
            registration.file !== null
          ) {
            // A mounted relaunch file is an asset; reading acknowledges it.
            registration.status = MEDIATED_INPUT_STATUS_REGISTERED;
            registration.file = null;
            this.#setReg(7, 0n);
            return false;
          }
          if (
            !registration ||
            registration.status !== MEDIATED_INPUT_STATUS_READY ||
            !(registration.result instanceof Uint8Array)
          ) {
            this.#setReg(7, 0n);
            return false;
          }
          const required = registration.result.byteLength;
          if (this.#u32(a2) < required) {
            this.#setReg(7, BigInt(-required));
            return false;
          }
          this.#chargeBytes(required);
          if (required !== 0) {
            try {
              this.#range(this.#u32(a1), required, true).set(registration.result);
            } catch {
              this.#setReg(7, -1n);
              return false;
            }
          }
          registration.result = null;
          if (registration.descriptor?.delivery !== "stream") {
            registration.file = null;
            registration.status = MEDIATED_INPUT_STATUS_REGISTERED;
          }
          this.#setReg(7, BigInt(required));
          return false;
        }
        case "host_input_cancel": {
          this.#setReg(
            7,
            BigInt(this.#cancelMediatedInput(this.#u32(a0))),
          );
          return false;
        }
        case UPDATE_AFTER_IMPORT: {
          const delayMs = this.#u32(a0);
          this.updateAfterMs =
            this.updateAfterMs === null
              ? delayMs
              : Math.min(this.updateAfterMs, delayMs);
          return false;
        }
        case "polkadot_host_0_1_core_clock_monotonic": {
          this.#chargeBytes(8);
          const timeMs =
            this.timeMs ?? performance.now() - this.clockStartedAt;
          this.#writeU64(
            this.#u32(a0),
            BigInt(Math.max(0, Math.trunc(timeMs * 1_000_000))),
          );
          this.#setReg(7, 0n);
          return false;
        }
        case "polkadot_host_0_1_core_clock_wall":
          this.#chargeBytes(8);
          this.#writeU64(this.#u32(a0), BigInt(Date.now()) * 1_000_000n);
          this.#setReg(7, 0n);
          return false;
        case "polkadot_host_0_1_core_random": {
          const length = this.#u32(a1);
          if (length === 0) {
            this.#setReg(7, BigInt(CORE_STATUS_INVALID));
            return false;
          }
          if (length > MAX_CORE_RANDOM_BYTES) {
            this.#setReg(7, BigInt(CORE_STATUS_LIMIT));
            return false;
          }
          this.#chargeBytes(length);
          let bytes;
          try {
            const browserCrypto = globalThis.crypto;
            if (typeof browserCrypto?.getRandomValues !== "function") {
              this.#setReg(7, BigInt(CORE_STATUS_DENIED));
              return false;
            }
            bytes = new Uint8Array(length);
            browserCrypto.getRandomValues(bytes);
          } catch {
            this.#setReg(7, BigInt(CORE_STATUS_DENIED));
            return false;
          }
          this.#range(this.#u32(a0), length, true).set(bytes);
          this.#setReg(7, 0n);
          return false;
        }
        case "host_time_ms": {
          const timeMs = this.timeMs ?? performance.now() - this.clockStartedAt;
          this.#setU64Result(BigInt(Math.max(0, Math.trunc(timeMs))));
          return false;
        }
        case "host_random_fill": {
          const length = this.#u32(a1);
          const end = this.randomOffset + length;
          if (
            !length ||
            length > MAX_RANDOM_BYTES_PER_CALL ||
            end > this.randomBytes.byteLength
          ) {
            this.#setReg(7, 1n);
            return false;
          }
          this.#chargeBytes(length);
          this.#write(
            this.#u32(a0),
            this.randomBytes.subarray(this.randomOffset, end),
          );
          this.randomOffset = end;
          this.#setReg(7, 0n);
          return false;
        }
        case "host_sleep_ms":
          this.timeMs =
            (this.timeMs ?? performance.now() - this.clockStartedAt) +
            Math.min(this.#u32(a0), 50);
          return false;
        case "host_audio_submit": {
          if (!this.audioEnabled) {
            this.#setReg(7, 3n);
            return false;
          }
          const sampleCount = this.#u32(a1);
          if (
            !sampleCount ||
            sampleCount % 2 ||
            sampleCount > MAX_AUDIO_SAMPLES
          ) {
            this.#setReg(7, 1n);
            return false;
          }
          const samples = this.#read(this.#u32(a0), sampleCount * 2);
          this.emit(
            { type: "audio", sampleRate: 48000, channels: 2, samples },
            [samples.buffer],
          );
          this.#setReg(7, 0n);
          return false;
        }
        case "host_frame_send": {
          const length = this.#u32(a1);
          if (!length || length > MAX_HOST_FRAME_BYTES) {
            this.#setReg(7, 1n);
            return false;
          }
          if (
            this.hostFrameRequests === MAX_HOST_FRAMES ||
            this.hostFrameRequestBytes + length > MAX_QUEUED_HOST_FRAME_BYTES
          ) {
            this.#setReg(7, 2n);
            return false;
          }
          const bytes = this.#read(this.#u32(a0), length);
          this.emit({ type: "host-frame-request", bytes }, [bytes.buffer]);
          this.hostFrameRequests++;
          this.hostFrameRequestBytes += length;
          this.#setReg(7, 0n);
          return false;
        }
        case "host_frame_poll": {
          const response = this.hostFrameResponses[0];
          if (response === undefined) {
            this.#setReg(7, 0n);
            return false;
          }
          const capacity = this.#u32(a1);
          if (capacity < response.byteLength) {
            this.#setReg(7, BigInt(-response.byteLength));
            return false;
          }
          this.#write(this.#u32(a0), response);
          this.hostFrameResponses.shift();
          this.hostFrameResponseBytes -= response.byteLength;
          this.#setReg(7, BigInt(response.byteLength));
          return false;
        }
        case "host_asset_read": {
          const nameLength = this.#u32(a1);
          const offset = this.#u32(a2);
          const destination = this.#u32(a3);
          const capacity = this.#u32(a4);
          if (!nameLength || nameLength > 1024) {
            this.#setReg(7, 0n);
            return false;
          }
          const assetName = decoder.decode(
            this.#read(this.#u32(a0), nameLength),
          );
          const asset = this.assets.get(assetName);
          if (!asset || offset >= asset.byteLength) {
            this.#setReg(7, 0n);
            return false;
          }
          const length = Math.min(
            capacity,
            asset.byteLength - offset,
            16 * 1024 * 1024,
          );
          this.#write(destination, asset.subarray(offset, offset + length));
          this.#setReg(7, BigInt(length));
          return false;
        }
        case "host_save_submit": {
          const length = this.#u32(a1);
          if (!length || length > MAX_SAVE_BYTES) {
            this.#setReg(7, 1n);
            return false;
          }
          const bytes = this.#read(this.#u32(a0), length);
          this.emit({ type: "save", bytes }, [bytes.buffer]);
          this.#setReg(7, 0n);
          return false;
        }
        case "host_log": {
          const length = Math.min(this.#u32(a1), MAX_LOG_BYTES);
          const message = decoder.decode(this.#read(this.#u32(a0), length));
          this.emit({ type: "log", message });
          return false;
        }
        default:
          throw new Error(
            `translated PolkaVM guest uses unsupported import ${name}`,
          );
      }
    }

    #gpuBatchSequence(bytes) {
      if (
        bytes.byteLength < 24 ||
        decoder.decode(bytes.subarray(0, 4)) !== "EPG1"
      ) {
        return null;
      }
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      if (
        view.getUint16(4, true) !== 1 ||
        view.getUint16(6, true) !== 0 ||
        view.getUint32(8, true) !== bytes.byteLength
      ) {
        return null;
      }
      const commandCount = view.getUint32(12, true);
      const sequence = view.getBigUint64(16, true);
      if (sequence === 0n || commandCount > MAX_GPU_COMMANDS) {
        return null;
      }
      let offset = 24;
      for (let index = 0; index < commandCount; index++) {
        if (
          offset + 8 > bytes.byteLength ||
          view.getUint16(offset + 2, true) !== 0
        ) {
          return null;
        }
        const commandBytes = view.getUint32(offset + 4, true);
        if (
          commandBytes < 8 ||
          commandBytes % 4 ||
          commandBytes > bytes.byteLength - offset
        ) {
          return null;
        }
        offset += commandBytes;
      }
      return offset === bytes.byteLength ? sequence : null;
    }

    #gpuBatchUsesCompute(bytes) {
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      const commandCount = view.getUint32(12, true);
      let offset = 24;
      for (let index = 0; index < commandCount; index++) {
        if (isComputeOpcode(view.getUint16(offset, true))) {
          return true;
        }
        offset += view.getUint32(offset + 4, true);
      }
      return false;
    }

    #setupCoreVm() {
      let sp = BigInt(this.metadata.layout.stackHigh);
      const argc = 1n;
      sp -= (1n + argc + 1n + 0n + 1n + 4n) * 8n;
      const addressInit = sp;
      let pointer = sp;
      this.#writeU64(Number(pointer), argc);
      pointer += 8n;
      const argument = encoder.encode("./quake\0");
      sp -= BigInt(argument.byteLength);
      this.#write(Number(sp), argument);
      this.#writeU64(Number(pointer), sp);
      pointer += 16n;
      pointer += 8n;
      this.#writeU64(Number(pointer), 6n);
      this.#writeU64(Number(pointer + 8n), 4096n);
      this.#setReg(1, sp);
      this.#setReg(7, addressInit);
    }

    #readMotion() {
      if (this.motionAvailability === MOTION_STATUS_UNAVAILABLE) {
        this.#setReg(7, BigInt(MOTION_ERROR_UNAVAILABLE));
        return false;
      }
      if (this.motionAvailability === MOTION_STATUS_PERMISSION_DENIED) {
        this.#setReg(7, BigInt(MOTION_ERROR_PERMISSION_DENIED));
        return false;
      }
      if (this.motionSample === null) {
        this.#setReg(7, 0n);
        return false;
      }
      if (this.#u32(this.#reg(8)) < MOTION_SAMPLE_BYTES) {
        this.#setReg(7, BigInt(MOTION_ERROR_BUFFER_TOO_SMALL));
        return false;
      }
      try {
        this.#write(this.#u32(this.#reg(7)), this.motionSample);
      } catch {
        this.#setReg(7, BigInt(MOTION_ERROR_INVALID_GUEST_RANGE));
        return false;
      }
      this.motionSample = null;
      this.#setReg(7, BigInt(MOTION_SAMPLE_BYTES));
      return false;
    }

    #queueEpocaInput(bytes) {
      const event = bytes.slice();
      if (event[0] === 5 || event[0] === 6) {
        const existing = this.epocaInput.findIndex(
          (queued) => queued[0] === event[0],
        );
        if (existing !== -1) {
          this.epocaInput[existing] = event;
          return;
        }
      }
      if (this.epocaInput.length === 256) {
        this.epocaInput.shift();
      }
      this.epocaInput.push(event);
    }

    #queueCoreInput(key, value) {
      if (!value && (key === 0xa3 || key === 0xa4)) {
        return;
      }
      if (key === 0xa3 || key === 0xa4) {
        const existing = this.coreInput.find((event) => event[0] === key);
        if (existing) {
          existing[1] = value;
          return;
        }
      }
      if (this.coreInput.length === 256) {
        this.coreInput.shift();
      }
      this.coreInput.push([key, value]);
    }

    // eslint-disable-next-line complexity -- Flat hostcall dispatch mirrors the guest ABI.
    #handleCoreVmCall(name) {
      switch (name) {
        case "host_frame_send":
        case "host_frame_poll":
        case "host_motion_read":
        case POINTER_CAPTURE_IMPORT:
        case "polkadot_host_0_1_core_clock_monotonic":
        case "polkadot_host_0_1_core_clock_wall":
        case "polkadot_host_0_1_core_random":
        case UPDATE_AFTER_IMPORT:
          return this.#handleCooperativeCall(name);
        case "pvm_set_palette": {
          const palette = this.#read(this.#u32(this.#reg(7)), 256 * 3);
          for (let index = 0; index < 256; index++) {
            const offset = index * 3;
            this.palette[index] =
              palette[offset] |
              (palette[offset + 1] << 8) |
              (palette[offset + 2] << 16) |
              0xff000000;
          }
          return false;
        }
        case "pvm_display": {
          const width = this.#u32(this.#reg(7));
          const height = this.#u32(this.#reg(8));
          const length = width * height;
          if (!width || !height || length > MAX_FRAME_BYTES / 4) {
            throw new Error("CoreVM guest supplied invalid frame dimensions");
          }
          const indices = this.#read(this.#u32(this.#reg(9)), length);
          const pixels = new Uint8Array(length * 4);
          const rgba = new Uint32Array(pixels.buffer);
          for (let index = 0; index < length; index++) {
            rgba[index] = this.palette[indices[index]];
          }
          this.emit({ type: "frame", width, height, pixels }, [pixels.buffer]);
          return true;
        }
        case "pvm_fetch_epoca_inputs": {
          const count = Math.min(
            this.#u32(this.#reg(8)),
            this.epocaInput.length,
          );
          const output = new Uint8Array(count * INPUT_EVENT_BYTES);
          for (let index = 0; index < count; index++) {
            output.set(this.epocaInput.shift(), index * INPUT_EVENT_BYTES);
          }
          this.#write(this.#u32(this.#reg(7)), output);
          this.#setReg(7, BigInt(count));
          return false;
        }
        case "pvm_fetch_inputs": {
          const count = Math.min(
            this.#u32(this.#reg(8)),
            this.coreInput.length,
          );
          const output = new Uint8Array(count * 2);
          for (let index = 0; index < count; index++) {
            output.set(this.coreInput.shift(), index * 2);
          }
          this.#write(this.#u32(this.#reg(7)), output);
          this.#setReg(7, BigInt(count));
          return false;
        }
        case "pvm_asset_read": {
          const nameLength = this.#u32(this.#reg(8));
          const offset = this.#u32(this.#reg(9));
          const destination = this.#u32(this.#reg(10));
          const capacity = this.#u32(this.#reg(11));
          if (!nameLength || nameLength > 1024) {
            this.#setReg(7, 0n);
            return false;
          }
          const assetName = decoder.decode(
            this.#read(this.#u32(this.#reg(7)), nameLength),
          );
          const asset = this.assets.get(assetName);
          if (!asset || offset >= asset.byteLength) {
            this.#setReg(7, 0n);
            return false;
          }
          const length = Math.min(
            capacity,
            asset.byteLength - offset,
            16 * 1024 * 1024,
          );
          this.#write(destination, asset.subarray(offset, offset + length));
          this.#setReg(7, BigInt(length));
          return false;
        }
        case "host_audio_submit": {
          if (!this.audioEnabled) {
            this.#setReg(7, 3n);
            return false;
          }
          const sampleCount = this.#u32(this.#reg(8));
          if (
            !sampleCount ||
            sampleCount % 2 ||
            sampleCount > MAX_AUDIO_SAMPLES
          ) {
            this.#setReg(7, 1n);
            return false;
          }
          const samples = this.#read(this.#u32(this.#reg(7)), sampleCount * 2);
          this.emit(
            { type: "audio", sampleRate: 48000, channels: 2, samples },
            [samples.buffer],
          );
          this.#setReg(7, 0n);
          return false;
        }
        case "pvm_time_ms": {
          const timeMs = this.timeMs ?? performance.now() - this.clockStartedAt;
          this.#setU64Result(BigInt(Math.max(0, Math.trunc(timeMs))));
          return false;
        }
        case "host_log": {
          const length = Math.min(this.#u32(this.#reg(8)), MAX_LOG_BYTES);
          const message = decoder.decode(
            this.#read(this.#u32(this.#reg(7)), length),
          );
          this.emit({ type: "log", message });
          return false;
        }
        case "pvm_yield":
          return true;
        case "pvm_init_audio": {
          const channels = this.#u32(this.#reg(7));
          const bitsPerSample = this.#u32(this.#reg(8));
          const sampleRate = this.#u32(this.#reg(9));
          if (
            bitsPerSample !== 16 ||
            channels < 1 ||
            channels > 2 ||
            sampleRate < 8000 ||
            sampleRate > 96000
          ) {
            this.#setReg(7, 0n);
          } else {
            this.audioChannels = channels;
            this.audioSampleRate = sampleRate;
            this.#setReg(7, 1n);
          }
          return false;
        }
        case "pvm_output_audio": {
          const frames = this.#u32(this.#reg(8));
          const sampleCount = Math.min(frames * this.audioChannels, 1024 * 64);
          if (this.audioChannels && sampleCount) {
            const samples = this.#read(
              this.#u32(this.#reg(7)),
              sampleCount * 2,
            );
            this.emit(
              {
                type: "audio",
                sampleRate: this.audioSampleRate,
                channels: this.audioChannels,
                samples,
              },
              [samples.buffer],
            );
          }
          return false;
        }
        case "pvm_syscall":
          return this.#handleCoreVmSyscall();
        default:
          throw new Error(
            `translated CoreVM guest uses unsupported import ${name}`,
          );
      }
    }

    #handleCoreVmSyscall() {
      const syscall = this.#reg(7);
      const a1 = this.#reg(8);
      const a2 = this.#reg(9);
      const a3 = this.#reg(10);
      if (syscall === SYS_READ) {
        this.#setReg(7, this.#readFile(a1, a2, a3));
      } else if (syscall === SYS_READV || syscall === SYS_WRITEV) {
        if (!a3 || a3 > IOV_MAX) {
          this.#setReg(7, errno(EINVAL));
          return false;
        }
        let total = 0n;
        for (let index = 0n; index < a3; index++) {
          let address;
          let length;
          try {
            address = this.#readU64(this.#u32(a2 + index * 16n));
            length = this.#readU64(this.#u32(a2 + index * 16n + 8n));
          } catch {
            this.#setReg(7, total || errno(EFAULT));
            return false;
          }
          const result =
            syscall === SYS_READV
              ? this.#readFile(a1, address, length)
              : this.#writeFile(a1, address, length);
          if (BigInt.asIntN(64, result) < 0n) {
            this.#setReg(7, total || result);
            return false;
          }
          total += result;
          if (result < length) break;
        }
        this.#setReg(7, total);
      } else if (syscall === SYS_EXIT) {
        if (a1 === 0n) {
          throw new Error("CoreVM guest exited");
        }
        throw new Error(`CoreVM guest exited with status ${a1}`);
      } else if (syscall === SYS_OPENAT) {
        if (a1 !== AT_FDCWD) {
          this.#setReg(7, errno(ENOSYS));
          return false;
        }
        const pathBytes = this.#readCString(this.#u32(a2));
        if (!pathBytes) {
          this.#setReg(7, errno(EFAULT));
          return false;
        }
        const path = normalizedPath(decoder.decode(pathBytes));
        const flags = a3;
        const asset = this.assets.get(path);
        if (!asset) {
          this.#setReg(7, errno(ENOENT));
        } else if (flags & 3n) {
          this.#setReg(7, errno(EACCES));
        } else {
          const fd = this.nextFd++;
          this.fds.set(fd, { bytes: asset, position: 0n });
          this.#setReg(7, BigInt(fd));
        }
      } else if (syscall === SYS_LSEEK) {
        this.#setReg(7, this.#seekFile(a1, a2, a3));
      } else if (syscall === SYS_CLOSE) {
        const fd = this.#fdNumber(a1);
        if (fd === null || !this.fds.delete(fd)) {
          this.#setReg(7, errno(EBADF));
        } else {
          this.#setReg(7, 0n);
        }
      } else {
        this.#setReg(7, errno(ENOSYS));
      }
      return false;
    }

    #fdNumber(value) {
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
    }

    #readFile(fdValue, address, length) {
      const fd = this.#fdNumber(fdValue);
      const file = fd === null ? null : this.fds.get(fd);
      if (!file) {
        return errno(EBADF);
      }
      if (
        address + length > 0x100000000n ||
        length > BigInt(MAX_HOSTCALL_BYTES)
      ) {
        return errno(EFAULT);
      }
      const end =
        file.position + length < BigInt(file.bytes.byteLength)
          ? file.position + length
          : BigInt(file.bytes.byteLength);
      if (file.position >= end) {
        return 0n;
      }
      const count = Number(end - file.position);
      try {
        this.#write(
          this.#u32(address),
          file.bytes.subarray(
            Number(file.position),
            Number(file.position) + count,
          ),
        );
      } catch {
        return errno(EFAULT);
      }
      file.position += BigInt(count);
      return BigInt(count);
    }

    #writeFile(fdValue, address, length) {
      if (fdValue !== 1n && fdValue !== 2n) {
        return errno(EBADF);
      }
      if (
        address + length > 0x100000000n ||
        length > BigInt(MAX_HOSTCALL_BYTES)
      ) {
        return errno(EFAULT);
      }
      try {
        const byteLength = Number(length);
        this.#chargeBytes(byteLength);
        const bytes = this.#range(this.#u32(address), byteLength);
        const message = decoder.decode(bytes.subarray(0, MAX_LOG_BYTES));
        if (message) {
          this.emit({ type: "log", message });
        }
      } catch {
        return errno(EFAULT);
      }
      return length;
    }

    #seekFile(fdValue, offsetValue, whence) {
      const fd = this.#fdNumber(fdValue);
      const file = fd === null ? null : this.fds.get(fd);
      if (!file) {
        return errno(EBADF);
      }
      const offset = BigInt.asIntN(64, offsetValue);
      const fileLength = BigInt(file.bytes.byteLength);
      if (whence === 0n) {
        file.position = BigInt.asUintN(64, offset);
      } else if (whence === 1n) {
        file.position = BigInt.asUintN(
          64,
          BigInt.asIntN(64, file.position) + offset,
        );
        if (file.position > fileLength) {
          file.position = fileLength;
        }
      } else if (whence === 2n) {
        file.position = BigInt.asUintN(
          64,
          BigInt.asIntN(64, fileLength) + offset,
        );
        if (file.position > fileLength) {
          file.position = fileLength;
        }
      } else {
        return errno(EINVAL);
      }
      return file.position;
    }
  }

  globalThis.decodePolkaVmUiOutput = decodeUiOutput;
  globalThis.TranslatedPolkaVmRuntime = TranslatedPolkaVmRuntime;
})();

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Creates the bounded PolkaVM endpoint in a Worker or on a host thread.
 *
 * @param {DedicatedWorkerGlobalScope} endpoint - Message endpoint owned by the runtime.
 * @param {{createFileCache?: Function}} [options] - Trusted Host storage, never guest-controlled.
 */
globalThis.createPolkaVmRuntime = (endpoint, options = {}) => {
  const postMessage = (message, transfers) => {
    if (transfers) {
      endpoint.postMessage(message, transfers);
    } else {
      endpoint.postMessage(message);
    }
  };

  const LEGACY_FRAME_INTERVAL_MS = 1000 / 60;
  const MAX_GAS_PER_UPDATE = 10_000_000_000;
  const MAX_TRANSLATED_LOOPS_PER_UPDATE = 50_000_000;
  const MAX_PROGRAM_BYTES = 64 * 1024 * 1024;
  const MAX_ASSET_FILES = 2048;
  const MAX_ASSET_NAME_BYTES = 1024;
  const MAX_ASSET_FILE_BYTES = 128 * 1024 * 1024;
  const MAX_ASSET_BYTES = 256 * 1024 * 1024;
  const MOTION_SAMPLE_BYTES = 48;
  const MAX_MEDIATED_INPUT_KIND_BYTES = 32;
  const MAX_MEDIATED_INPUT_REGISTRATIONS = 8;
  const MAX_RELAUNCH_FILE_BYTES = 128 * 1024 * 1024;
  const MAX_STREAM_FILE_BYTES = 0xffffffff;
  const MAX_FILE_READ_BYTES = 65536;
  const MAX_FILE_CACHE_BYTES = 512 * 1024 * 1024;
  const FILE_INPUT_OUTCOMES = ["ready", "error", "", "rejected", "refused", "relaunch"];
  const RANDOM_BYTES_PER_EXECUTION = 64 * 1024;
  // Safe-area (16) and virtual-keyboard (17) inset records. Both records of one
  // update carry a single axis, so a Host sends them through the dedicated
  // `view-insets` message that queues the pair together; the runtime rejects a
  // lone axis arriving as an ordinary input record.
  const INPUT_SAFE_AREA_INSETS = 16;
  const INPUT_KEYBOARD_INSETS = 17;
  const MAX_INSET_PIXELS = 65535;
  const UPDATE_AFTER_IDLE = 0xffffffff;
  // Match the bounded host-response queue without requiring a new Wasm ABI.
  const MAX_BACKGROUND_SERVICE_TICKS = 32;
  const MAX_BACKGROUND_CONTINUATION_TICKS = 32;
  const FORCE_INTERPRETER = Symbol("force-interpreter");
  const CORE_STATUS_DENIED = -5;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  function executionRandomBytes() {
    const bytes = new Uint8Array(RANDOM_BYTES_PER_EXECUTION);
    const browserCrypto = globalThis.crypto;
    if (typeof browserCrypto?.getRandomValues !== "function") {
      return new Uint8Array();
    }
    try {
      browserCrypto.getRandomValues(bytes);
      return bytes;
    } catch {
      return new Uint8Array();
    }
  }

  let pvm;
  let translated;
  let backend = "interpreter";
  let running = false;
  let disposed = false;
  let starting = false;
  let paused = false;
  let backgrounded = false;
  let inactiveAt = 0;
  let backgroundServiceTicks = 0;
  let backgroundContinuationTicks = 0;
  let pendingFrame = null;
  let demandDriven = false;
  let tickPending = false;
  let motionAvailability = 0;
  let pendingMotionSample = null;
  let pointerCaptureSupported = false;
  let pendingGpuCapabilities = null;
  let timer;
  let startedAt = 0;
  let legacyNextUpdateAt = 0;
  let updateCount = 0;
  const updateSamples = [];
  const activeMediatedInputHandles = new Set();
  let activeMediatedInputRequest = null;
  const streamFiles = new Map();
  let lastFileSourceToken = 0;
  let fileReader;
  let fileCacheEnabled = false;
  // Include retired caches until their private storage has actually been deleted.
  let reservedFileCacheBytes = 0;
  let termination;
  let cleanupFailed = false;
  const pendingSelections = new Map();
  const pendingCleanups = new Set();
  const createFileCache = options.createFileCache === undefined
    ? createOpfsFileCache
    : options.createFileCache;
  if (typeof createFileCache !== "function") {
    throw new TypeError("invalid PolkaVM browser cache factory");
  }
  // The newest registration snapshot a Host has not received yet. It is
  // flushed on teardown so a Host keeps the registrations of an execution
  // that failed before becoming ready.
  let unpostedFileRegistrations = null;
  const heldInputs = new Map();
  const tickChannel = new MessageChannel();
  tickChannel.port1.onmessage = () => {
    tickPending = false;
    tick();
  };

  function reportCleanupFailure(error) {
    cleanupFailed = true;
    postMessage({
      type: "error",
      fatal: false,
      message: `PolkaVM private cache cleanup failed: ${error?.message ?? error}`,
    });
  }

  function trackCleanup(closing) {
    if (closing?.then) {
      const pending = Promise.resolve(closing).then((result) => {
        cleanupFailed ||= result?.cleanupFailed === true;
      }).catch(reportCleanupFailure);
      pendingCleanups.add(pending);
      void pending.then(() => pendingCleanups.delete(pending));
      return pending;
    }
  }

  function closeCache(cache, reservedBytes = 0) {
    try {
      const closing = cache.close();
      if (closing?.then) {
        return trackCleanup(Promise.resolve(closing).then(() => {
          reservedFileCacheBytes -= reservedBytes;
        }));
      }
      reservedFileCacheBytes -= reservedBytes;
    } catch (error) {
      reportCleanupFailure(error);
    }
  }

  function invalidateSelection(handle) {
    const pending = pendingSelections.get(handle);
    if (pending) {
      pending.valid = false;
    }
  }

  function stopRuntime() {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const pending of pendingSelections.values()) {
      pending.valid = false;
    }
    if (unpostedFileRegistrations !== null) {
      postMessage(unpostedFileRegistrations);
      unpostedFileRegistrations = null;
    }
    for (const handle of activeMediatedInputHandles) {
      postMessage({ type: "mediated-input-cancel", handle });
    }
    activeMediatedInputHandles.clear();
    running = false;
    heldInputs.clear();
    pendingFrame = null;
    backgroundServiceTicks = 0;
    backgroundContinuationTicks = 0;
    clearTimeout(timer);
    try {
      trackCleanup(translated?.stop());
      pvm?.polkavm_browser_reset?.();
    } catch (error) {
      reportCleanupFailure(error);
    }
    for (const entry of streamFiles.values()) {
      entry.source?.close();
      entry.cache?.close();
    }
    tickChannel.port1.close();
    tickChannel.port2.close();
    endpoint.onmessage = null;
  }

  function terminate(error) {
    if (error) {
      postMessage({ type: "error", message: error.message });
    }
    stopRuntime();
    termination ??= (async () => {
      await Promise.all([...pendingSelections.values()].map((entry) => entry.promise));
      while (pendingCleanups.size) {
        await Promise.all([...pendingCleanups]);
      }
      postMessage({ type: "terminated", ...(cleanupFailed ? { cleanupFailed: true } : {}) });
    })();
    return termination;
  }

  function postRuntimeOutput(output, transfers = []) {
    if (disposed) {
      return;
    }
    // The Host also clears already delivered audio when becoming inactive.
    if ((paused || backgrounded) && output?.type === "audio") {
      return;
    }
    if ((paused || backgrounded) && output?.type === "frame") {
      pendingFrame = { output, transfers };
      return;
    }
    // Tri2D streams contain retained texture mutations, not standalone
    // snapshots. The Host must process them in order and hide presentation.
    if (
      output?.type === "mediated-input-request" ||
      output?.type === "file-input-request"
    ) {
      invalidateSelection(output.handle);
      activeMediatedInputRequest = output.handle;
      activeMediatedInputHandles.add(output.handle);
    } else if (output?.type === "mediated-input-cancel") {
      if (activeMediatedInputRequest === output.handle) {
        activeMediatedInputRequest = null;
      }
      activeMediatedInputHandles.delete(output.handle);
      invalidateSelection(output.handle);
    } else if (output?.type === "file-registrations") {
      unpostedFileRegistrations = null;
    }
    postMessage(output, transfers);
  }

  async function createOpfsFileCache() {
    const directory = await navigator.storage.getDirectory();
    const name = `polkavm-cache-${crypto.randomUUID()}`;
    const file = await directory.getFileHandle(name, { create: true });
    let access;
    try {
      access = await file.createSyncAccessHandle();
    } catch (error) {
      try {
        await directory.removeEntry(name);
      } catch (cleanupError) {
        reportCleanupFailure(cleanupError);
      }
      throw error;
    }
    let staging;
    return {
      size: () => access.getSize(),
      reset(size) {
        access.truncate(0);
        access.truncate(size);
      },
      write: (offset, bytes) => access.write(bytes, { at: offset }),
      read(offset, length) {
        staging ??= new Uint8Array(MAX_FILE_READ_BYTES);
        const bytes = staging.subarray(0, length);
        const actual = access.read(bytes, { at: offset });
        return bytes.subarray(0, actual);
      },
      flush: () => access.flush(),
      async close() {
        try {
          access.close();
        } finally {
          await directory.removeEntry(name);
        }
      },
    };
  }

  function createFileSource(file, backendCache = null) {
    if (lastFileSourceToken === 0xffffffff) {
      backendCache && closeCache(backendCache);
      throw new Error("PolkaVM browser file source tokens exhausted");
    }
    const token = ++lastFileSourceToken;
    const entry = { source: null, cache: null };
    const removeIfClosed = () => {
      if (entry.source === null && entry.cache === null) {
        streamFiles.delete(token);
      }
    };
    const source = {
      read(offset, length) {
        if (
          disposed ||
          file === null ||
          !Number.isInteger(offset) ||
          !Number.isInteger(length) ||
          offset < 0 ||
          length < 0 ||
          length > MAX_FILE_READ_BYTES ||
          offset + length > file.size
        ) {
          throw new Error("invalid PolkaVM browser file range");
        }
        fileReader ??= new FileReaderSync();
        const bytes = new Uint8Array(
          fileReader.readAsArrayBuffer(file.slice(offset, offset + length)),
        );
        if (bytes.byteLength !== length) {
          throw new Error("short PolkaVM browser file read");
        }
        return bytes;
      },
      close() {
        file = null;
        entry.source = null;
        removeIfClosed();
      },
    };
    entry.source = source;
    if (backendCache !== null) {
      let reservedBytes = 0;
      const checkRange = (offset, length) => {
        if (disposed || entry.cache === null || !Number.isInteger(offset) ||
            !Number.isInteger(length) || offset < 0 || length < 1 ||
            length > MAX_FILE_READ_BYTES || offset + length > backendCache.size()) {
          throw new Error("invalid PolkaVM browser cache range");
        }
      };
      entry.cache = {
        size: () => backendCache.size(),
        reset(size) {
          if (disposed || entry.cache === null || !Number.isInteger(size) ||
              size < 1 || size > MAX_FILE_CACHE_BYTES ||
              reservedFileCacheBytes - reservedBytes + size > MAX_FILE_CACHE_BYTES) {
            throw new Error("invalid PolkaVM browser cache size");
          }
          // A failed resize may still have changed the underlying file. Keep
          // the larger reservation until successful cleanup in that case.
          const reservation = Math.max(reservedBytes, size);
          reservedFileCacheBytes += reservation - reservedBytes;
          reservedBytes = reservation;
          backendCache.reset(size);
          if (backendCache.size() !== size) {
            throw new Error("invalid PolkaVM browser cache size after reset");
          }
          reservedFileCacheBytes += size - reservedBytes;
          reservedBytes = size;
        },
        write(offset, bytes) {
          checkRange(offset, bytes.byteLength);
          const actual = backendCache.write(offset, bytes);
          if (actual !== bytes.byteLength) {
            throw new Error("short PolkaVM browser cache write");
          }
          return actual;
        },
        read(offset, length) {
          checkRange(offset, length);
          const bytes = backendCache.read(offset, length);
          if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
            throw new Error("short PolkaVM browser cache read");
          }
          return bytes;
        },
        flush() {
          if (disposed || entry.cache === null) {
            throw new Error("closed PolkaVM browser cache");
          }
          backendCache.flush();
        },
        close() {
          if (entry.cache !== null) {
            entry.cache = null;
            removeIfClosed();
            const closing = backendCache;
            backendCache = null;
            closeCache(closing, reservedBytes);
          }
        },
      };
    }
    streamFiles.set(token, entry);
    return { token, source, cache: entry.cache };
  }

  function wasmJson(pointer, length) {
    return JSON.parse(
      decoder.decode(new Uint8Array(pvm.memory.buffer, pointer, length)),
    );
  }

  function drainFileRegistrations() {
    if (!pvm.polkavm_browser_take_file_registrations?.()) {
      return;
    }
    postRuntimeOutput({
      type: "file-registrations",
      registrations: wasmJson(
        pvm.polkavm_browser_file_registrations_pointer(),
        pvm.polkavm_browser_file_registrations_length(),
      ),
    });
  }

  function errorText() {
    const pointer = pvm.polkavm_browser_error_pointer();
    const length = pvm.polkavm_browser_error_length();
    return decoder.decode(new Uint8Array(pvm.memory.buffer, pointer, length));
  }

  function check(status, operation) {
    if (status !== 0) {
      throw new Error(`${operation}: ${errorText()}`);
    }
  }

  function stage(bytes) {
    const source =
      bytes instanceof Uint8Array
        ? bytes
        : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pointer = pvm.polkavm_browser_staging_reserve(source.byteLength);
    if (!pointer) {
      throw new Error(`reserve browser runtime memory: ${errorText()}`);
    }
    new Uint8Array(pvm.memory.buffer, pointer, source.byteLength).set(source);
  }

  function addAsset(asset) {
    const path = encoder.encode(asset.path.replace(/^\/+/, ""));
    const bytes = new Uint8Array(asset.bytes);
    const packed = new Uint8Array(path.byteLength + bytes.byteLength);
    packed.set(path);
    packed.set(bytes, path.byteLength);
    stage(packed);
    check(
      pvm.polkavm_browser_launch_add_asset(path.byteLength),
      `mount browser asset ${asset.path}`,
    );
  }

  function drainFrame() {
    if (!pvm.polkavm_browser_take_frame()) {
      return;
    }
    const width = pvm.polkavm_browser_frame_width();
    const height = pvm.polkavm_browser_frame_height();
    const length = pvm.polkavm_browser_frame_length();
    const source = new Uint8Array(
      pvm.memory.buffer,
      pvm.polkavm_browser_frame_pointer(),
      length,
    );
    const pixels = new Uint8Array(length);
    for (let index = 0; index < length; index += 4) {
      pixels[index] = source[index + 2];
      pixels[index + 1] = source[index + 1];
      pixels[index + 2] = source[index];
      pixels[index + 3] = source[index + 3];
    }
    postRuntimeOutput({ type: "frame", width, height, pixels }, [pixels.buffer]);
  }

  function drainTri2d() {
    if (!pvm.polkavm_browser_take_tri2d?.()) {
      return;
    }
    const length = pvm.polkavm_browser_tri2d_length();
    const bytes = new Uint8Array(
      pvm.memory.buffer,
      pvm.polkavm_browser_tri2d_pointer(),
      length,
    ).slice();
    postMessage({ type: "tri2d", bytes }, [bytes.buffer]);
  }

  function drainUiSemantics() {
    if (!pvm.polkavm_browser_take_ui_semantics?.()) {
      return;
    }
    const length = pvm.polkavm_browser_ui_semantics_length();
    const bytes = new Uint8Array(
      pvm.memory.buffer,
      pvm.polkavm_browser_ui_semantics_pointer(),
      length,
    ).slice();
    postMessage({ type: "ui-semantics", bytes }, [bytes.buffer]);
  }

  function drainUiOutput() {
    if (!pvm.polkavm_browser_take_ui_output?.()) {
      return;
    }
    const length = pvm.polkavm_browser_ui_output_length();
    const bytes = new Uint8Array(
      pvm.memory.buffer,
      pvm.polkavm_browser_ui_output_pointer(),
      length,
    ).slice();
    const output = globalThis.decodePolkaVmUiOutput?.(bytes);
    if (output == null) {
      throw new Error("interpreter emitted invalid UI output");
    }
    postMessage({ type: "ui-output", output });
  }

  function drainGpuBatches() {
    while (pvm.polkavm_browser_take_gpu_batch?.()) {
      const length = pvm.polkavm_browser_gpu_batch_length();
      const bytes = new Uint8Array(
        pvm.memory.buffer,
        pvm.polkavm_browser_gpu_batch_pointer(),
        length,
      ).slice();
      postMessage({ type: "gpu-batch", bytes }, [bytes.buffer]);
    }
  }

  function drainHostFrameRequests() {
    while (pvm.polkavm_browser_take_host_frame_request?.()) {
      const length = pvm.polkavm_browser_host_frame_request_length();
      const bytes = new Uint8Array(
        pvm.memory.buffer,
        pvm.polkavm_browser_host_frame_request_pointer(),
        length,
      ).slice();
      postMessage({ type: "host-frame-request", bytes }, [bytes.buffer]);
    }
  }

  function drainMediatedInputCommands() {
    while (true) {
      const operation = pvm.polkavm_browser_take_mediated_input_command?.() ?? 0;
      if (operation === 0) {
        return;
      }
      const handle = pvm.polkavm_browser_mediated_input_handle();
      if (operation === 2) {
        postRuntimeOutput({ type: "mediated-input-cancel", handle });
        continue;
      }
      if (operation === 3) {
        postRuntimeOutput({
          type: "file-input-request",
          handle,
          descriptor: wasmJson(
            pvm.polkavm_browser_mediated_input_descriptor_pointer(),
            pvm.polkavm_browser_mediated_input_descriptor_length(),
          ),
        });
        continue;
      }
      if (operation !== 1) {
        throw new Error("interpreter emitted an invalid mediated-input command");
      }
      const kind = decoder.decode(
        new Uint8Array(
          pvm.memory.buffer,
          pvm.polkavm_browser_mediated_input_kind_pointer(),
          pvm.polkavm_browser_mediated_input_kind_length(),
        ),
      );
      const mediaType = decoder.decode(
        new Uint8Array(
          pvm.memory.buffer,
          pvm.polkavm_browser_mediated_input_media_type_pointer(),
          pvm.polkavm_browser_mediated_input_media_type_length(),
        ),
      );
      postRuntimeOutput({
        type: "mediated-input-request",
        handle,
        kind,
        mediaType,
        maxBytes: pvm.polkavm_browser_mediated_input_max_bytes(),
      });
    }
  }

  function drainAudio() {
    while (pvm.polkavm_browser_take_audio()) {
      if (paused || backgrounded) {
        continue;
      }
      const sampleRate = pvm.polkavm_browser_audio_sample_rate();
      const channels = pvm.polkavm_browser_audio_channels();
      const length = pvm.polkavm_browser_audio_length() * 2;
      const samples = new Uint8Array(
        pvm.memory.buffer,
        pvm.polkavm_browser_audio_pointer(),
        length,
      ).slice();
      postMessage({ type: "audio", sampleRate, channels, samples }, [
        samples.buffer,
      ]);
    }
  }

  function drainSave() {
    while (pvm.polkavm_browser_take_save()) {
      const length = pvm.polkavm_browser_save_length();
      const bytes = new Uint8Array(
        pvm.memory.buffer,
        pvm.polkavm_browser_save_pointer(),
        length,
      ).slice();
      postMessage({ type: "save", bytes }, [bytes.buffer]);
    }
  }

  function drainLogs() {
    while (pvm.polkavm_browser_take_log()) {
      const pointer = pvm.polkavm_browser_log_pointer();
      const length = pvm.polkavm_browser_log_length();
      const message = decoder.decode(
        new Uint8Array(pvm.memory.buffer, pointer, length),
      );
      postMessage({ type: "log", message });
    }
  }

  function drainPointerCapture() {
    let request = null;
    if (translated) {
      request = translated.takePointerCaptureRequest();
    } else {
      const code = pvm.polkavm_browser_take_pointer_capture_request();
      if (code === 1) {
        request = true;
      } else if (code === 2) {
        request = false;
      }
    }
    if (request === null) {
      return;
    }
    postMessage({ type: "pointer-capture", capture: request });
  }

  function pendingHostFrameResponses() {
    return translated
      ? translated.pendingHostFrameResponses()
      : pvm.polkavm_browser_pending_host_frame_responses();
  }

  function hasBackgroundWork() {
    // Only cooperative hostcall-budget yields are continuations. CoreVM's
    // frame yield is an update boundary, never a reason for an idle spin.
    if (translated?.hasPendingContinuation()) {
      return backgroundContinuationTicks > 0;
    }
    return backgroundServiceTicks > 0 && pendingHostFrameResponses() > 0;
  }

  function scheduleTick(delayMs) {
    if (!running || paused || (backgrounded && !hasBackgroundWork())) {
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    if (delayMs <= 0) {
      if (!tickPending) {
        tickPending = true;
        tickChannel.port2.postMessage(null);
      }
      return;
    }
    if (tickPending) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (!running || paused || backgrounded || tickPending) {
        return;
      }
      tickPending = true;
      tickChannel.port2.postMessage(null);
    }, delayMs);
  }

  function wake() {
    if (demandDriven && !backgrounded) {
      scheduleTick(0);
    }
  }

  function wakeHostResponse(accepted) {
    // A full queue must wake too: otherwise a retry can never make room.
    // Count bounded service opportunities rather than retaining response
    // copies. One-poll-per-update guests can drain a coalesced queue in order.
    backgroundServiceTicks = accepted
      ? Math.min(backgroundServiceTicks + 1, MAX_BACKGROUND_SERVICE_TICKS)
      : MAX_BACKGROUND_SERVICE_TICKS;
    backgroundContinuationTicks = MAX_BACKGROUND_CONTINUATION_TICKS;
    if (backgrounded || demandDriven) {
      scheduleTick(0);
    }
  }

  function pauseInput() {
    if (translated) {
      translated.pauseInput();
    } else {
      check(pvm.polkavm_browser_pause_input(), "discard paused PolkaVM browser input");
    }
    // Releases survive the pause boundary; presses and movement never do.
    // A conforming Host has already sent these, but also release controls if
    // focus disappeared before the Host received their physical key-up.
    for (const bytes of heldInputs.values()) {
      bytes[0] = bytes[0] === 18 ? 21 : bytes[0] + 1;
      sendInput(bytes);
    }
    heldInputs.clear();
    pendingMotionSample = null;
  }

  function setActivity(type, next, seq) {
    if (typeof next !== "boolean") {
      throw new Error(`invalid PolkaVM browser ${type} state`);
    }
    if (type === "background" && seq !== undefined &&
        (!Number.isSafeInteger(seq) || seq < 0)) {
      throw new Error("invalid PolkaVM browser background sequence");
    }
    const wasInactive = paused || backgrounded;
    const changed = (type === "pause" ? paused : backgrounded) !== next;
    if (type === "pause") {
      paused = next;
    } else {
      backgrounded = next;
    }
    const inactive = paused || backgrounded;
    if (changed) {
      clearTimeout(timer);
      timer = undefined;
      if (inactive && !wasInactive) {
        pendingMotionSample = null;
        if (running) {
          inactiveAt = performance.now();
          pauseInput();
        }
      } else if (!inactive && wasInactive && running) {
        const now = performance.now();
        startedAt += now - inactiveAt;
        legacyNextUpdateAt = now;
      }
    }
    postMessage(type === "pause"
      ? { type: "pause-state", paused }
      : { type: "background-state", backgrounded, ...(seq === undefined ? {} : { seq }) });
    if (changed && running && !paused) {
      if (backgrounded) {
        // Foreground updates need not poll. Recover actual queued work rather
        // than assuming an update consumed the response that woke it.
        backgroundServiceTicks = pendingHostFrameResponses();
        backgroundContinuationTicks = MAX_BACKGROUND_CONTINUATION_TICKS;
      }
      if (!backgrounded && pendingFrame !== null) {
        const { output, transfers } = pendingFrame;
        pendingFrame = null;
        postRuntimeOutput(output, transfers);
      }
      scheduleTick(0);
    }
  }

  function requestedUpdateDelay(completedAt) {
    if (!demandDriven) {
      legacyNextUpdateAt = Math.max(
        legacyNextUpdateAt + LEGACY_FRAME_INTERVAL_MS,
        completedAt,
      );
      return legacyNextUpdateAt - completedAt;
    }
    const delay = translated
      ? translated.updateAfterMilliseconds()
      : pvm.polkavm_browser_update_after_ms() >>> 0;
    return delay === UPDATE_AFTER_IDLE ? null : delay;
  }

  function tick() {
    if (!running || paused || (backgrounded && !hasBackgroundWork())) {
      return;
    }
    const firstUpdate = updateCount === 0;
    if (firstUpdate) {
      postMessage({ type: "startup", stage: "first-update-started" });
    }
    const before = performance.now();
    try {
      if (translated) {
        translated.update((backgrounded ? inactiveAt : before) - startedAt);
      } else {
        check(
          pvm.polkavm_browser_update((backgrounded ? inactiveAt : before) - startedAt),
          "update PolkaVM browser guest",
        );
        drainFrame();
        drainTri2d();
        drainUiSemantics();
        drainUiOutput();
        drainGpuBatches();
        drainHostFrameRequests();
        drainFileRegistrations();
        drainMediatedInputCommands();
        drainAudio();
        drainSave();
        drainLogs();
      }
      drainPointerCapture();
    } catch (error) {
      void terminate(error);
      return;
    }
    const completedAt = performance.now();
    const elapsed = completedAt - before;
    if (firstUpdate) {
      postMessage({ type: "startup", stage: "first-update-completed" });
    }
    updateCount++;
    updateSamples.push(elapsed);
    if (updateSamples.length > 600) {
      updateSamples.shift();
    }
    if (updateCount % 120 === 0) {
      const sorted = [...updateSamples].sort((a, b) => a - b);
      const percentile = (value) =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))];
      postMessage({
        type: "metrics",
        updates: updateCount,
        updateP50Ms: percentile(0.5),
        updateP95Ms: percentile(0.95),
        updateMaxMs: sorted[sorted.length - 1],
      });
    }
    if (translated?.hasPendingContinuation()) {
      backgroundContinuationTicks = Math.max(0, backgroundContinuationTicks - 1);
    } else {
      backgroundServiceTicks = Math.max(0, backgroundServiceTicks - 1);
    }
    if (backgrounded) {
      if (hasBackgroundWork()) {
        scheduleTick(0);
      }
      return;
    }
    const requestedDelay = requestedUpdateDelay(completedAt);
    if (requestedDelay !== null) {
      scheduleTick(requestedDelay);
    }
  }

  function asBytes(value, label) {
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new Error(`${label} must be binary data`);
  }

  function validateAssetPath(path) {
    const encoded = encoder.encode(path);
    if (
      !path ||
      encoded.byteLength > MAX_ASSET_NAME_BYTES ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path
        .split("/")
        .some(
          (component) => !component || component === "." || component === "..",
        )
    ) {
      throw new Error(`invalid PolkaVM browser asset path ${path}`);
    }
  }

  function isWebGpuProfile(profile) {
    return profile === "webgpu-raster" || profile === "webgpu";
  }

  function validateStartMessage(message) {
    if (
      !(message.runtime instanceof WebAssembly.Module) &&
      asBytes(message.runtime, "PolkaVM browser runtime").byteLength === 0
    ) {
      throw new Error("PolkaVM browser runtime is empty");
    }
    const program = asBytes(message.program, "PolkaVM browser program");
    if (!program.byteLength || program.byteLength > MAX_PROGRAM_BYTES) {
      throw new Error(
        `PolkaVM browser program must contain 1..=${MAX_PROGRAM_BYTES} bytes`,
      );
    }
    if (
      !["framebuffer", "tri2d", "webgpu-raster", "webgpu"].includes(
        message.graphicsProfile,
      )
    ) {
      throw new Error(
        `invalid PolkaVM browser graphics profile ${message.graphicsProfile}`,
      );
    }
    if (
      !Array.isArray(message.assets) ||
      message.assets.length > MAX_ASSET_FILES
    ) {
      throw new Error(
        `PolkaVM browser launch exceeds ${MAX_ASSET_FILES} assets`,
      );
    }
    const paths = new Set();
    let assetBytes = 0;
    for (const asset of message.assets) {
      if (!asset || typeof asset.path !== "string") {
        throw new Error("PolkaVM browser asset is missing its path");
      }
      validateAssetPath(asset.path);
      if (paths.has(asset.path)) {
        throw new Error(
          `PolkaVM browser asset path is duplicated: ${asset.path}`,
        );
      }
      paths.add(asset.path);
      const length = asBytes(
        asset.bytes,
        `PolkaVM browser asset ${asset.path}`,
      ).byteLength;
      if (length > MAX_ASSET_FILE_BYTES) {
        throw new Error(
          `PolkaVM browser asset ${asset.path} exceeds ${MAX_ASSET_FILE_BYTES} bytes`,
        );
      }
      assetBytes += length;
      if (!Number.isSafeInteger(assetBytes) || assetBytes > MAX_ASSET_BYTES) {
        throw new Error(
          `PolkaVM browser assets exceed ${MAX_ASSET_BYTES} bytes`,
        );
      }
    }
    if (
      isWebGpuProfile(message.graphicsProfile) &&
      !(message.gpuCapabilities instanceof ArrayBuffer)
    ) {
      throw new Error(
        "WebGPU capabilities are required before PolkaVM initialization",
      );
    }
    if (
      message.motionAvailability !== undefined &&
      (!Number.isInteger(message.motionAvailability) ||
        message.motionAvailability < 0 ||
        message.motionAvailability > 2)
    ) {
      throw new Error("invalid PolkaVM browser motion availability");
    }
    const mediatedInputKinds = message.mediatedInputKinds ?? [];
    if (
      !Array.isArray(mediatedInputKinds) ||
      mediatedInputKinds.length > MAX_MEDIATED_INPUT_REGISTRATIONS ||
      mediatedInputKinds.some(
        (kind) =>
          typeof kind !== "string" ||
          encoder.encode(kind).byteLength > MAX_MEDIATED_INPUT_KIND_BYTES ||
          !/^[a-z0-9][a-z0-9+._-]*[a-z0-9]$|^[a-z0-9]$/.test(kind),
      ) ||
      new Set(mediatedInputKinds).size !== mediatedInputKinds.length
    ) {
      throw new Error("invalid PolkaVM browser mediated-input kinds");
    }
    const fileInput = message.fileInput;
    if (
      fileInput !== undefined &&
      (typeof fileInput?.inline !== "boolean" ||
        typeof fileInput.relaunch !== "boolean" ||
        (fileInput.stream !== undefined && typeof fileInput.stream !== "boolean") ||
        typeof fileInput.entrypoint !== "string" ||
        ((fileInput.inline || fileInput.relaunch || fileInput.stream) && !fileInput.entrypoint))
    ) {
      throw new Error("invalid PolkaVM browser file-input support");
    }
    if (fileInput?.stream && typeof globalThis.FileReaderSync !== "function") {
      throw new Error("PolkaVM streamed files require a worker with FileReaderSync");
    }
    if (message.fileCache !== undefined && typeof message.fileCache !== "boolean") {
      throw new Error("invalid PolkaVM browser file-cache support");
    }
    if (message.fileCache === true) {
      if (!fileInput?.stream) {
        throw new Error("PolkaVM private file caches require streamed file input");
      }
      if (options.createFileCache === undefined &&
          (typeof globalThis.navigator?.storage?.getDirectory !== "function" ||
           typeof globalThis.FileSystemFileHandle?.prototype?.createSyncAccessHandle !== "function")) {
        throw new Error("PolkaVM private file caches require worker OPFS or a trusted cache factory");
      }
    }
    const relaunch = message.fileRelaunch;
    if (relaunch !== undefined) {
      if (
        ["id", "mountPath", "name", "mimeType"].some(
          (field) => typeof relaunch?.[field] !== "string",
        )
      ) {
        throw new Error("invalid PolkaVM browser relaunch file");
      }
      validateAssetPath(relaunch.mountPath);
      const length = asBytes(
        relaunch.bytes,
        "PolkaVM browser relaunch file",
      ).byteLength;
      const replaced = message.assets.find(
        (asset) => asset.path === relaunch.mountPath,
      );
      assetBytes +=
        length - (replaced ? asBytes(replaced.bytes, "asset").byteLength : 0);
      if (
        !length ||
        length > MAX_RELAUNCH_FILE_BYTES ||
        paths.size + (replaced ? 0 : 1) > MAX_ASSET_FILES ||
        assetBytes > MAX_ASSET_BYTES
      ) {
        throw new Error("PolkaVM browser relaunch file exceeds the asset bounds");
      }
    }
    return program;
  }

  function relaunchFile(message) {
    const relaunch = message.fileRelaunch;
    return relaunch === undefined
      ? null
      : {
          id: relaunch.id,
          mountPath: relaunch.mountPath,
          name: relaunch.name,
          mimeType: relaunch.mimeType,
          bytes: asBytes(relaunch.bytes, "PolkaVM browser relaunch file"),
        };
  }

  async function instantiateRuntime(runtime, imports) {
    const result = await WebAssembly.instantiate(runtime, imports);
    return (result instanceof WebAssembly.Instance ? result : result.instance).exports;
  }

  async function start(message) {
    if (disposed) {
      throw new Error("PolkaVM browser worker is stopped");
    }
    if (starting || pvm || running) {
      throw new Error("PolkaVM browser worker is already started");
    }
    const program = validateStartMessage(message);
    fileCacheEnabled = message.fileCache === true;
    starting = true;
    motionAvailability = message.motionAvailability ?? 0;
    pointerCaptureSupported = message.pointerCaptureSupported === true;
    pendingGpuCapabilities =
      message.gpuCapabilities instanceof ArrayBuffer
        ? new Uint8Array(message.gpuCapabilities).slice()
        : null;
    const bootStarted = performance.now();
    let translationMs = 0;
    let compilationMs = 0;
    let translatedWasmBytes = 0;
    let cacheHit = false;
    let compilerStage = "compiler-staging-program";
    let compilerFallbackReason;
    let compilerFallbackStage;
    postMessage({ type: "startup", stage: "runtime-instantiating" });
    const runtimeImports = {
      polkavm_browser: {
        clock_wall_ms: () => Date.now(),
        file_read: (token, offset, pointer, length) => {
          const source = streamFiles.get(token >>> 0)?.source;
          if (disposed || pvm == null || source == null || (length >>> 0) > MAX_FILE_READ_BYTES) {
            return -4;
          }
          try {
            const destination = new Uint8Array(
              pvm.memory.buffer,
              pointer >>> 0,
              length >>> 0,
            );
            destination.set(source.read(offset >>> 0, length >>> 0));
            return length >>> 0;
          } catch {
            return -4;
          }
        },
        file_close: (token) => {
          streamFiles.get(token >>> 0)?.source?.close();
        },
        file_cache_reset: (token, size) => {
          try {
            const cache = streamFiles.get(token >>> 0)?.cache;
            if (!cache) return -4;
            cache.reset(size >>> 0);
            return 0;
          } catch {
            return -4;
          }
        },
        file_cache_write: (token, offset, pointer, length) => {
          try {
            const cache = streamFiles.get(token >>> 0)?.cache;
            if (!cache || (length >>> 0) > MAX_FILE_READ_BYTES) return -4;
            const bytes = new Uint8Array(pvm.memory.buffer, pointer >>> 0, length >>> 0);
            return cache.write(offset >>> 0, bytes);
          } catch {
            return -4;
          }
        },
        file_cache_read: (token, offset, pointer, length) => {
          try {
            const cache = streamFiles.get(token >>> 0)?.cache;
            if (!cache || (length >>> 0) > MAX_FILE_READ_BYTES) return -4;
            const bytes = new Uint8Array(pvm.memory.buffer, pointer >>> 0, length >>> 0);
            bytes.set(cache.read(offset >>> 0, length >>> 0));
            return length >>> 0;
          } catch {
            return -4;
          }
        },
        file_cache_flush: (token) => {
          try {
            const cache = streamFiles.get(token >>> 0)?.cache;
            if (!cache) return -4;
            cache.flush();
            return 0;
          } catch {
            return -4;
          }
        },
        file_cache_close: (token) => {
          streamFiles.get(token >>> 0)?.cache?.close();
        },
        random_fill: (pointer, length) => {
          if (pvm == null) {
            return CORE_STATUS_DENIED;
          }
          try {
            const browserCrypto = globalThis.crypto;
            if (typeof browserCrypto?.getRandomValues !== "function") {
              return CORE_STATUS_DENIED;
            }
            const bytes = new Uint8Array(length >>> 0);
            browserCrypto.getRandomValues(bytes);
            new Uint8Array(
              pvm.memory.buffer,
              pointer >>> 0,
              length >>> 0,
            ).set(bytes);
            return 0;
          } catch {
            return CORE_STATUS_DENIED;
          }
        },
      },
    };
    pvm = await instantiateRuntime(message.runtime, runtimeImports);
    if (disposed) {
      pvm.polkavm_browser_reset?.();
      return;
    }
    if (pvm.polkavm_browser_abi_version() !== 2) {
      throw new Error("PolkaVM browser runtime has an incompatible ABI");
    }
    postMessage({ type: "startup", stage: "runtime-instantiated" });
    const pendingOutputs = [];
    try {
      if (message.forceInterpreter === true) {
        throw FORCE_INTERPRETER;
      }
      stage(program);
      let compiledProgram = message.compiledProgram;
      let bytes =
        message.compiledBytes instanceof ArrayBuffer
          ? new Uint8Array(message.compiledBytes)
          : null;
      const hasCompiledProgram =
        globalThis.TranslatedPolkaVmRuntime.isCompiledProgram(compiledProgram);
      cacheHit = hasCompiledProgram || bytes !== null;
      if (!hasCompiledProgram) {
        let generatedTranslation = bytes === null;
        if (bytes === null) {
          compilerStage = "compiler-translating";
          const translationStarted = performance.now();
          check(
            pvm.polkavm_browser_translate_staged(),
            "translate PolkaVM browser guest",
          );
          translationMs = performance.now() - translationStarted;
          const pointer = pvm.polkavm_browser_translation_pointer();
          const length = pvm.polkavm_browser_translation_length();
          bytes = new Uint8Array(pvm.memory.buffer, pointer, length).slice();
        }
        translatedWasmBytes = bytes.byteLength;
        // Translation can grow its linear memory far beyond the guest heap.
        // The compiled backend does not use that instance; release it before
        // the browser allocates native code for the root and its code parts.
        pvm = null;
        compilerStage = "compiler-compiling";
        const compilationStarted = performance.now();
        try {
          compiledProgram =
            await globalThis.TranslatedPolkaVmRuntime.compile(bytes);
          compilationMs = performance.now() - compilationStarted;
          if (disposed) {
            return;
          }
        } catch (error) {
          compilationMs = performance.now() - compilationStarted;
          if (disposed) {
            return;
          }
          // Invalid Wasm cannot be repaired by changing compilation-unit sizes.
          if (error instanceof WebAssembly.CompileError) {
            throw error;
          }
          console.warn(
            `PolkaVM single-module compilation failed; compiling bounded code parts: ${error instanceof Error ? error.message : String(error)}`,
          );
          compilerStage = "compiler-translating-parts";
          pvm = await instantiateRuntime(message.runtime, runtimeImports);
          if (disposed) {
            pvm.polkavm_browser_reset?.();
            return;
          }
          stage(program);
          const translationStarted = performance.now();
          check(
            pvm.polkavm_browser_translate_partitioned_staged(),
            "translate bounded PolkaVM browser code parts",
          );
          translationMs += performance.now() - translationStarted;
          bytes = new Uint8Array(
            pvm.memory.buffer,
            pvm.polkavm_browser_translation_pointer(),
            pvm.polkavm_browser_translation_length(),
          ).slice();
          generatedTranslation = true;
          translatedWasmBytes = bytes.byteLength;
          pvm = null;
          compilerStage = "compiler-compiling-parts";
          const partsStarted = performance.now();
          try {
            compiledProgram =
              await globalThis.TranslatedPolkaVmRuntime.compile(bytes);
          } finally {
            compilationMs += performance.now() - partsStarted;
          }
        }
        if (disposed) {
          return;
        }
        if (generatedTranslation) {
          const persistent = bytes.slice();
          postMessage(
            { type: "translated", cacheKey: message.cacheKey, bytes: persistent },
            [persistent.buffer],
          );
        }
        try {
          postMessage({
            type: "compiled",
            cacheKey: message.cacheKey,
            program: compiledProgram,
          });
        } catch {}
      }
      pvm = null;
      compilerStage = "compiler-instantiating";
      translated = new globalThis.TranslatedPolkaVmRuntime(
        compiledProgram,
        message.assets,
        (output, transfers = []) => {
          if (running) {
            postRuntimeOutput(output, transfers);
          } else {
            pendingOutputs.push({ output, transfers });
            if (output?.type === "file-registrations") {
              unpostedFileRegistrations = output;
            }
          }
        },
        MAX_TRANSLATED_LOOPS_PER_UPDATE,
        message.audioEnabled,
        message.graphicsProfile,
        pendingGpuCapabilities,
        motionAvailability,
        message.mediatedInputKinds ?? [],
        message.fileInput ?? null,
      );
      const relaunch = relaunchFile(message);
      if (relaunch !== null) {
        translated.setFileRelaunch(relaunch);
      }
      compilerStage = "compiler-initializing";
      if (pendingMotionSample !== null) {
        translated.sendMotionSample(pendingMotionSample);
      }
      translated.setPointerCaptureSupported(pointerCaptureSupported);
      translated.initialize(MAX_GAS_PER_UPDATE);
      pendingGpuCapabilities = null;
      pendingMotionSample = null;
      backend = "compiler";
    } catch (error) {
      translated = null;
      if (disposed) {
        return;
      }
      pendingOutputs.length = 0;
      unpostedFileRegistrations = null;
      if (error !== FORCE_INTERPRETER) {
        compilerFallbackReason =
          error instanceof Error ? error.message : String(error);
        compilerFallbackStage = compilerStage;
        console.warn(
          `PolkaVM ${compilerFallbackStage} failed; using interpreter: ${compilerFallbackReason}`,
        );
      }
      if (pvm === null) {
        pvm = await instantiateRuntime(message.runtime, runtimeImports);
        if (disposed) {
          pvm.polkavm_browser_reset?.();
          return;
        }
      }
      let presentation = 0;
      if (message.graphicsProfile === "tri2d") {
        presentation = 1;
      } else if (message.graphicsProfile === "webgpu-raster") {
        presentation = 2;
      } else if (message.graphicsProfile === "webgpu") {
        presentation = 3;
      }
      const begin = pvm.polkavm_browser_launch_begin_v2;
      if (typeof begin !== "function") {
        throw new Error(
          "PolkaVM interpreter does not support graphics profiles",
        );
      }
      postMessage({ type: "startup", stage: "interpreter-staging-program" });
      stage(program);
      postMessage({ type: "startup", stage: "interpreter-program-staged" });
      postMessage({ type: "startup", stage: "interpreter-launch-begin" });
      check(
        begin(
          BigInt(MAX_GAS_PER_UPDATE),
          message.audioEnabled ? 1 : 0,
          presentation,
        ),
        "begin PolkaVM browser launch",
      );
      postMessage({ type: "startup", stage: "interpreter-launch-begun" });
      postMessage({ type: "startup", stage: "interpreter-mounting-assets" });
      for (const asset of message.assets) {
        addAsset(asset);
      }
      postMessage({ type: "startup", stage: "interpreter-assets-mounted" });
      postMessage({ type: "startup", stage: "interpreter-launch-starting" });
      check(pvm.polkavm_browser_launch_start(), "start PolkaVM browser launch");
      postMessage({ type: "startup", stage: "interpreter-launch-started" });
      const setRandomBytes = pvm.polkavm_browser_set_random_bytes;
      if (typeof setRandomBytes !== "function") {
        throw new Error("PolkaVM interpreter does not support secure random");
      }
      const randomBytes = executionRandomBytes();
      if (randomBytes.byteLength > 0) {
        stage(randomBytes);
        check(setRandomBytes(), "set PolkaVM browser random bytes");
      }
      check(
        pvm.polkavm_browser_set_motion_availability(motionAvailability),
        "set PolkaVM browser motion availability",
      );
      check(
        pvm.polkavm_browser_set_pointer_capture_supported(
          pointerCaptureSupported ? 1 : 0,
        ),
        "set PolkaVM browser pointer capture support",
      );
      if ((message.mediatedInputKinds?.length ?? 0) > 0) {
        stage(encoder.encode(message.mediatedInputKinds.join("\0")));
        check(
          pvm.polkavm_browser_set_mediated_input_kinds(),
          "set PolkaVM browser mediated-input kinds",
        );
      }
      if (message.fileInput?.inline || message.fileInput?.relaunch || message.fileInput?.stream) {
        stage(encoder.encode(message.fileInput.entrypoint));
        check(
          pvm.polkavm_browser_set_file_input_support(
            message.fileInput.inline ? 1 : 0,
            message.fileInput.relaunch ? 1 : 0,
            message.fileInput.stream ? 1 : 0,
          ),
          "set PolkaVM browser file-input support",
        );
      }
      const relaunch = relaunchFile(message);
      if (relaunch !== null) {
        const { bytes, ...metadata } = relaunch;
        stage(encoder.encode(JSON.stringify(metadata)));
        check(
          pvm.polkavm_browser_stage_file_metadata(),
          "stage PolkaVM browser relaunch file",
        );
        stage(bytes);
        check(
          pvm.polkavm_browser_set_file_relaunch(),
          "mount PolkaVM browser relaunch file",
        );
      }
      if (pendingMotionSample !== null) {
        stage(pendingMotionSample);
        check(
          pvm.polkavm_browser_send_motion_sample(),
          "send PolkaVM browser motion sample",
        );
        pendingMotionSample = null;
      }
      if (isWebGpuProfile(message.graphicsProfile)) {
        if (pendingGpuCapabilities === null) {
          throw new Error(
            "WebGPU capabilities are required before PolkaVM initialization",
          );
        }
        stage(pendingGpuCapabilities);
        check(
          pvm.polkavm_browser_set_gpu_capabilities(),
          "set PolkaVM browser GPU capabilities",
        );
        pendingGpuCapabilities = null;
      }
      postMessage({ type: "startup", stage: "interpreter-initializing" });
      try {
        check(pvm.polkavm_browser_init(), "initialize PolkaVM browser guest");
      } catch (initError) {
        drainLogs();
        drainFileRegistrations();
        throw initError;
      }
      drainFileRegistrations();
      drainMediatedInputCommands();
      postMessage({ type: "startup", stage: "interpreter-initialized" });
      drainTri2d();
      drainUiOutput();
      drainGpuBatches();
      drainHostFrameRequests();
      drainLogs();
    }
    if (disposed) {
      trackCleanup(translated?.stop());
      pvm?.polkavm_browser_reset?.();
      return;
    }
    const usesMotion = translated
      ? translated.usesMotion()
      : pvm.polkavm_browser_uses_motion() === 1;
    const usesPointerCapture = translated
      ? translated.usesPointerCapture()
      : pvm.polkavm_browser_uses_pointer_capture() === 1;
    demandDriven = translated
      ? translated.usesUpdateScheduling()
      : typeof pvm.polkavm_browser_uses_update_scheduling === "function" &&
        pvm.polkavm_browser_uses_update_scheduling() === 1;
    startedAt = performance.now();
    legacyNextUpdateAt = startedAt;
    starting = false;
    if (paused || backgrounded) {
      inactiveAt = startedAt;
      pauseInput();
    }
    running = true;
    postMessage({
      type: "ready",
      backend,
      compilerFallbackReason,
      compilerFallbackStage,
      usesMotion,
      usesPointerCapture,
      usesUpdateScheduling: demandDriven,
      cacheHit,
      translationMs,
      compilationMs,
      translatedWasmBytes,
      startupMs: performance.now() - bootStarted,
    });
    for (const { output, transfers } of pendingOutputs) {
      postRuntimeOutput(output, transfers);
    }
    scheduleTick(0);
  }

  function sendInput(bytes) {
    if (bytes.byteLength !== 8) {
      return;
    }
    if (
      bytes[0] === INPUT_SAFE_AREA_INSETS ||
      bytes[0] === INPUT_KEYBOARD_INSETS
    ) {
      throw new Error(
        "viewport insets must be sent with the view-insets message",
      );
    }
    if (!running) {
      return;
    }
    const type = bytes[0];
    if ((paused || backgrounded) && !(type === 2 || type === 4 || type === 7 || type === 12 ||
        type === 20 || type === 21 || ((type === 13 || type === 15) && bytes[1] === 0))) {
      return;
    }
    if (type === 1 || type === 3 || type === 18) {
      const key = type * 256 + bytes[1];
      if (!heldInputs.has(key)) {
        heldInputs.set(key, bytes.slice());
      }
    } else if (type === 2 || type === 4) {
      heldInputs.delete((type - 1) * 256 + bytes[1]);
    } else if (type === 20 || type === 21) {
      heldInputs.delete(18 * 256 + bytes[1]);
    }
    if (translated) {
      translated.sendInput(bytes);
      return;
    }
    if (bytes[0] <= 7) {
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      check(
        pvm.polkavm_browser_send_input(
          bytes[0],
          bytes[1],
          view.getUint16(2, true),
          view.getUint16(4, true),
        ),
        "send PolkaVM browser input",
      );
      return;
    }
    stage(bytes);
    check(
      pvm.polkavm_browser_send_input_record(),
      "send PolkaVM browser extended input",
    );
  }

  function sendViewInsets(eventType, left, top, right, bottom) {
    if (
      eventType !== INPUT_SAFE_AREA_INSETS &&
      eventType !== INPUT_KEYBOARD_INSETS
    ) {
      throw new Error("invalid PolkaVM browser inset event type");
    }
    for (const value of [left, top, right, bottom]) {
      if (!Number.isInteger(value) || value < 0 || value > MAX_INSET_PIXELS) {
        throw new Error("invalid PolkaVM browser inset value");
      }
    }
    if (!running) {
      return;
    }
    if (translated) {
      translated.sendViewInsets(eventType, left, top, right, bottom);
      return;
    }
    if (typeof pvm.polkavm_browser_send_view_insets !== "function") {
      throw new Error("PolkaVM browser runtime has an incompatible ABI");
    }
    check(
      pvm.polkavm_browser_send_view_insets(eventType, left, top, right, bottom),
      "send PolkaVM browser view insets",
    );
  }

  function setMotionAvailability(availability) {
    if (
      !Number.isInteger(availability) ||
      availability < 0 ||
      availability > 2
    ) {
      throw new Error("invalid PolkaVM browser motion availability");
    }
    motionAvailability = availability;
    if (availability !== 1) {
      pendingMotionSample = null;
    }
    if (!running) {
      return;
    }
    if (translated) {
      translated.setMotionAvailability(availability);
      return;
    }
    check(
      pvm.polkavm_browser_set_motion_availability(availability),
      "set PolkaVM browser motion availability",
    );
  }

  function setPointerCaptureSupported(supported) {
    pointerCaptureSupported = supported === true;
    if (!running) {
      return;
    }
    if (translated) {
      translated.setPointerCaptureSupported(pointerCaptureSupported);
      return;
    }
    check(
      pvm.polkavm_browser_set_pointer_capture_supported(
        pointerCaptureSupported ? 1 : 0,
      ),
      "set PolkaVM browser pointer capture support",
    );
  }

  function setPointerCaptureActive(active) {
    if (!running) {
      return;
    }
    if (translated) {
      translated.setPointerCaptureActive(active === true);
      return;
    }
    check(
      pvm.polkavm_browser_set_pointer_capture_active(active === true ? 1 : 0),
      "report PolkaVM browser pointer capture state",
    );
  }

  function sendMotionSample(bytes) {
    if (bytes.byteLength !== MOTION_SAMPLE_BYTES) {
      throw new Error("invalid PolkaVM browser motion sample");
    }
    if (paused || backgrounded) {
      return;
    }
    if (!running) {
      pendingMotionSample = bytes.slice();
      motionAvailability = 1;
      return;
    }
    if (translated) {
      translated.sendMotionSample(bytes);
      return;
    }
    stage(bytes);
    check(
      pvm.polkavm_browser_send_motion_sample(),
      "send PolkaVM browser motion sample",
    );
  }

  function sendGpuCapabilities(bytes) {
    if (bytes.byteLength < 56 || bytes.byteLength > 4096) {
      throw new Error("invalid PolkaVM browser GPU capabilities");
    }
    if (!running) {
      pendingGpuCapabilities = bytes.slice();
      return;
    }
    if (translated) {
      translated.setGpuCapabilities(bytes);
      return;
    }
    stage(bytes);
    check(
      pvm.polkavm_browser_set_gpu_capabilities(),
      "update PolkaVM browser GPU capabilities",
    );
  }

  function sendGpuEvent(bytes) {
    if (!running || !bytes.byteLength) {
      return;
    }
    if (translated) {
      translated.sendGpuEvent(bytes);
      return;
    }
    stage(bytes);
    check(
      pvm.polkavm_browser_send_gpu_event(),
      "send PolkaVM browser GPU event",
    );
  }

  function sendHostFrameResponse(bytes) {
    if (!running || !bytes.byteLength) {
      return true;
    }
    if (translated) {
      return translated.sendHostFrameResponse(bytes);
    }
    stage(bytes);
    const result = pvm.polkavm_browser_send_host_frame_response();
    if (result === 2) {
      return false;
    }
    check(result, "send PolkaVM browser host-frame response");
    return true;
  }

  function sendMediatedInputResult(handle, status, bytes) {
    if (
      !running ||
      (!translated && !pvm) ||
      !Number.isInteger(handle) ||
      handle <= 0 ||
      !Number.isInteger(status) ||
      status < 3 ||
      status > 6
    ) {
      throw new Error("invalid PolkaVM browser mediated-input result");
    }
    invalidateSelection(handle);
    activeMediatedInputRequest = null;
    if (translated) {
      translated.sendMediatedInputResult(handle, status, bytes);
      activeMediatedInputHandles.delete(handle);
      return;
    }
    stage(status === 3 ? bytes : new Uint8Array([0]));
    check(
      pvm.polkavm_browser_send_mediated_input_result(handle, status),
      "send PolkaVM browser mediated-input result",
    );
    activeMediatedInputHandles.delete(handle);
  }
  /**
   * Delivers a file the user selected in Host UI and reports the outcome. A
   * relaunch delivery stops this execution.
   */
  function sendFileInput(handle, name, mimeType, bytes, file, backendCache = null) {
    if (
      !running ||
      !Number.isInteger(handle) ||
      handle <= 0 ||
      typeof name !== "string" ||
      typeof mimeType !== "string"
    ) {
      throw new Error("invalid PolkaVM browser file input");
    }
    const stream = file !== undefined;
    if (stream && (!(file instanceof Blob) || bytes !== undefined)) {
      throw new Error("streamed PolkaVM browser file input requires only a Blob");
    }
    let delivery;
    const selected = stream ? createFileSource(file, backendCache) : null;
    try {
      if (translated) {
        delivery = stream
          ? translated.sendFileStream(
              handle, name, mimeType, file.size, selected.source, selected.cache,
            )
          : translated.deliverFile(handle, name, mimeType, bytes);
      } else {
        stage(encoder.encode(JSON.stringify({ name, mimeType })));
        check(
          pvm.polkavm_browser_stage_file_metadata(),
          "stage PolkaVM browser file input",
        );
        let code;
        if (stream) {
          const { token, source, cache } = selected;
          try {
            // The binding takes u32; oversized files must be rejected, not wrap.
            code = pvm.polkavm_browser_send_file_stream(
              handle,
              file.size > MAX_STREAM_FILE_BYTES ? 0 : file.size,
              token,
              cache === null ? 0 : 1,
            );
          } finally {
            if (code !== 0) {
              source.close();
              cache?.close();
            }
          }
        } else {
          if (bytes.byteLength) {
            stage(bytes);
          }
          code = pvm.polkavm_browser_send_file_input(handle);
        }
        const outcome = FILE_INPUT_OUTCOMES[code];
        if (!outcome || outcome === "error") {
          throw new Error(`send PolkaVM browser file input: ${errorText()}`);
        }
        delivery = { outcome };
        if (outcome === "relaunch") {
          delivery.relaunch = {
            ...wasmJson(
              pvm.polkavm_browser_file_relaunch_pointer(),
              pvm.polkavm_browser_file_relaunch_length(),
            ),
            bytes,
          };
        }
      }
    } catch (error) {
      selected?.source.close();
      selected?.cache?.close();
      throw error;
    }
    if (delivery.outcome !== "refused" && activeMediatedInputRequest === handle) {
      activeMediatedInputRequest = null;
    }
    if (stream && delivery.outcome === "ready") {
      activeMediatedInputHandles.add(handle);
    } else if (delivery.outcome !== "refused") {
      activeMediatedInputHandles.delete(handle);
    }
    if (delivery.outcome !== "relaunch") {
      postMessage({ type: "file-input-delivery", handle, outcome: delivery.outcome });
      return false;
    }
    const relaunch = { ...delivery.relaunch, bytes: delivery.relaunch.bytes.slice() };
    postMessage(
      { type: "file-input-delivery", handle, outcome: "relaunch", relaunch },
      [relaunch.bytes.buffer],
    );
    return true;
  }

  function receiveFileInput(message) {
    const { handle, name, mimeType, file } = message;
    const bytes = file === undefined
      ? asBytes(message.bytes, "PolkaVM browser file input")
      : message.bytes;
    if (!fileCacheEnabled || file === undefined) {
      if (sendFileInput(handle, name, mimeType, bytes, file)) {
        void terminate();
      } else {
        wake();
      }
      return;
    }
    if (!running || !Number.isInteger(handle) || handle <= 0 ||
        typeof name !== "string" || typeof mimeType !== "string" ||
        !(file instanceof Blob) || bytes !== undefined) {
      throw new Error("invalid PolkaVM browser cached file input");
    }
    // An invalidated open still occupies its slot until its real storage closes.
    // Do not let repeated picker completions build an unbounded async queue.
    if (pendingSelections.has(handle) ||
        pendingSelections.size + pendingCleanups.size >= MAX_MEDIATED_INPUT_REGISTRATIONS) {
      postMessage({ type: "file-input-delivery", handle, outcome: "refused" });
      return;
    }
    const pending = { valid: true, promise: null };
    pendingSelections.set(handle, pending);
    pending.promise = Promise.resolve().then(async () => {
      if (!pending.valid || disposed) return;
      let cache;
      try {
        cache = await createFileCache();
        if (["size", "reset", "write", "read", "flush", "close"]
              .some((method) => typeof cache?.[method] !== "function") ||
            cache.size() !== 0) {
          throw new Error("invalid PolkaVM private cache backend");
        }
      } catch (error) {
        if (typeof cache?.close === "function") await closeCache(cache);
        if (pending.valid && !disposed) {
          if (activeMediatedInputRequest === handle) {
            sendMediatedInputResult(handle, 6, new Uint8Array());
            wake();
          }
          postMessage({ type: "error", fatal: false, message: `PolkaVM private cache creation failed: ${error?.message ?? error}` });
          postMessage({ type: "file-input-delivery", handle, outcome: "error" });
        }
        return;
      }
      if (!pending.valid || disposed) {
        await closeCache(cache);
        return;
      }
      sendFileInput(handle, name, mimeType, undefined, file, cache);
      wake();
      await Promise.all([...pendingCleanups]);
    }).catch((error) => {
      void terminate(error);
    }).finally(() => {
      pendingSelections.delete(handle);
    });
  }

  endpoint.onmessage = (event) => {
    if (disposed) {
      return;
    }
    const message = event.data;
    if (message?.type === "start") {
      void start(message).catch((error) => {
        if (!disposed) {
          void terminate(error);
        }
      });
    } else if (message?.type === "pause" || message?.type === "background") {
      try {
        setActivity(
          message.type,
          message.type === "pause" ? message.paused : message.backgrounded,
          message.seq,
        );
      } catch (error) {
        void terminate(error);
      }
    } else if (message?.type === "input") {
      try {
        sendInput(new Uint8Array(message.bytes));
        wake();
      } catch (error) {
        void terminate(error);
      }
    } else if (message?.type === "view-insets") {
      try {
        sendViewInsets(
          message.eventType,
          message.left,
          message.top,
          message.right,
          message.bottom,
        );
        wake();
      } catch (error) {
        void terminate(error);
      }
    } else if (message?.type === "motion-status") {
      try {
        setMotionAvailability(message.availability);
        wake();
      } catch (error) {
        void terminate(error);
      }
    } else if (message?.type === "pointer-capture-support") {
      try {
        if (typeof message.supported !== "boolean") {
          throw new Error("invalid PolkaVM browser pointer capture support");
        }
        setPointerCaptureSupported(message.supported);
        wake();
      } catch (error) {
        void terminate(error);
      }
    } else if (message?.type === "pointer-capture-state") {
      try {
        if (typeof message.active !== "boolean") {
          throw new Error("invalid PolkaVM browser pointer capture state");
        }
        setPointerCaptureActive(message.active);
        wake();
      } catch (error) {
        void terminate(error);
      }
    } else if (message?.type === "motion") {
      try {
        sendMotionSample(new Uint8Array(message.bytes));
        wake();
      } catch (error) {
        void terminate(error);
      }
    } else if (message?.type === "gpu-capabilities") {
      try {
        sendGpuCapabilities(new Uint8Array(message.bytes));
        wake();
      } catch (error) {
        void terminate(error);
      }
    } else if (message?.type === "gpu-event") {
      try {
        sendGpuEvent(new Uint8Array(message.bytes));
        wake();
      } catch (error) {
        void terminate(error);
      }
    } else if (message?.type === "host-frame-response") {
      try {
        const seq = message.seq;
        if (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 0)) {
          throw new Error(
            "invalid PolkaVM browser host frame response sequence",
          );
        }
        const bytes = new Uint8Array(message.bytes);
        const accepted = sendHostFrameResponse(bytes);
        if (running && bytes.byteLength) {
          wakeHostResponse(accepted);
        }
        if (accepted) {
          if (seq !== undefined) {
            postMessage({ type: "host-frame-response-accepted", seq });
          }
        } else if (seq !== undefined) {
          postMessage({
            type: "host-frame-response-rejected",
            reason: "queue-full",
            seq,
          });
        } else {
          postMessage({
            type: "host-frame-response-rejected",
            reason: "queue-full",
          });
        }
      } catch (error) {
        void terminate(error);
      }
    } else if (message?.type === "mediated-input-result") {
      try {
        sendMediatedInputResult(
          message.handle,
          message.status,
          new Uint8Array(message.bytes),
        );
        wake();
      } catch (error) {
        void terminate(error);
      }
    } else if (message?.type === "file-input") {
      try {
        receiveFileInput(message);
      } catch (error) {
        void terminate(error);
      }
    } else if (message?.type === "stop") {
      void terminate();
    }
  };
};

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

globalThis.createPolkaVmRuntime(globalThis);
